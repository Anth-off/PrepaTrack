import AVFoundation
import AVFAudio
import Capacitor
import Photos

@objc(RecordingPlugin)
public final class RecordingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RecordingPlugin"
    public let jsName = "NativeRecording"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "test", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showMicrophoneModes", returnType: CAPPluginReturnPromise),
    ]

    private let videoPipeline = DualCameraVideoPipeline()
    private let audioEngine = AVAudioEngine()
    private let audioStateLock = NSLock()
    private let sessionQueue = DispatchQueue(label: "com.n0thytvoff.prepatrack.recording")
    private var startedAt: Date?
    private var activeSegment: NativeRecordingSegment?
    private var segmentDurationSeconds: TimeInterval = 1_800
    private var segmentTimer: DispatchWorkItem?
    private var rotationInProgress = false
    private var audioFile: AVAudioFile?
    private var audioCaptureFormat: AVAudioFormat?
    private var audioTapInstalled = false
    private var acceptsAudioBuffers = false
    private var audioWriteError: String?
    // Un démarrage n'est confirmé qu'après plusieurs buffers réellement
    // écrits. Cela empêche l'interface d'annoncer une capture alors que le
    // moteur audio tourne sans produire de fichier exploitable.
    private let minimumConfirmedAudioBuffers = 10
    private var audioReadySignal = DispatchSemaphore(value: 0)
    private var audioCaptureConfirmed = false
    private var audioBuffersWritten = 0
    private var audioFramesWritten: AVAudioFramePosition = 0
    private var audioCaptureStartedAt: Date?
    private var lastAudioBufferWrittenAt: Date?
    private var audioCaptureURL: URL?
    private var audioHealthTimer: DispatchSourceTimer?
    private let audioStallTimeoutSeconds: TimeInterval = 8
    private var microphoneModePreviewStop: DispatchWorkItem?
    private var stopCalls: [CAPPluginCall] = []
    // L'intention utilisateur reste active quand iOS coupe matériellement la
    // caméra au verrouillage. Elle permet une reprise dans un nouveau fichier.
    private var recordingRequested = false
    private var suspendedForInterruption = false
    private var audioInterruptionActive = false
    private var applicationIsActive = true
    private var resumeRetryAttempt = 0
    private var resumeRetryWorkItem: DispatchWorkItem?
    private var finalizingSegmentIDs = Set<UUID>()
    private var recoveryInProgress = false
    private var recoveryRequested = false
    private var queuedRecoveryAllowsAmbiguousRetry = false
    private var queuedRecoveryAllowsRemux = false
    private var queuedRecoveryCompletion: ((RecordingRecoverySummary) -> Void)?
    private var backgroundFinalizationTask = UIBackgroundTaskIdentifier.invalid
    private var terminalStopPending = false
    private var terminalHadSegments = false
    private var terminalAllSaved = true
    private var terminalRetained = false
    private var terminalError: String?
    private var terminalStartedAt: Date?
    // Les exports lisent et écrivent beaucoup de données. Une file série évite
    // de concurrencer les deux encodeurs MultiCam de la tranche suivante.
    private var pendingDualPreparationJobs: [() -> Void] = []
    private var dualPreparationInProgress = false
    // Deux vidéos 720p/30, leurs exports audio+vidéo et la copie PhotoKit
    // peuvent coexister brièvement. Cette réserve évite une corruption ENOSPC.
    private let minimumFreeBytesForNewSegment: Int64 = 5_000_000_000

    public override func load() {
        videoPipeline.onDurationLimitReached = { [weak self] segmentID in
            self?.sessionQueue.async { self?.rotateActiveSegment(expectedID: segmentID) }
        }
        videoPipeline.onRenderingFailed = { [weak self] error in
            self?.sessionQueue.async {
                guard let self,
                      self.recordingRequested,
                      !self.suspendedForInterruption,
                      self.activeSegment != nil else { return }
                // Une panne durable du rendu ne doit jamais laisser tourner
                // l'audio en donnant l'impression que les deux vidéos sont
                // encore capturées. Fermer le segment, conserver ses sources,
                // puis repartir dans un nouveau fichier avec un backoff.
                self.suspendedForInterruption = true
                self.finishActiveSegment(
                    terminal: false,
                    interrupted: true,
                    forcedError: error.localizedDescription
                )
                self.scheduleResumeRetry()
            }
        }
        videoPipeline.onSessionInterrupted = { [weak self] in
            self?.sessionQueue.async {
                guard let self, self.recordingRequested else { return }
                self.suspendedForInterruption = true
                self.finishActiveSegment(terminal: false, interrupted: true)
            }
        }
        videoPipeline.onSessionInterruptionEnded = { [weak self] in
            self?.sessionQueue.async { self?.resumeRecordingIfNeeded() }
        }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(audioSessionInterrupted),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
        // Différer la récupération sur la file native : les écouteurs JavaScript
        // ont ainsi le temps de s'installer et les résultats ne sont plus perdus
        // pendant le chargement du pont Capacitor.
        sessionQueue.asyncAfter(deadline: .now() + 1) {
            self.recoverPendingRecordings()
        }
    }

    private var recordingsDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = base
            .appendingPathComponent("PrepaTrack", isDirectory: true)
            .appendingPathComponent("Recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = directory
        try? mutable.setResourceValues(values)
        return directory
    }

    private func pendingRecordingCount() -> Int {
        makeRecoverySnapshot().pending
    }

    /**
     * Le journal empêche une seconde insertion dans Photos après un crash.
     * Il ne doit donc disparaître qu'une fois toutes les sources réellement
     * supprimées du conteneur privé de l'application.
     */
    @discardableResult
    private func removeImportedMedia(
        _ mediaURLs: [URL],
        journals journalURLs: [URL] = []
    ) -> Bool {
        let manager = FileManager.default
        let media = Set(mediaURLs)
        for url in media where manager.fileExists(atPath: url.path) {
            try? manager.removeItem(at: url)
        }
        let mediaRemoved = !media.contains(where: { manager.fileExists(atPath: $0.path) })
        if mediaRemoved {
            for journal in Set(journalURLs) where manager.fileExists(atPath: journal.path) {
                try? manager.removeItem(at: journal)
            }
        }
        return mediaRemoved
    }

    private func beginBackgroundFinalizationTaskIfNeeded() {
        guard backgroundFinalizationTask == .invalid else { return }
        var identifier = UIBackgroundTaskIdentifier.invalid
        DispatchQueue.main.sync {
            identifier = UIApplication.shared.beginBackgroundTask(
                withName: "PrepaTrack vidéo"
            ) { [weak self] in
                self?.sessionQueue.async {
                    self?.endBackgroundFinalizationTask(force: true)
                }
            }
        }
        backgroundFinalizationTask = identifier
    }

    private func endBackgroundFinalizationTask(force: Bool = false) {
        guard backgroundFinalizationTask != .invalid else { return }
        guard force || (finalizingSegmentIDs.isEmpty && !recoveryInProgress) else { return }
        let identifier = backgroundFinalizationTask
        backgroundFinalizationTask = .invalid
        DispatchQueue.main.async {
            UIApplication.shared.endBackgroundTask(identifier)
        }
    }

    @objc private func applicationWillResignActive() {
        sessionQueue.async {
            if self.recordingRequested
                || !self.finalizingSegmentIDs.isEmpty
                || self.recoveryInProgress {
                self.beginBackgroundFinalizationTaskIfNeeded()
            }
        }
    }

    @objc private func applicationDidEnterBackground() {
        sessionQueue.async {
            self.applicationIsActive = false
            self.cancelResumeRetry()
            guard self.recordingRequested else { return }
            self.suspendedForInterruption = true
            self.finishActiveSegment(terminal: false, interrupted: true)
            if self.activeSegment == nil && self.finalizingSegmentIDs.isEmpty {
                self.endBackgroundFinalizationTask(force: true)
            }
        }
    }

    @objc private func applicationDidBecomeActive() {
        sessionQueue.async {
            self.applicationIsActive = true
            self.endBackgroundFinalizationTask(force: true)
            // Certaines suspensions iOS ne livrent pas le callback `.ended`.
            // Une nouvelle activation confirme que l'app peut retenter la route.
            self.audioInterruptionActive = false
            self.cancelResumeRetry()
            self.resumeRecordingIfNeeded()
            if !self.recordingRequested,
               self.activeSegment == nil,
               self.finalizingSegmentIDs.isEmpty {
                self.recoverPendingRecordings()
            }
        }
    }

    @objc private func audioSessionInterrupted(_ notification: Notification) {
        guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
        sessionQueue.async {
            self.audioInterruptionActive = type == .began
            if type == .began {
                self.cancelResumeRetry()
                self.interruptActiveRecordingIfNeeded()
            } else {
                self.resumeRecordingIfNeeded()
            }
        }
    }

    /** Coupe le fichier complet plutôt que de laisser une vidéo continuer sans piste audio. */
    private func interruptActiveRecordingIfNeeded() {
        guard recordingRequested,
              !suspendedForInterruption,
              activeSegment != nil else { return }
        suspendedForInterruption = true
        finishActiveSegment(terminal: false, interrupted: true)
    }

    @objc func start(_ call: CAPPluginCall) {
        requestPermissions { [weak self] granted in
            guard let self else { return }
            guard granted else {
                call.reject("Autorise la caméra et le microphone dans Réglages iOS.")
                return
            }
            self.sessionQueue.async {
                do {
                    guard !self.recoveryInProgress else {
                        throw RecordingError.recoveryInProgress
                    }
                    if self.recordingRequested, self.activeSegment != nil {
                        self.recordingRequested = true
                        self.suspendedForInterruption = false
                        DispatchQueue.main.async {
                            call.resolve([
                                "startedAt": (self.startedAt ?? Date()).timeIntervalSince1970 * 1_000,
                                "captureProfile": self.captureProfilePayload(),
                            ])
                        }
                        return
                    }
                    let requestedDuration = call.getInt("maxDurationSeconds") ?? 1_800
                    self.segmentDurationSeconds = TimeInterval(min(max(requestedDuration, 1), 1_800))
                    self.cancelResumeRetry()
                    self.resumeRetryAttempt = 0
                    self.recordingRequested = true
                    self.suspendedForInterruption = false
                    let startedAt = try self.startCapture()
                    DispatchQueue.main.async {
                        UIApplication.shared.isIdleTimerDisabled = true
                        call.resolve([
                            "startedAt": startedAt.timeIntervalSince1970 * 1_000,
                            "captureProfile": self.captureProfilePayload(),
                        ])
                    }
                } catch {
                    self.recordingRequested = false
                    DispatchQueue.main.async { call.reject(error.localizedDescription) }
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        sessionQueue.async {
            self.recordingRequested = false
            self.suspendedForInterruption = false
            self.cancelSegmentTimer()
            self.cancelResumeRetry()
            guard self.activeSegment != nil || !self.finalizingSegmentIDs.isEmpty else {
                DispatchQueue.main.async { call.resolve(["saved": false]) }
                return
            }
            self.stopCalls.append(call)
            self.beginTerminalStop(startedAt: self.activeSegment?.startedAt)
            if self.activeSegment != nil {
                self.finishActiveSegment(terminal: true, interrupted: false)
            } else {
                self.completeTerminalStopIfReady()
            }
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        sessionQueue.async {
            var result: [String: Any] = [
                "recording": self.recordingRequested,
                "capturing": self.activeSegment != nil,
                "suspended": self.suspendedForInterruption,
            ]
            if let startedAt = self.startedAt {
                result["startedAt"] = startedAt.timeIntervalSince1970 * 1_000
            }
            if !self.videoPipeline.profilePayload().isEmpty {
                result["captureProfile"] = self.captureProfilePayload()
            }
            DispatchQueue.main.async { call.resolve(result) }
        }
    }

    /**
     * Relance explicitement l'import des sources durables. L'accès en lecture
     * à Photos sert uniquement à confirmer un couple dont l'import précédent
     * a été interrompu entre la transaction PhotoKit et son accusé de réception.
     */
    @objc func recover(_ call: CAPPluginCall) {
        sessionQueue.async {
            guard !self.recordingRequested,
                  self.activeSegment == nil,
                  self.finalizingSegmentIDs.isEmpty else {
                DispatchQueue.main.async {
                    call.reject("Arrête d’abord l’enregistrement avant de récupérer les vidéos locales.")
                }
                return
            }
            let pending = self.pendingRecordingCount()
            guard pending > 0 else {
                DispatchQueue.main.async {
                    call.resolve([
                        "pending": 0,
                        "recovered": 0,
                        "retained": 0,
                        "started": false,
                    ])
                }
                return
            }

            let launchRecovery: (PHAuthorizationStatus) -> Void = { status in
                self.sessionQueue.async {
                    self.recoverPendingRecordings(
                        allowAmbiguousRetry: true,
                        allowRemux: true
                    ) { summary in
                        var result: [String: Any] = [
                            "pending": summary.pending,
                            "recovered": summary.recovered,
                            "retained": summary.retained,
                            "fullPhotoAccess": status == .authorized,
                        ]
                        if let error = summary.error { result["error"] = error }
                        call.resolve(result)
                    }
                }
            }
            let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            if status == .notDetermined {
                DispatchQueue.main.async {
                    PHPhotoLibrary.requestAuthorization(for: .readWrite, handler: launchRecovery)
                }
            } else {
                launchRecovery(status)
            }
        }
    }

    /**
     * Ouvre le panneau iOS officiel. Apple réserve le choix du mode micro à
     * l'utilisateur : l'application peut rendre les modes compatibles et
     * présenter ce panneau, mais ne peut pas imposer « Large spectre ».
     */
    @objc func showMicrophoneModes(_ call: CAPPluginCall) {
        sessionQueue.async {
            do {
                // Le panneau ne rend pas un mode compatible à lui seul. Lorsque
                // aucune capture n'est active, garder Voice Processing I/O actif
                // quelques secondes permet à iOS de proposer réellement les
                // trois modes sur le micro intégré.
                if !self.audioEngine.isRunning {
                    try self.startMicrophoneModePreview()
                }
            } catch {
                DispatchQueue.main.async { call.reject(error.localizedDescription) }
                return
            }
            DispatchQueue.main.async {
                AVCaptureDevice.showSystemUserInterface(.microphoneModes)
                call.resolve()
            }
        }
    }

    @objc func test(_ call: CAPPluginCall) {
        requestPermissions { [weak self] granted in
            guard let self else { return }
            guard granted else {
                call.reject("Permissions caméra ou microphone refusées.")
                return
            }
            self.sessionQueue.async {
                do {
                    guard !self.recordingRequested, self.activeSegment == nil else {
                        throw RecordingError.testUnavailableWhileRecording
                    }
                    try self.videoPipeline.configureIfNeeded()
                    try self.videoPipeline.validateOverlayResources(at: Date())
                    try self.videoPipeline.startSession()
                    let testID = UUID()
                    let testBase = "prepatrack-capture-test-\(testID.uuidString)"
                    let temporaryDirectory = FileManager.default.temporaryDirectory
                    let frontTestURL = temporaryDirectory
                        .appendingPathComponent("\(testBase).front.video.mov")
                    let rearTestURL = temporaryDirectory
                        .appendingPathComponent("\(testBase).rear.video.mov")
                    let audioTestURL = temporaryDirectory
                        .appendingPathComponent("\(testBase).audio.caf")
                    var testSegmentActive = false
                    defer {
                        self.stopAudioCapture()
                        if testSegmentActive {
                            let stopped = DispatchSemaphore(value: 0)
                            self.videoPipeline.stopSegment { _ in stopped.signal() }
                            _ = stopped.wait(timeout: .now() + 10)
                        }
                        self.videoPipeline.stopSession()
                        try? AVAudioSession.sharedInstance().setActive(
                            false,
                            options: .notifyOthersOnDeactivation
                        )
                        for url in [frontTestURL, rearTestURL, audioTestURL] {
                            try? FileManager.default.removeItem(at: url)
                        }
                    }
                    try self.startAudioCapture(to: audioTestURL, acceptImmediately: true)
                    try self.videoPipeline.startSegment(
                        frontURL: frontTestURL,
                        rearURL: rearTestURL,
                        id: testID,
                        startedAt: Date(),
                        maxDurationSeconds: 30
                    )
                    testSegmentActive = true
                    guard self.videoPipeline.waitUntilSegmentHasFrames(id: testID, timeout: 20) else {
                        throw self.videoCaptureTimeoutError()
                    }
                    try self.waitUntilAudioHasData(timeout: 5)
                    self.stopAudioCapture()
                    let stopped = DispatchSemaphore(value: 0)
                    var stopResult: Result<DualCameraSegmentFiles, Error>?
                    self.videoPipeline.stopSegment { result in
                        stopResult = result
                        stopped.signal()
                    }
                    guard stopped.wait(timeout: .now() + 10) == .success else {
                        throw RecordingError.videoCaptureTimedOut("finalisation du test expirée")
                    }
                    testSegmentActive = false
                    guard let stopResult else {
                        throw RecordingError.videoCaptureTimedOut("résultat de finalisation absent")
                    }
                    switch stopResult {
                    case .success(_):
                        break
                    case .failure(let error):
                        throw error
                    }
                    let validationFinished = DispatchSemaphore(value: 0)
                    var mediaAreReadable = false
                    Task {
                        let frontIsReadable = await self.hasReadableVideoRecording(frontTestURL)
                        let rearIsReadable = await self.hasReadableVideoRecording(rearTestURL)
                        let audioIsReadable = await self.hasReadableAudioRecording(audioTestURL)
                        mediaAreReadable = frontIsReadable && rearIsReadable && audioIsReadable
                        validationFinished.signal()
                    }
                    guard validationFinished.wait(timeout: .now() + 10) == .success,
                          mediaAreReadable else {
                        throw RecordingError.videoCaptureTimedOut("fichiers finalisés illisibles")
                    }
                    let frontSize = self.recordingFileSize(at: frontTestURL)
                    let rearSize = self.recordingFileSize(at: rearTestURL)
                    let audioSize = self.recordingFileSize(at: audioTestURL)
                    guard audioSize > 10_000 else { throw RecordingError.audioCaptureTimedOut }
                    var testedProfile = self.captureProfilePayload()
                    testedProfile["captureConfirmed"] = true
                    testedProfile["audioCaptureConfirmed"] = true
                    testedProfile["framePairsWritten"] = 60
                    testedProfile["frontFileBytes"] = frontSize
                    testedProfile["rearFileBytes"] = rearSize
                    testedProfile["audioFileBytes"] = audioSize
                    DispatchQueue.main.async {
                        call.resolve(["captureProfile": testedProfile])
                    }
                } catch {
                    DispatchQueue.main.async { call.reject(error.localizedDescription) }
                }
            }
        }
    }

    /** Démarre un nouveau segment sans dépendre des imports Photos précédents. */
    private func videoCaptureTimeoutError() -> RecordingError {
        let health = videoPipeline.activeSegmentHealthPayload()
        let synchronized = health["synchronizedCollections"] as? Int ?? 0
        let droppedFront = health["droppedFrontSamples"] as? Int ?? 0
        let droppedRear = health["droppedRearSamples"] as? Int ?? 0
        let rendered = health["renderedFramePairs"] as? Int ?? 0
        let fallback = health["overlayFallbackFramePairs"] as? Int ?? 0
        let written = health["framePairsWritten"] as? Int ?? 0
        let backpressured = health["backpressuredFramePairs"] as? Int ?? 0
        let frontBytes = health["frontFileBytes"] as? Int ?? 0
        let rearBytes = health["rearFileBytes"] as? Int ?? 0
        var details = "sync \(synchronized), chutes \(droppedFront)/\(droppedRear), rendu \(rendered), secours \(fallback), écrit \(written), attente \(backpressured), fichiers \(frontBytes)/\(rearBytes) octets"
        if let failure = health["writerFailure"] as? String { details += ", erreur : \(failure)" }
        NSLog("[PrepaTrack Recording] Confirmation vidéo expirée : %@", details)
        return .videoCaptureTimedOut(details)
    }

    private func startCapture() throws -> Date {
        try ensureRecordingSpaceAvailable()
        let segment = makeSegment(startedAt: Date())
        do {
            try videoPipeline.configureIfNeeded()
            // Valider les textures AVANT/ARRIÈRE avant d'allumer les caméras
            // ou le micro. Une ressource de bandeau invalide ne peut ainsi
            // plus créer une fausse capture ni un segment partiel.
            try videoPipeline.validateOverlayResources(at: segment.startedAt)
            try videoPipeline.startSession()
            try startAudioCapture(to: segment.audioURL, acceptImmediately: true)
            try videoPipeline.startSegment(
                frontURL: segment.frontVideoURL,
                rearURL: segment.rearVideoURL,
                id: segment.id,
                startedAt: segment.startedAt,
                maxDurationSeconds: segmentDurationSeconds
            )
            guard videoPipeline.waitUntilSegmentHasFrames(id: segment.id, timeout: 20) else {
                throw videoCaptureTimeoutError()
            }
            try waitUntilAudioHasData(timeout: 5)
        } catch {
            stopAudioCapture()
            let segmentStopped = DispatchSemaphore(value: 0)
            videoPipeline.stopSegment { _ in segmentStopped.signal() }
            videoPipeline.stopSession()
            let writerStopped = segmentStopped.wait(timeout: .now() + 10) == .success
            if writerStopped { removeAudioOnlyFailedSegmentIfSafe(segment) }
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            // Une erreur de démarrage peut arriver après les premières
            // écritures. Ne jamais supprimer ces sources : le récupérateur
            // pourra les remuxer ou les sauver sans audio au prochain lancement.
            throw error
        }
        activeSegment = segment
        startedAt = segment.startedAt
        armAudioHealthWatchdog()
        scheduleSegmentTimer()
        return segment.startedAt
    }

    /** Passe au fichier suivant avant de finaliser le précédent. */
    private func rotateActiveSegment(expectedID: UUID? = nil) {
        guard recordingRequested,
              !rotationInProgress,
              !suspendedForInterruption,
              applicationIsActive,
              !audioInterruptionActive,
              let previous = activeSegment,
              expectedID == nil || expectedID == previous.id else { return }
        rotationInProgress = true
        cancelSegmentTimer()
        do {
            try ensureRecordingSpaceAvailable()
        } catch {
            rotationInProgress = false
            recordingRequested = false
            suspendedForInterruption = false
            beginTerminalStop(startedAt: previous.startedAt)
            finishActiveSegment(
                terminal: true,
                interrupted: false,
                forcedError: error.localizedDescription
            )
            return
        }
        var previousAudioError: String?
        let next = makeSegment(startedAt: Date())
        registerFinalization(previous)
        do {
            let nextAudioFile = try makeAudioFile(at: next.audioURL)
            try videoPipeline.rotateSegment(
                frontURL: next.frontVideoURL,
                rearURL: next.rearVideoURL,
                id: next.id,
                startedAt: next.startedAt,
                maxDurationSeconds: segmentDurationSeconds,
                didSwitch: {
                    previousAudioError = self.swapAudioFile(with: nextAudioFile)
                }
            ) { [weak self] result in
                self?.finalizeSegment(
                    previous,
                    videoResult: result,
                    audioError: previousAudioError,
                    terminal: false,
                    interrupted: false
                )
            }
            activeSegment = next
            startedAt = next.startedAt
            guard videoPipeline.waitUntilSegmentHasFrames(id: next.id, timeout: 20) else {
                throw videoCaptureTimeoutError()
            }
            try waitUntilAudioHasData(timeout: 5)
            rotationInProgress = false
            scheduleSegmentTimer()
            DispatchQueue.main.async {
                self.notifyListeners("recordingResumed", data: [
                    "startedAt": next.startedAt.timeIntervalSince1970 * 1_000,
                    "rotated": true,
                ])
            }
        } catch {
            rotationInProgress = false
            // Une tranche suivante non confirmée ne doit jamais être annoncée.
            // Fermer proprement le writer encore actif, garder l'intention de
            // filmer et retenter dans un nouveau jeu de fichiers.
            suspendedForInterruption = true
            finishActiveSegment(
                terminal: false,
                interrupted: true,
                forcedError: error.localizedDescription
            )
            scheduleResumeRetry()
        }
    }

    private func finishActiveSegment(
        terminal: Bool,
        interrupted: Bool,
        forcedError: String? = nil
    ) {
        guard let segment = activeSegment else { return }
        registerFinalization(segment)
        if terminal { beginTerminalStop(startedAt: segment.startedAt) }
        cancelSegmentTimer()
        let audioError = currentAudioWriteError() ?? forcedError
        activeSegment = nil
        startedAt = nil
        rotationInProgress = false
        stopAudioCapture()
        videoPipeline.stopSegment { [weak self] result in
            self?.finalizeSegment(
                segment,
                videoResult: result,
                audioError: audioError,
                terminal: terminal,
                interrupted: interrupted
            )
        }
        videoPipeline.stopSession()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if terminal {
            DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
        }
    }

    private func finalizeSegment(
        _ segment: NativeRecordingSegment,
        videoResult: Result<DualCameraSegmentFiles, Error>,
        audioError: String?,
        terminal: Bool,
        interrupted: Bool
    ) {
        switch videoResult {
        case .failure(let error):
            removeAudioOnlyFailedSegmentIfSafe(segment)
            completeSegmentFinalization(
                segment,
                saved: false,
                error: audioError ?? error.localizedDescription,
                terminal: terminal,
                interrupted: interrupted,
                cleanupURLs: []
            )
        case .success(let videos):
            prepareDualFinalRecordings(videos: videos, audioURL: segment.audioURL) { [weak self] front, rear in
                guard let self else { return }
                guard front.merged, rear.merged else {
                    let details = [front.error, rear.error, audioError]
                        .compactMap { $0 }
                        .joined(separator: " ")
                    self.completeSegmentFinalization(
                        segment,
                        saved: false,
                        error: details.isEmpty
                            ? "La finalisation d’au moins une caméra a échoué; toutes les sources ont été conservées."
                            : details,
                        terminal: terminal,
                        interrupted: interrupted,
                        cleanupURLs: []
                    )
                    return
                }
                self.savePairToPhotos(
                    front: front.finalURL,
                    rear: rear.finalURL,
                    capturedAt: segment.startedAt
                ) { saved, photoError in
                    var cleanup = [
                        videos.frontURL,
                        videos.rearURL,
                        segment.audioURL,
                    ]
                    if front.finalURL != videos.frontURL { cleanup.append(front.finalURL) }
                    if rear.finalURL != videos.rearURL { cleanup.append(rear.finalURL) }
                    if let journal = self.photoImportJournalURL(for: front.finalURL) {
                        cleanup.append(journal)
                    }
                    self.completeSegmentFinalization(
                        segment,
                        saved: saved,
                        error: photoError ?? front.error ?? rear.error ?? audioError,
                        terminal: terminal,
                        interrupted: interrupted,
                        cleanupURLs: cleanup
                    )
                }
            }
        }
    }

    private func completeSegmentFinalization(
        _ segment: NativeRecordingSegment,
        saved: Bool,
        error: String?,
        terminal: Bool,
        interrupted: Bool,
        cleanupURLs: [URL]
    ) {
        if saved {
            let unique = Set(cleanupURLs)
            // Le journal est le verrou anti-doublon : il doit être supprimé
            // seulement après toutes les sources et sorties finales.
            let mediaURLs = unique.filter { !$0.lastPathComponent.hasSuffix(".photo-import.json") }
            let journalURLs = unique.filter { $0.lastPathComponent.hasSuffix(".photo-import.json") }
            removeImportedMedia(Array(mediaURLs), journals: Array(journalURLs))
        }
        sessionQueue.async {
            self.finalizingSegmentIDs.remove(segment.id)
            self.endBackgroundFinalizationTask()
            if self.terminalStopPending {
                self.terminalHadSegments = true
                if !saved {
                    self.terminalAllSaved = false
                    self.terminalRetained = true
                    if self.terminalError == nil { self.terminalError = error }
                }
                if terminal, self.terminalStartedAt == nil {
                    self.terminalStartedAt = segment.startedAt
                }
            }

            var payload: [String: Any] = [
                "saved": saved,
                "startedAt": segment.startedAt.timeIntervalSince1970 * 1_000,
                "retained": !saved,
                "continuing": self.recordingRequested,
            ]
            if let error { payload["error"] = error }
            if interrupted {
                payload["interrupted"] = true
                payload["willResume"] = self.recordingRequested
            }
            if !terminal {
                DispatchQueue.main.async {
                    self.notifyListeners("recordingSegmentFinished", data: payload)
                }
            }
            self.completeTerminalStopIfReady()
            if self.recoveryRequested,
               !self.recordingRequested,
               self.activeSegment == nil,
               self.finalizingSegmentIDs.isEmpty {
                self.recoveryRequested = false
                self.recoverPendingRecordings()
            }
        }
    }

    private func registerFinalization(_ segment: NativeRecordingSegment) {
        finalizingSegmentIDs.insert(segment.id)
    }

    /**
     * Un CAF sans la moindre image n'est pas une vidéo récupérable et ne doit
     * pas remplir le téléphone après des échecs de caméra répétés. Dès qu'un
     * seul MOV contient un octet, tout est conservé sans exception.
     */
    private func removeAudioOnlyFailedSegmentIfSafe(_ segment: NativeRecordingSegment) {
        let frontBytes = recordingFileSize(at: segment.frontVideoURL)
        let rearBytes = recordingFileSize(at: segment.rearVideoURL)
        guard frontBytes == 0, rearBytes == 0 else { return }
        for url in [segment.frontVideoURL, segment.rearVideoURL, segment.audioURL] {
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func recordingFileSize(at url: URL) -> Int {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return 0 }
        defer { try? handle.close() }
        guard let size = try? handle.seekToEnd() else { return 0 }
        return Int(min(size, UInt64(Int.max)))
    }

    private func beginTerminalStop(startedAt: Date?) {
        guard !terminalStopPending else {
            if terminalStartedAt == nil { terminalStartedAt = startedAt }
            return
        }
        terminalStopPending = true
        terminalHadSegments = activeSegment != nil || !finalizingSegmentIDs.isEmpty
        terminalAllSaved = true
        terminalRetained = false
        terminalError = nil
        terminalStartedAt = startedAt
    }

    private func completeTerminalStopIfReady() {
        guard terminalStopPending, finalizingSegmentIDs.isEmpty else { return }
        let saved = terminalHadSegments && terminalAllSaved
        var payload: [String: Any] = [
            "saved": saved,
            "retained": terminalRetained,
        ]
        if let terminalStartedAt {
            payload["startedAt"] = terminalStartedAt.timeIntervalSince1970 * 1_000
        }
        let finalError = terminalError
        if let finalError { payload["error"] = finalError }
        let calls = stopCalls
        stopCalls.removeAll()
        terminalStopPending = false
        terminalHadSegments = false
        terminalAllSaved = true
        terminalRetained = false
        self.terminalError = nil
        self.terminalStartedAt = nil

        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = false
            calls.forEach {
                if saved || finalError == nil {
                    $0.resolve(payload)
                } else {
                    $0.reject(finalError ?? "La vidéo n’a pas pu être ajoutée à Photos.")
                }
            }
            self.notifyListeners("recordingFinished", data: payload)
        }
    }

    private func makeSegment(startedAt: Date) -> NativeRecordingSegment {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "fr_FR_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let baseName = "prepatrack-\(formatter.string(from: startedAt))-\(UUID().uuidString)"
        return NativeRecordingSegment(
            id: UUID(),
            startedAt: startedAt,
            frontVideoURL: recordingsDirectory.appendingPathComponent("\(baseName).front.video.mov"),
            rearVideoURL: recordingsDirectory.appendingPathComponent("\(baseName).rear.video.mov"),
            audioURL: recordingsDirectory.appendingPathComponent("\(baseName).audio.caf")
        )
    }

    private func scheduleSegmentTimer() {
        cancelSegmentTimer()
        guard let segmentID = activeSegment?.id else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.rotateActiveSegment(expectedID: segmentID)
        }
        segmentTimer = work
        sessionQueue.asyncAfter(deadline: .now() + segmentDurationSeconds, execute: work)
    }

    private func cancelSegmentTimer() {
        segmentTimer?.cancel()
        segmentTimer = nil
    }

    private func ensureRecordingSpaceAvailable() throws {
        let values = try recordingsDirectory.resourceValues(forKeys: [
            .volumeAvailableCapacityForImportantUsageKey,
        ])
        if let available = values.volumeAvailableCapacityForImportantUsage,
           available < minimumFreeBytesForNewSegment {
            throw RecordingError.insufficientStorage
        }
    }

    /**
     * Reprend une capture interrompue sans attendre la sauvegarde Photos du
     * segment précédent. L'arrêt manuel reste toujours prioritaire.
     */
    private func resumeRecordingIfNeeded() {
        guard recordingRequested,
              suspendedForInterruption,
              activeSegment == nil,
              applicationIsActive,
              !audioInterruptionActive else { return }
        do {
            let resumedAt = try startCapture()
            suspendedForInterruption = false
            resumeRetryAttempt = 0
            cancelResumeRetry()
            DispatchQueue.main.async {
                UIApplication.shared.isIdleTimerDisabled = true
                self.notifyListeners("recordingResumed", data: [
                    "startedAt": resumedAt.timeIntervalSince1970 * 1_000,
                ])
            }
        } catch {
            suspendedForInterruption = true
            scheduleResumeRetry()
            DispatchQueue.main.async {
                self.notifyListeners("recordingResumeFailed", data: [
                    "error": error.localizedDescription,
                    "retrying": true,
                ])
            }
        }
    }

    private func scheduleResumeRetry() {
        guard recordingRequested, applicationIsActive else { return }
        cancelResumeRetry()
        let delay = min(pow(2.0, Double(resumeRetryAttempt)), 30.0)
        resumeRetryAttempt += 1
        let work = DispatchWorkItem { [weak self] in self?.resumeRecordingIfNeeded() }
        resumeRetryWorkItem = work
        sessionQueue.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func cancelResumeRetry() {
        resumeRetryWorkItem?.cancel()
        resumeRetryWorkItem = nil
    }

    private func saveToPhotos(
        _ url: URL,
        capturedAt: Date? = nil,
        completion: @escaping (Bool, String?) -> Void
    ) {
        PHPhotoLibrary.shared().performChanges({
            // Contrairement à la factory optionnelle, cette requête existe
            // toujours. Une transaction PhotoKit vide ne peut donc jamais être
            // interprétée comme un succès puis provoquer la suppression de la
            // seule source récupérable.
            let request = PHAssetCreationRequest.forAsset()
            request.creationDate = capturedAt
            request.addResource(with: .video, fileURL: url, options: nil)
        }) { saved, error in
            completion(saved, error?.localizedDescription)
        }
    }

    /**
     * Ajoute les deux angles dans une seule transaction PhotoKit. Ainsi, un
     * segment ne peut pas être annoncé comme sauvegardé avec seulement l'une
     * des deux caméras.
     */
    private func savePairToPhotos(
        front: URL,
        rear: URL,
        capturedAt: Date,
        completion: @escaping (Bool, String?) -> Void
    ) {
        guard let journalURL = photoImportJournalURL(for: front) else {
            completion(false, "Impossible d'identifier durablement le couple de vidéos; les sources ont été conservées.")
            return
        }
        do {
            try writePhotoImportJournal(
                PhotoImportJournal(
                    state: "preparing",
                    createdAt: Date(),
                    frontLocalIdentifier: nil,
                    rearLocalIdentifier: nil
                ),
                to: journalURL
            )
        } catch {
            completion(false, "Le journal de sauvegarde Photos n'a pas pu être écrit; les sources ont été conservées.")
            return
        }

        PHPhotoLibrary.shared().performChanges({
            let frontRequest = PHAssetCreationRequest.forAsset()
            frontRequest.creationDate = capturedAt
            frontRequest.addResource(with: .video, fileURL: front, options: nil)
            let rearRequest = PHAssetCreationRequest.forAsset()
            rearRequest.creationDate = capturedAt.addingTimeInterval(0.001)
            rearRequest.addResource(with: .video, fileURL: rear, options: nil)
            let journal = PhotoImportJournal(
                state: "importing",
                createdAt: Date(),
                frontLocalIdentifier: frontRequest.placeholderForCreatedAsset?.localIdentifier,
                rearLocalIdentifier: rearRequest.placeholderForCreatedAsset?.localIdentifier
            )
            try? self.writePhotoImportJournal(journal, to: journalURL)
        }) { saved, error in
            if saved {
                let importing = self.readPhotoImportJournal(from: journalURL)
                try? self.writePhotoImportJournal(
                    PhotoImportJournal(
                        state: "committed",
                        createdAt: Date(),
                        frontLocalIdentifier: importing?.frontLocalIdentifier,
                        rearLocalIdentifier: importing?.rearLocalIdentifier
                    ),
                    to: journalURL
                )
            } else {
                try? FileManager.default.removeItem(at: journalURL)
            }
            completion(saved, error?.localizedDescription)
        }
    }

    /** Prépare AVANT puis ARRIÈRE, et un seul segment à la fois. */
    private func prepareDualFinalRecordings(
        videos: DualCameraSegmentFiles,
        audioURL: URL,
        completion: @escaping (PreparedCameraRecording, PreparedCameraRecording) -> Void
    ) {
        sessionQueue.async {
            self.pendingDualPreparationJobs.append { [weak self] in
                guard let self else { return }
                self.prepareFinalRecording(
                    videoURL: videos.frontURL,
                    audioURL: audioURL
                ) { frontURL, frontMerged, frontError in
                    let front = PreparedCameraRecording(
                        finalURL: frontURL,
                        merged: frontMerged,
                        error: frontError
                    )
                    self.prepareFinalRecording(
                        videoURL: videos.rearURL,
                        audioURL: audioURL
                    ) { rearURL, rearMerged, rearError in
                        let rear = PreparedCameraRecording(
                            finalURL: rearURL,
                            merged: rearMerged,
                            error: rearError
                        )
                        self.sessionQueue.async {
                            completion(front, rear)
                            self.dualPreparationInProgress = false
                            self.startNextDualPreparationIfNeeded()
                        }
                    }
                }
            }
            self.startNextDualPreparationIfNeeded()
        }
    }

    private func startNextDualPreparationIfNeeded() {
        dispatchPrecondition(condition: .onQueue(sessionQueue))
        guard !dualPreparationInProgress,
              !pendingDualPreparationJobs.isEmpty else { return }
        dualPreparationInProgress = true
        let job = pendingDualPreparationJobs.removeFirst()
        job()
    }

    /**
     * Récupère les captures abandonnées par une extinction, un crash ou une
     * ancienne version. Le dossier temporaire est aussi inspecté pour sauver
     * les fichiers laissés par les builds précédentes.
     */
    private func recoverPendingRecordings(
        allowAmbiguousRetry: Bool = false,
        allowRemux: Bool = false,
        completion: ((RecordingRecoverySummary) -> Void)? = nil
    ) {
        guard !recordingRequested,
              activeSegment == nil,
              finalizingSegmentIDs.isEmpty else {
            recoveryRequested = true
            if let completion {
                let pending = pendingRecordingCount()
                DispatchQueue.main.async {
                    completion(RecordingRecoverySummary(
                        pending: pending,
                        recovered: 0,
                        retained: pending,
                        error: "Une capture ou une finalisation est encore en cours."
                    ))
                }
            }
            return
        }
        guard !recoveryInProgress else {
            recoveryRequested = true
            queuedRecoveryAllowsAmbiguousRetry = queuedRecoveryAllowsAmbiguousRetry
                || allowAmbiguousRetry
            queuedRecoveryAllowsRemux = queuedRecoveryAllowsRemux || allowRemux
            if let completion { queuedRecoveryCompletion = completion }
            return
        }

        let snapshot = makeRecoverySnapshot()
        guard snapshot.pending > 0 else {
            recoveryRequested = false
            if let completion {
                DispatchQueue.main.async {
                    completion(RecordingRecoverySummary(pending: 0, recovered: 0, retained: 0, error: nil))
                }
            }
            endBackgroundFinalizationTask()
            return
        }
        recoveryInProgress = true

        let start = { [weak self] in
            guard let self else { return }
            Task {
                let summary = await self.performRecovery(
                    snapshot,
                    allowAmbiguousRetry: allowAmbiguousRetry,
                    allowRemux: allowRemux
                )
                self.sessionQueue.async {
                    self.completeRecovery(summary, directCompletion: completion)
                }
            }
        }

        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if status == .authorized || status == .limited {
            start()
        } else if status == .notDetermined {
            DispatchQueue.main.async {
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { next in
                    self.sessionQueue.async {
                        if next == .authorized || next == .limited {
                            start()
                        } else {
                            self.completeRecovery(
                                RecordingRecoverySummary(
                                    pending: snapshot.pending,
                                    recovered: 0,
                                    retained: snapshot.pending,
                                    error: "L’ajout à Photos n’est pas autorisé."
                                ),
                                directCompletion: completion
                            )
                        }
                    }
                }
            }
        } else {
            completeRecovery(
                RecordingRecoverySummary(
                    pending: snapshot.pending,
                    recovered: 0,
                    retained: snapshot.pending,
                    error: "L’ajout à Photos n’est pas autorisé."
                ),
                directCompletion: completion
            )
        }
    }

    /** Termine un passage et transmet sans perte une demande explicite arrivée
     * pendant l'auto-récupération. */
    private func completeRecovery(
        _ summary: RecordingRecoverySummary,
        directCompletion: ((RecordingRecoverySummary) -> Void)?
    ) {
        recoveryInProgress = false
        endBackgroundFinalizationTask()
        let shouldRetry = recoveryRequested
            && !recordingRequested
            && activeSegment == nil
            && finalizingSegmentIDs.isEmpty
        let retryAllowsAmbiguous = queuedRecoveryAllowsAmbiguousRetry
        let retryAllowsRemux = queuedRecoveryAllowsRemux
        let retryCompletion = queuedRecoveryCompletion
        recoveryRequested = false
        queuedRecoveryAllowsAmbiguousRetry = false
        queuedRecoveryAllowsRemux = false
        queuedRecoveryCompletion = nil

        if let directCompletion {
            DispatchQueue.main.async { directCompletion(summary) }
        }
        guard shouldRetry else { return }
        if retryAllowsAmbiguous, summary.retained == 0 {
            if let retryCompletion {
                DispatchQueue.main.async { retryCompletion(summary) }
            }
            return
        }
        recoverPendingRecordings(
            allowAmbiguousRetry: retryAllowsAmbiguous,
            allowRemux: retryAllowsRemux,
            completion: retryCompletion
        )
    }

    private func makeRecoverySnapshot() -> RecordingRecoverySnapshot {
        let manager = FileManager.default
        let durable = ((try? manager.contentsOfDirectory(
            at: recordingsDirectory,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        )) ?? []).filter {
            ((try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) > 0
        }
        let temporary = ((try? manager.contentsOfDirectory(
            at: manager.temporaryDirectory,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        )) ?? []).filter {
            $0.lastPathComponent.hasPrefix("prepatrack-")
                && $0.pathExtension == "mov"
                && ((try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) > 0
        }
        let finalVideos = durable.filter {
            $0.pathExtension == "mov"
                && !$0.lastPathComponent.hasSuffix(".video.mov")
                && !$0.lastPathComponent.hasSuffix(".merging.mov")
        }
        let rawVideos = durable.filter { $0.lastPathComponent.hasSuffix(".video.mov") }
        let mergingVideos = durable.filter { $0.lastPathComponent.hasSuffix(".merging.mov") }
        let photoImportJournals = durable.filter { $0.lastPathComponent.hasSuffix(".photo-import.json") }
        let dualBases = Set(
            (finalVideos + rawVideos + mergingVideos + photoImportJournals)
                .compactMap { dualCameraBaseName(for: $0) }
        )
        let legacyBases = Set(
            (finalVideos + rawVideos + mergingVideos)
                .filter { !isDualCameraVideo($0) }
                .map { legacyRecordingBaseName(for: $0) }
        )
        return RecordingRecoverySnapshot(
            finalVideos: finalVideos,
            rawVideos: rawVideos,
            mergingVideos: mergingVideos,
            temporaryVideos: temporary,
            dualBases: dualBases,
            pending: dualBases.count * 2 + legacyBases.count + temporary.count
        )
    }

    private func performRecovery(
        _ snapshot: RecordingRecoverySnapshot,
        allowAmbiguousRetry: Bool,
        allowRemux: Bool
    ) async -> RecordingRecoverySummary {
        let manager = FileManager.default
        var recovered = 0
        var retained = 0
        var errors: [String] = []
        let notify: (Bool, String?, Date?) -> Void = { saved, error, capturedAt in
            DispatchQueue.main.async {
                var payload: [String: Any] = ["saved": saved, "recovered": true]
                if let error { payload["error"] = error }
                if let capturedAt { payload["startedAt"] = capturedAt.timeIntervalSince1970 * 1_000 }
                self.notifyListeners("recordingSegmentFinished", data: payload)
            }
        }

        for base in snapshot.dualBases.sorted() {
            let outcome = await recoverDualCameraPair(
                baseName: base,
                allowAmbiguousRetry: allowAmbiguousRetry,
                allowRemux: allowRemux
            )
            recovered += outcome.recovered
            retained += outcome.retained
            if let error = outcome.error { errors.append(error) }
            notify(outcome.recovered > 0, outcome.error, outcome.capturedAt)
        }

        var processedLegacyBases = Set<String>()
        for partial in snapshot.mergingVideos where !isDualCameraVideo(partial) {
            let base = legacyRecordingBaseName(for: partial)
            let raw = partial.deletingLastPathComponent().appendingPathComponent("\(base).video.mov")
            let final = partial.deletingLastPathComponent().appendingPathComponent("\(base).mov")
            let audio = sharedAudioURL(forVideo: partial)
            let hasAlternative = manager.fileExists(atPath: raw.path)
                || manager.fileExists(atPath: final.path)
            let validMerged = await isValidMergedRecording(partial)
            let partialIsReadable = await hasReadableVideoRecording(partial)
            let externalAudioIsReadable = await hasReadableAudioRecording(audio)
            let readableFallback = !hasAlternative
                && !externalAudioIsReadable
                && partialIsReadable
            guard validMerged || readableFallback else {
                if !hasAlternative {
                    processedLegacyBases.insert(base)
                    retained += 1
                    let error = "Un export vidéo interrompu reste conservé localement car il est illisible."
                    errors.append(error)
                    notify(false, error, captureDate(from: partial))
                }
                continue
            }
            processedLegacyBases.insert(base)
            let result = await saveToPhotosAsync(partial, capturedAt: captureDate(from: partial))
            if result.0 {
                recovered += 1
                removeImportedMedia([partial, raw, final, audio])
            } else {
                retained += 1
                if let error = result.1 { errors.append(error) }
            }
            notify(result.0, result.1, captureDate(from: partial))
        }

        for finalURL in snapshot.finalVideos where !isDualCameraVideo(finalURL) {
            let base = legacyRecordingBaseName(for: finalURL)
            guard !processedLegacyBases.contains(base) else { continue }
            let raw = finalURL.deletingLastPathComponent().appendingPathComponent("\(base).video.mov")
            let merging = finalURL.deletingLastPathComponent().appendingPathComponent("\(base).merging.mov")
            let audio = sharedAudioURL(forVideo: finalURL)
            guard await isValidMergedRecording(finalURL) else {
                if manager.fileExists(atPath: raw.path) {
                    // La source brute sera tentée ensuite. Le fichier final
                    // existant reste intact jusqu'au succès de son remplacement.
                } else {
                    processedLegacyBases.insert(base)
                    let externalAudioIsReadable = await hasReadableAudioRecording(audio)
                    if !externalAudioIsReadable,
                       await hasReadableVideoRecording(finalURL) {
                        let result = await saveToPhotosAsync(finalURL, capturedAt: captureDate(from: finalURL))
                        if result.0 {
                            recovered += 1
                            removeImportedMedia([finalURL, merging, audio])
                        } else {
                            retained += 1
                            if let error = result.1 { errors.append(error) }
                        }
                        notify(result.0, result.1, captureDate(from: finalURL))
                    } else {
                        retained += 1
                        let error = "Une vidéo finale incomplète a été conservée pour diagnostic."
                        errors.append(error)
                        notify(false, error, captureDate(from: finalURL))
                    }
                }
                continue
            }
            processedLegacyBases.insert(base)
            let result = await saveToPhotosAsync(finalURL, capturedAt: captureDate(from: finalURL))
            if result.0 {
                recovered += 1
                removeImportedMedia([finalURL, raw, merging, audio])
            } else {
                retained += 1
                if let error = result.1 { errors.append(error) }
            }
            notify(result.0, result.1, captureDate(from: finalURL))
        }

        for rawURL in snapshot.rawVideos where !isDualCameraVideo(rawURL) {
            let base = legacyRecordingBaseName(for: rawURL)
            guard !processedLegacyBases.contains(base) else { continue }
            processedLegacyBases.insert(base)
            let audioURL = sharedAudioURL(forVideo: rawURL)
            let existingFinalURL = rawURL.deletingLastPathComponent().appendingPathComponent("\(base).mov")
            let existingMergingURL = rawURL.deletingLastPathComponent().appendingPathComponent("\(base).merging.mov")
            guard allowRemux else {
                let readableAudio = await hasReadableAudioRecording(audioURL)
                let readableVideo = await hasReadableVideoRecording(rawURL)
                if !readableAudio && readableVideo {
                    let result = await saveToPhotosAsync(rawURL, capturedAt: captureDate(from: rawURL))
                    if result.0 {
                        recovered += 1
                        removeImportedMedia([rawURL, audioURL, existingFinalURL, existingMergingURL])
                    } else {
                        retained += 1
                        if let error = result.1 { errors.append(error) }
                    }
                    notify(result.0, result.1, captureDate(from: rawURL))
                } else {
                    retained += 1
                    let message = "Une fusion audio/vidéo est en attente. Utilise « Récupérer les vidéos locales » pour la terminer."
                    errors.append(message)
                    notify(false, message, captureDate(from: rawURL))
                }
                continue
            }
            let prepared = await prepareFinalRecordingAsync(videoURL: rawURL, audioURL: audioURL)
            var saved = false
            var error = prepared.error
            var savedURL = prepared.finalURL
            let readableAudio = await hasReadableAudioRecording(audioURL)
            if prepared.merged {
                let result = await saveToPhotosAsync(prepared.finalURL, capturedAt: captureDate(from: rawURL))
                saved = result.0
                error = result.1 ?? error
            } else {
                let readableVideo = await hasReadableVideoRecording(rawURL)
                if !readableAudio && readableVideo {
                    let result = await saveToPhotosAsync(rawURL, capturedAt: captureDate(from: rawURL))
                    saved = result.0
                    error = result.1 ?? "La piste audio était irrécupérable; la vidéo a été sauvée sans son."
                    savedURL = rawURL
                }
            }
            if !saved && !readableAudio {
                let existingFinalIsReadable = await hasReadableVideoRecording(existingFinalURL)
                if existingFinalIsReadable {
                    let result = await saveToPhotosAsync(existingFinalURL, capturedAt: captureDate(from: existingFinalURL))
                    saved = result.0
                    error = result.1
                    savedURL = existingFinalURL
                }
            }
            if !saved && !readableAudio {
                let existingMergingIsReadable = await hasReadableVideoRecording(existingMergingURL)
                if existingMergingIsReadable {
                    let result = await saveToPhotosAsync(existingMergingURL, capturedAt: captureDate(from: existingMergingURL))
                    saved = result.0
                    error = result.1
                    savedURL = existingMergingURL
                }
            }
            if saved {
                recovered += 1
                removeImportedMedia([
                    rawURL,
                    audioURL,
                    savedURL,
                    existingFinalURL,
                    existingMergingURL,
                ])
            } else {
                retained += 1
                if let error { errors.append(error) }
            }
            notify(saved, error, captureDate(from: rawURL))
        }

        for temporaryURL in snapshot.temporaryVideos {
            let result = await saveToPhotosAsync(temporaryURL, capturedAt: captureDate(from: temporaryURL))
            if result.0 {
                recovered += 1
                try? manager.removeItem(at: temporaryURL)
            } else {
                retained += 1
                if let error = result.1 { errors.append(error) }
            }
            notify(result.0, result.1, captureDate(from: temporaryURL))
        }

        return RecordingRecoverySummary(
            pending: snapshot.pending,
            recovered: recovered,
            retained: retained,
            error: errors.first
        )
    }

    private func isDualCameraVideo(_ url: URL) -> Bool {
        let name = url.lastPathComponent
        return name.contains(".front.") || name.contains(".rear.")
    }

    private func dualCameraBaseName(for url: URL) -> String? {
        let name = url.lastPathComponent
        for suffix in [
            ".front.video.mov",
            ".rear.video.mov",
            ".front.merging.mov",
            ".rear.merging.mov",
            ".front.mov",
            ".rear.mov",
            ".photo-import.json",
        ] where name.hasSuffix(suffix) {
            return String(name.dropLast(suffix.count))
        }
        return nil
    }

    private func legacyRecordingBaseName(for url: URL) -> String {
        let name = url.lastPathComponent
        for suffix in [".video.mov", ".merging.mov", ".mov"] where name.hasSuffix(suffix) {
            return String(name.dropLast(suffix.count))
        }
        return url.deletingPathExtension().lastPathComponent
    }

    /**
     * Récupère un segment double caméra comme une unité atomique. Les sources
     * et la piste audio partagée ne sont supprimées qu'après l'ajout confirmé
     * des deux angles dans Photos.
     */
    private func recoverDualCameraPair(
        baseName: String,
        allowAmbiguousRetry: Bool = false,
        allowRemux: Bool = false
    ) async -> DualCameraRecoveryOutcome {
        let directory = recordingsDirectory
        let frontRaw = directory.appendingPathComponent("\(baseName).front.video.mov")
        let rearRaw = directory.appendingPathComponent("\(baseName).rear.video.mov")
        let frontFinal = directory.appendingPathComponent("\(baseName).front.mov")
        let rearFinal = directory.appendingPathComponent("\(baseName).rear.mov")
        let frontMerging = directory.appendingPathComponent("\(baseName).front.merging.mov")
        let rearMerging = directory.appendingPathComponent("\(baseName).rear.merging.mov")
        let manager = FileManager.default
        let audioSources = sharedAudioSourceURLs(baseName: baseName, directory: directory)
        let audio = await firstReadableAudioRecording(in: audioSources)
            ?? audioSources.first(where: { manager.fileExists(atPath: $0.path) })
            ?? audioSources[0]
        let capturedAt = captureDate(from: frontRaw)
        let journalURL = directory.appendingPathComponent("\(baseName).photo-import.json")
        let outcome: (Int, Int, String?) -> DualCameraRecoveryOutcome = {
            DualCameraRecoveryOutcome(
                recovered: $0,
                retained: $1,
                error: $2,
                capturedAt: capturedAt
            )
        }

        if manager.fileExists(atPath: journalURL.path) {
            let fullAccess = PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized
            guard let journal = readPhotoImportJournal(from: journalURL) else {
                guard allowAmbiguousRetry && fullAccess else {
                    return outcome(
                        0,
                        2,
                        "Le journal Photos est illisible. Utilise la récupération manuelle avec l'accès complet à Photos; les sources restent intactes."
                    )
                }
                try? manager.removeItem(at: journalURL)
                return await recoverDualCameraPair(
                    baseName: baseName,
                    allowAmbiguousRetry: false,
                    allowRemux: allowRemux
                )
            }
            if journal.state == "committed" {
                let sources = [
                    frontRaw,
                    rearRaw,
                    frontFinal,
                    rearFinal,
                    frontMerging,
                    rearMerging,
                ] + audioSources
                removeImportedMedia(sources, journals: [journalURL])
                return outcome(2, 0, nil)
            } else if journal.state == "preparing" {
                guard allowAmbiguousRetry && fullAccess else {
                    return outcome(
                        0,
                        2,
                        "Appuie sur « Récupérer les vidéos locales » et autorise l’accès complet à Photos pour débloquer ce couple sans perdre les sources."
                    )
                }
                // Ancien journal sans identifiants. La relance est réservée à
                // une action explicite après confirmation de l'utilisateur et
                // accès complet à Photos. Une éventuelle copie vaut mieux que
                // de laisser les deux sources invisibles indéfiniment.
                try? manager.removeItem(at: journalURL)
            } else if let importedCount = photoImportConfirmationCount(journal) {
                if importedCount == 2 {
                    let sources = [
                        frontRaw,
                        rearRaw,
                        frontFinal,
                        rearFinal,
                        frontMerging,
                        rearMerging,
                    ] + audioSources
                    removeImportedMedia(sources, journals: [journalURL])
                    return outcome(2, 0, nil)
                }
                if importedCount == 0 && allowAmbiguousRetry {
                    // Les identifiants n'existent pas dans Photos : la
                    // transaction a échoué avant son commit, on peut retenter
                    // sans produire de doublon.
                    try? manager.removeItem(at: journalURL)
                } else if importedCount == 1 && allowAmbiguousRetry {
                    let frontWasImported = photoAssetExists(journal.frontLocalIdentifier)
                    let rearWasImported = photoAssetExists(journal.rearLocalIdentifier)
                    let alreadyRecovered = (frontWasImported ? 1 : 0) + (rearWasImported ? 1 : 0)
                    guard alreadyRecovered == 1 else {
                        return outcome(
                            0,
                            2,
                            "L’import Photos partiel n’a pas pu être identifié; toutes les sources restent conservées."
                        )
                    }
                    let cleaned = frontWasImported
                        ? removeImportedMedia([frontRaw, frontFinal, frontMerging])
                        : removeImportedMedia([rearRaw, rearFinal, rearMerging])
                    guard cleaned else {
                        return outcome(
                            1,
                            1,
                            "Un angle est déjà dans Photos, mais sa copie locale n’a pas pu être nettoyée. Le journal est conservé pour éviter un doublon."
                        )
                    }
                    do {
                        try manager.removeItem(at: journalURL)
                    } catch {
                        return outcome(
                            1,
                            1,
                            "Un angle est déjà dans Photos; le journal local est conservé pour éviter un doublon."
                        )
                    }
                    let retry = await recoverDualCameraPair(
                        baseName: baseName,
                        allowAmbiguousRetry: false,
                        allowRemux: allowRemux
                    )
                    let totalRecovered = min(2, alreadyRecovered + retry.recovered)
                    let totalRetained = max(0, 2 - totalRecovered)
                    return outcome(
                        totalRecovered,
                        totalRetained,
                        totalRetained > 0 ? retry.error : nil
                    )
                } else {
                    return outcome(
                        0,
                        2,
                        importedCount == 1
                            ? "Une seule des deux vidéos est visible dans Photos. Les sources sont conservées pour réparer le couple sans perte."
                            : "L’import Photos précédent reste ambigu. Utilise le bouton de récupération pour le confirmer sans perte."
                    )
                }
            } else {
                guard allowAmbiguousRetry && fullAccess else {
                    return outcome(
                        0,
                        2,
                        "Autorise l’accès complet à Photos pour vérifier puis récupérer ce couple de vidéos. Les sources sont conservées."
                    )
                }
                // Journaux anciens ou incomplets : seule une action explicite
                // avec accès complet peut autoriser une nouvelle tentative.
                try? manager.removeItem(at: journalURL)
            }
        }

        if !allowRemux {
            let frontPrepared = await firstValidMergedRecording(in: [frontFinal, frontMerging])
            let rearPrepared = await firstValidMergedRecording(in: [rearFinal, rearMerging])
            var automaticFront = frontPrepared
            var automaticRear = rearPrepared
            let readableAudio = await hasReadableAudioRecording(audio)
            if !readableAudio {
                if automaticFront == nil, await hasReadableVideoRecording(frontRaw) {
                    automaticFront = frontRaw
                }
                if automaticRear == nil, await hasReadableVideoRecording(rearRaw) {
                    automaticRear = rearRaw
                }
            }
            guard let automaticFront, let automaticRear else {
                return outcome(
                    0,
                    2,
                    "Une fusion avant/arrière est en attente. Utilise « Récupérer les vidéos locales » pour la terminer."
                )
            }
            let result = await savePairToPhotosAsync(
                front: automaticFront,
                rear: automaticRear,
                capturedAt: capturedAt ?? Date()
            )
            guard result.0 else { return outcome(0, 2, result.1) }
            removeImportedMedia(
                [frontRaw, rearRaw, frontFinal, rearFinal, frontMerging, rearMerging] + audioSources,
                journals: [journalURL]
            )
            return outcome(2, 0, nil)
        }

        let front = await recoverPreparedCamera(finalURL: frontFinal, rawURL: frontRaw, audioURL: audio)
        let rear = await recoverPreparedCamera(finalURL: rearFinal, rawURL: rearRaw, audioURL: audio)
        var saved = false
        var error: String?
        var savedURLs: [URL] = []
        let readableAudio = await hasReadableAudioRecording(audio)
        let readableFront = await hasReadableVideoRecording(frontRaw)
        let readableRear = await hasReadableVideoRecording(rearRaw)

        if front.merged, rear.merged {
            let result = await savePairToPhotosAsync(
                front: front.finalURL,
                rear: rear.finalURL,
                capturedAt: capturedAt ?? Date()
            )
            saved = result.0
            error = result.1
            savedURLs = [front.finalURL, rear.finalURL]
        } else if !readableAudio, readableFront, readableRear {
            let result = await savePairToPhotosAsync(
                front: frontRaw,
                rear: rearRaw,
                capturedAt: capturedAt ?? Date()
            )
            saved = result.0
            error = result.1 ?? "La piste audio était irrécupérable; les deux vidéos ont été sauvées sans son."
            savedURLs = [frontRaw, rearRaw]
        } else {
            error = [front.error, rear.error]
                .compactMap { $0 }
                .joined(separator: " ")
            if error?.isEmpty != false {
                error = "Le couple avant/arrière est incomplet; toutes les sources ont été conservées."
            }
        }

        if saved {
            let cleanup = [
                frontRaw,
                rearRaw,
                frontFinal,
                rearFinal,
                frontMerging,
                rearMerging,
                journalURL,
            ] + audioSources + savedURLs
            let unique = Set(cleanup)
            let mediaURLs = unique.filter { !$0.lastPathComponent.hasSuffix(".photo-import.json") }
            removeImportedMedia(Array(mediaURLs), journals: [journalURL])
            return outcome(2, 0, nil)
        }

        // Si le couple complet ne peut plus être reconstruit, sauver chaque
        // angle encore lisible vaut mieux que laisser toutes les preuves dans
        // le conteneur privé. L'autre angle et l'audio restent conservés.
        var frontCandidate: URL?
        if front.merged {
            frontCandidate = front.finalURL
        } else if !readableAudio, readableFront {
            frontCandidate = frontRaw
        } else if !readableAudio, await hasReadableVideoRecording(frontFinal) {
            frontCandidate = frontFinal
        } else if !readableAudio, await hasReadableVideoRecording(frontMerging) {
            frontCandidate = frontMerging
        }

        var rearCandidate: URL?
        if rear.merged {
            rearCandidate = rear.finalURL
        } else if !readableAudio, readableRear {
            rearCandidate = rearRaw
        } else if !readableAudio, await hasReadableVideoRecording(rearFinal) {
            rearCandidate = rearFinal
        } else if !readableAudio, await hasReadableVideoRecording(rearMerging) {
            rearCandidate = rearMerging
        }

        var recoveredAngles = 0
        var partialErrors: [String] = []
        if let frontCandidate {
            let result = await saveToPhotosAsync(frontCandidate, capturedAt: capturedAt)
            if result.0 {
                recoveredAngles += 1
                removeImportedMedia([frontRaw, frontFinal, frontMerging])
            } else if let message = result.1 {
                partialErrors.append("Avant : \(message)")
            }
        }
        if let rearCandidate {
            let result = await saveToPhotosAsync(rearCandidate, capturedAt: capturedAt?.addingTimeInterval(0.001))
            if result.0 {
                recoveredAngles += 1
                removeImportedMedia([rearRaw, rearFinal, rearMerging])
            } else if let message = result.1 {
                partialErrors.append("Arrière : \(message)")
            }
        }

        let retainedAngles = 2 - recoveredAngles
        let remainingAngleMedia = [
            frontRaw,
            rearRaw,
            frontFinal,
            rearFinal,
            frontMerging,
            rearMerging,
        ]
        if !remainingAngleMedia.contains(where: { manager.fileExists(atPath: $0.path) }) {
            removeImportedMedia(
                remainingAngleMedia + audioSources,
                journals: [journalURL]
            )
        }
        if recoveredAngles == 0, let error, !error.isEmpty {
            partialErrors.insert(error, at: 0)
        } else if retainedAngles > 0 {
            partialErrors.append("L’angle manquant et ses sources restent conservés pour une prochaine tentative.")
        }
        return outcome(
            recoveredAngles,
            retainedAngles,
            partialErrors.first
                ?? (retainedAngles > 0 ? "Le couple avant/arrière reste incomplet." : nil)
        )
    }

    private func recoverPreparedCamera(
        finalURL: URL,
        rawURL: URL,
        audioURL: URL
    ) async -> PreparedCameraRecording {
        if await isValidMergedRecording(finalURL) {
            return PreparedCameraRecording(finalURL: finalURL, merged: true, error: nil)
        }
        guard FileManager.default.fileExists(atPath: rawURL.path) else {
            return PreparedCameraRecording(
                finalURL: finalURL,
                merged: false,
                error: "Une des deux vidéos brutes est absente."
            )
        }
        return await withCheckedContinuation { continuation in
            prepareFinalRecording(videoURL: rawURL, audioURL: audioURL) { url, merged, error in
                continuation.resume(returning: PreparedCameraRecording(
                    finalURL: url,
                    merged: merged,
                    error: error
                ))
            }
        }
    }

    private func firstValidMergedRecording(in candidates: [URL]) async -> URL? {
        for candidate in candidates {
            if await isValidMergedRecording(candidate) { return candidate }
        }
        return nil
    }

    private func firstReadableAudioRecording(in candidates: [URL]) async -> URL? {
        for candidate in candidates {
            if await hasReadableAudioRecording(candidate) { return candidate }
        }
        return nil
    }

    private func savePairToPhotosAsync(
        front: URL,
        rear: URL,
        capturedAt: Date
    ) async -> (Bool, String?) {
        await withCheckedContinuation { continuation in
            savePairToPhotos(front: front, rear: rear, capturedAt: capturedAt) { saved, error in
                continuation.resume(returning: (saved, error))
            }
        }
    }

    private func saveToPhotosAsync(
        _ url: URL,
        capturedAt: Date?
    ) async -> (Bool, String?) {
        await withCheckedContinuation { continuation in
            saveToPhotos(url, capturedAt: capturedAt) { saved, error in
                continuation.resume(returning: (saved, error))
            }
        }
    }

    private func prepareFinalRecordingAsync(
        videoURL: URL,
        audioURL: URL?
    ) async -> PreparedCameraRecording {
        await withCheckedContinuation { continuation in
            prepareFinalRecording(videoURL: videoURL, audioURL: audioURL) { url, merged, error in
                continuation.resume(returning: PreparedCameraRecording(
                    finalURL: url,
                    merged: merged,
                    error: error
                ))
            }
        }
    }

    private func hasReadableVideoRecording(_ url: URL) async -> Bool {
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        let asset = AVURLAsset(url: url)
        do {
            let duration = try await asset.load(.duration)
            let tracks = try await asset.loadTracks(withMediaType: .video)
            return duration.isValid && duration.seconds > 0 && !tracks.isEmpty
        } catch {
            return false
        }
    }

    /**
     * Les nouveaux segments utilisent un CAF PCM résistant à une extinction
     * avant fermeture du fichier. L'ancien AAC reste lisible afin de ne jamais
     * abandonner les captures créées par une version précédente.
    */
    private func sharedAudioURL(forVideo url: URL) -> URL {
        let base = dualCameraBaseName(for: url) ?? legacyRecordingBaseName(for: url)
        return preferredSharedAudioURL(
            baseName: base,
            directory: url.deletingLastPathComponent()
        )
    }

    private func sharedAudioSourceURLs(baseName: String, directory: URL) -> [URL] {
        [
            directory.appendingPathComponent("\(baseName).audio.caf"),
            directory.appendingPathComponent("\(baseName).audio.m4a"),
        ]
    }

    private func preferredSharedAudioURL(baseName: String, directory: URL) -> URL {
        let candidates = sharedAudioSourceURLs(baseName: baseName, directory: directory)
        return candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) })
            ?? candidates[0]
    }

    private func photoImportJournalURL(for videoURL: URL) -> URL? {
        guard let base = dualCameraBaseName(for: videoURL) else { return nil }
        return videoURL.deletingLastPathComponent().appendingPathComponent("\(base).photo-import.json")
    }

    private func writePhotoImportJournal(_ journal: PhotoImportJournal, to url: URL) throws {
        let data = try JSONEncoder().encode(journal)
        try data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUnlessOpen],
            ofItemAtPath: url.path
        )
    }

    private func readPhotoImportJournal(from url: URL) -> PhotoImportJournal? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(PhotoImportJournal.self, from: data)
    }

    private func photoImportConfirmationCount(_ journal: PhotoImportJournal) -> Int? {
        guard let front = journal.frontLocalIdentifier,
              let rear = journal.rearLocalIdentifier else { return nil }
        let authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard authorization == .authorized else { return nil }
        return PHAsset.fetchAssets(
            withLocalIdentifiers: [front, rear],
            options: nil
        ).count
    }

    private func photoAssetExists(_ localIdentifier: String?) -> Bool {
        guard let localIdentifier,
              PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized else {
            return false
        }
        return PHAsset.fetchAssets(
            withLocalIdentifiers: [localIdentifier],
            options: nil
        ).count == 1
    }

    private func captureDate(from url: URL) -> Date? {
        let name = url.lastPathComponent
        let pattern = #"prepatrack-(\d{8}-\d{6})-"#
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(
                  in: name,
                  range: NSRange(name.startIndex..., in: name)
              ),
              let range = Range(match.range(at: 1), in: name) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "fr_FR_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.date(from: String(name[range]))
    }

    private func captureProfilePayload() -> [String: Any] {
        let audioSession = AVAudioSession.sharedInstance()
        var result = videoPipeline.profilePayload()
        for (key, value) in videoPipeline.activeSegmentHealthPayload() {
            result[key] = value
        }
        result["preferredMicrophoneMode"] = microphoneModeName(AVCaptureDevice.preferredMicrophoneMode)
        result["activeMicrophoneMode"] = microphoneModeName(AVCaptureDevice.activeMicrophoneMode)
        result["audioChannels"] = audioSession.inputNumberOfChannels
        result["voiceProcessingEnabled"] = audioEngine.inputNode.isVoiceProcessingEnabled
        result["audioSessionCategory"] = audioSession.category.rawValue
        result["audioSessionMode"] = audioSession.mode.rawValue
        result["audioInputRoute"] = audioSession.currentRoute.inputs.first?.portName ?? "none"
        audioStateLock.lock()
        result["audioStorageContainer"] = "caf"
        result["audioStorageCodec"] = "linearPCM16"
        result["audioStorageSampleRate"] = 48_000
        result["audioCaptureConfirmed"] = audioCaptureConfirmed
        result["audioBuffersWritten"] = audioBuffersWritten
        result["audioFramesWritten"] = audioFramesWritten
        let captureURL = audioCaptureURL
        if let lastAudioBufferWrittenAt {
            result["lastAudioBufferAt"] = lastAudioBufferWrittenAt.timeIntervalSince1970 * 1_000
        }
        audioStateLock.unlock()
        if let captureURL {
            result["audioFileBytes"] = recordingFileSize(at: captureURL)
        }
        return result
    }

    private func microphoneModeName(_ mode: AVCaptureDevice.MicrophoneMode) -> String {
        switch mode {
        case .standard: return "standard"
        case .voiceIsolation: return "voiceIsolation"
        case .wideSpectrum: return "wideSpectrum"
        @unknown default: return "automatic"
        }
    }

    /** Configure la route qui permet à iOS de mémoriser un mode micro avant la capture. */
    private func prepareAudioSessionForMicrophoneModes() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .videoChat, options: [.defaultToSpeaker])
        try? session.setPreferredSampleRate(48_000)
        try? session.setPreferredInputNumberOfChannels(1)
    }

    private func activateVoiceProcessingInput() throws -> (AVAudioInputNode, AVAudioFormat) {
        try prepareAudioSessionForMicrophoneModes()
        let session = AVAudioSession.sharedInstance()
        try session.setActive(true)
        if let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
            try? session.setPreferredInput(builtIn)
            if let front = builtIn.dataSources?.first(where: { $0.orientation == .front }) {
                // Ne pas imposer de polar pattern : iOS doit pouvoir appliquer
                // Standard, Isolement de la voix ou Large spectre librement.
                try? builtIn.setPreferredDataSource(front)
            }
        }

        let input = audioEngine.inputNode
        try input.setVoiceProcessingEnabled(true)
        guard input.isVoiceProcessingEnabled else { throw RecordingError.voiceProcessingUnavailable }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw RecordingError.voiceProcessingUnavailable
        }
        return (input, format)
    }

    private func startMicrophoneModePreview() throws {
        microphoneModePreviewStop?.cancel()
        microphoneModePreviewStop = nil
        let (input, format) = try activateVoiceProcessingInput()
        guard input.isVoiceProcessingEnabled else { throw RecordingError.voiceProcessingUnavailable }
        input.installTap(onBus: 0, bufferSize: 2_048, format: format) { _, _ in }
        audioTapInstalled = true
        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            stopAudioCapture()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            throw error
        }

        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  self.activeSegment == nil else { return }
            self.stopAudioCapture()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        microphoneModePreviewStop = work
        sessionQueue.asyncAfter(deadline: .now() + 30, execute: work)
    }

    /**
     * Les modes micro Apple exigent Voice Processing I/O. Le moteur enregistre
     * donc la piste réellement traitée dans un CAF PCM linéaire. Contrairement
     * à un AAC/M4A qui doit finaliser son index, le CAF reste récupérable après
     * une extinction brutale, tandis que
     * le pipeline MultiCam conserve la vidéo stabilisée sans posséder le micro.
     */
    private func startAudioCapture(to url: URL, acceptImmediately: Bool = false) throws {
        stopAudioCapture()
        let (input, format) = try activateVoiceProcessingInput()
        let file = try makeAudioFile(at: url, format: format)
        audioStateLock.lock()
        audioFile = file
        audioCaptureFormat = format
        acceptsAudioBuffers = acceptImmediately
        audioWriteError = nil
        audioReadySignal = DispatchSemaphore(value: 0)
        audioCaptureConfirmed = false
        audioBuffersWritten = 0
        audioFramesWritten = 0
        audioCaptureStartedAt = Date()
        lastAudioBufferWrittenAt = nil
        audioCaptureURL = url
        audioStateLock.unlock()

        input.installTap(onBus: 0, bufferSize: 2_048, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.audioStateLock.lock()
            guard self.acceptsAudioBuffers, let target = self.audioFile else {
                self.audioStateLock.unlock()
                return
            }
            var readySignal: DispatchSemaphore?
            do {
                try target.write(from: buffer)
                self.audioBuffersWritten += 1
                self.audioFramesWritten += AVAudioFramePosition(buffer.frameLength)
                self.lastAudioBufferWrittenAt = Date()
                if !self.audioCaptureConfirmed,
                   self.audioBuffersWritten >= self.minimumConfirmedAudioBuffers,
                   target.length > 0 {
                    self.audioCaptureConfirmed = true
                    readySignal = self.audioReadySignal
                }
            } catch {
                if self.audioWriteError == nil { self.audioWriteError = error.localizedDescription }
            }
            self.audioStateLock.unlock()
            readySignal?.signal()
        }
        audioTapInstalled = true
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            stopAudioCapture()
            throw error
        }
    }

    private func makeAudioFile(at url: URL) throws -> AVAudioFile {
        audioStateLock.lock()
        let format = audioCaptureFormat
        audioStateLock.unlock()
        guard let format else { throw RecordingError.voiceProcessingUnavailable }
        return try makeAudioFile(at: url, format: format)
    }

    private func makeAudioFile(at url: URL, format: AVAudioFormat) throws -> AVAudioFile {
        guard abs(format.sampleRate - 48_000) < 1,
              format.channelCount == 1 else {
            throw RecordingError.unsupportedAudioFormat(
                sampleRate: format.sampleRate,
                channels: format.channelCount
            )
        }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let file = try AVAudioFile(
            forWriting: url,
            settings: settings,
            commonFormat: format.commonFormat,
            interleaved: format.isInterleaved
        )
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
        return file
    }

    private func swapAudioFile(with file: AVAudioFile) -> String? {
        audioStateLock.lock()
        let previousError = audioWriteError
        audioFile = file
        acceptsAudioBuffers = true
        audioWriteError = nil
        audioReadySignal = DispatchSemaphore(value: 0)
        audioCaptureConfirmed = false
        audioBuffersWritten = 0
        audioFramesWritten = 0
        audioCaptureStartedAt = Date()
        lastAudioBufferWrittenAt = nil
        audioCaptureURL = file.url
        audioStateLock.unlock()
        return previousError
    }

    private func stopAudioCapture() {
        disarmAudioHealthWatchdog()
        microphoneModePreviewStop?.cancel()
        microphoneModePreviewStop = nil
        audioStateLock.lock()
        acceptsAudioBuffers = false
        audioStateLock.unlock()
        if audioTapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioTapInstalled = false
        }
        if audioEngine.isRunning { audioEngine.stop() }
        audioStateLock.lock()
        audioFile = nil
        audioCaptureFormat = nil
        audioCaptureStartedAt = nil
        audioCaptureURL = nil
        audioStateLock.unlock()
        audioEngine.reset()
    }

    /** Attend une vraie écriture PCM, pas seulement un moteur AVAudioEngine actif. */
    private func waitUntilAudioHasData(timeout: TimeInterval) throws {
        audioStateLock.lock()
        let alreadyConfirmed = audioCaptureConfirmed
        let signal = audioReadySignal
        let initialError = audioWriteError
        audioStateLock.unlock()

        if let initialError { throw RecordingError.audioWriteFailed(initialError) }
        if !alreadyConfirmed,
           signal.wait(timeout: .now() + timeout) != .success {
            audioStateLock.lock()
            let error = audioWriteError
            let confirmed = audioCaptureConfirmed
            audioStateLock.unlock()
            if let error { throw RecordingError.audioWriteFailed(error) }
            guard confirmed else { throw RecordingError.audioCaptureTimedOut }
        }

        audioStateLock.lock()
        let confirmed = audioCaptureConfirmed
        let error = audioWriteError
        let frames = audioFramesWritten
        let captureURL = audioCaptureURL
        audioStateLock.unlock()
        if let error { throw RecordingError.audioWriteFailed(error) }
        let fileBytes = captureURL.map { recordingFileSize(at: $0) } ?? 0
        guard confirmed, frames > 0, fileBytes > 10_000 else {
            throw RecordingError.audioCaptureTimedOut
        }
    }

    private func armAudioHealthWatchdog() {
        disarmAudioHealthWatchdog()
        let timer = DispatchSource.makeTimerSource(queue: sessionQueue)
        timer.schedule(deadline: .now() + 2, repeating: 2, leeway: .milliseconds(250))
        timer.setEventHandler { [weak self] in self?.checkAudioCaptureHealth() }
        audioHealthTimer = timer
        timer.resume()
    }

    private func disarmAudioHealthWatchdog() {
        audioHealthTimer?.setEventHandler {}
        audioHealthTimer?.cancel()
        audioHealthTimer = nil
    }

    private func checkAudioCaptureHealth() {
        guard recordingRequested,
              !suspendedForInterruption,
              applicationIsActive,
              !audioInterruptionActive,
              activeSegment != nil else { return }
        audioStateLock.lock()
        let writeError = audioWriteError
        let captureStartedAt = audioCaptureStartedAt
        let lastWrite = lastAudioBufferWrittenAt
        audioStateLock.unlock()

        let healthReference = lastWrite ?? captureStartedAt
        let stalled = healthReference.map {
            Date().timeIntervalSince($0) > audioStallTimeoutSeconds
        } ?? false
        guard writeError != nil || stalled else { return }
        let message = writeError
            ?? "Aucun buffer microphone n'a été écrit depuis \(Int(audioStallTimeoutSeconds)) secondes."
        suspendedForInterruption = true
        finishActiveSegment(terminal: false, interrupted: true, forcedError: message)
        scheduleResumeRetry()
    }

    private func currentAudioWriteError() -> String? {
        audioStateLock.lock()
        defer { audioStateLock.unlock() }
        return audioWriteError
    }

    /** Réunit sans réencodage la vidéo stabilisée et l'audio Voice Processing. */
    private func prepareFinalRecording(
        videoURL: URL,
        audioURL: URL?,
        completion: @escaping (URL, Bool, String?) -> Void
    ) {
        let stem = videoURL.deletingPathExtension().lastPathComponent
        let baseName = stem.hasSuffix(".video") ? String(stem.dropLast(".video".count)) : stem
        let finalURL = videoURL.deletingLastPathComponent().appendingPathComponent("\(baseName).mov")
        let mergingURL = videoURL.deletingLastPathComponent().appendingPathComponent("\(baseName).merging.mov")

        Task {
            // Un export peut avoir terminé juste avant une extinction, sans que
            // son callback ait eu le temps de le promouvoir. Ne jamais l'écraser
            // s'il contient déjà les deux pistes valides.
            if await self.isValidMergedRecording(mergingURL) {
                completion(mergingURL, true, nil)
                return
            }
            guard let audioURL,
                  FileManager.default.fileExists(atPath: audioURL.path) else {
                completion(videoURL, false, "La piste audio Voice Processing est absente; la vidéo seule a été conservée.")
                return
            }
            do {
                let videoAsset = AVURLAsset(url: videoURL)
                let audioAsset = AVURLAsset(url: audioURL)
                guard let sourceVideo = try await videoAsset.loadTracks(withMediaType: .video).first,
                      let sourceAudio = try await audioAsset.loadTracks(withMediaType: .audio).first else {
                    completion(videoURL, false, "La piste audio ou vidéo est illisible; la vidéo source a été conservée.")
                    return
                }
                let videoDuration = try await videoAsset.load(.duration)
                let audioDuration = try await audioAsset.load(.duration)
                guard videoDuration.isValid, videoDuration.seconds > 0,
                      audioDuration.isValid, audioDuration.seconds > 0 else {
                    completion(videoURL, false, "La piste audio ou vidéo est vide; la vidéo source a été conservée.")
                    return
                }
                let durationDifference = audioDuration.seconds - videoDuration.seconds
                guard durationDifference <= 3 else {
                    // Une piste audio nettement plus longue prouve que le writer
                    // vidéo s'est figé. La tronquer puis supprimer les sources
                    // ferait passer une capture partielle pour une sauvegarde.
                    completion(
                        videoURL,
                        false,
                        "La vidéo s'est interrompue avant l'audio; toutes les sources ont été conservées pour récupération."
                    )
                    return
                }
                let durationWarning = durationDifference < -3
                    ? "La piste audio était plus courte que la vidéo; la fin reste silencieuse mais la vidéo complète a été sauvegardée."
                    : nil

                let composition = AVMutableComposition()
                guard let targetVideo = composition.addMutableTrack(
                    withMediaType: .video,
                    preferredTrackID: kCMPersistentTrackID_Invalid
                ), let targetAudio = composition.addMutableTrack(
                    withMediaType: .audio,
                    preferredTrackID: kCMPersistentTrackID_Invalid
                ) else {
                    completion(videoURL, false, "Impossible de préparer les pistes finales; la vidéo source a été conservée.")
                    return
                }
                try targetVideo.insertTimeRange(
                    CMTimeRange(start: .zero, duration: videoDuration),
                    of: sourceVideo,
                    at: .zero
                )
                targetVideo.preferredTransform = try await sourceVideo.load(.preferredTransform)
                let audioRangeDuration = CMTimeCompare(audioDuration, videoDuration) > 0
                    ? videoDuration
                    : audioDuration
                try targetAudio.insertTimeRange(
                    CMTimeRange(start: .zero, duration: audioRangeDuration),
                    of: sourceAudio,
                    at: .zero
                )
                if CMTimeCompare(audioRangeDuration, videoDuration) < 0 {
                    // Une interruption brutale peut fermer l'audio avant le
                    // writer vidéo. Prolonger la piste par du silence conserve
                    // toutes les images et évite une récupération bloquée à
                    // chaque lancement.
                    targetAudio.insertEmptyTimeRange(CMTimeRange(
                        start: audioRangeDuration,
                        duration: CMTimeSubtract(videoDuration, audioRangeDuration)
                    ))
                }

                guard let export = AVAssetExportSession(
                    asset: composition,
                    presetName: AVAssetExportPresetPassthrough
                ) else {
                    completion(videoURL, false, "Impossible de finaliser la vidéo; les sources ont été conservées.")
                    return
                }
                if FileManager.default.fileExists(atPath: mergingURL.path) {
                    try FileManager.default.removeItem(at: mergingURL)
                }
                // Écrire dans un nom non final : si iOS tue l'app pendant
                // l'export, ce fichier partiel ne pourra jamais masquer les
                // sources au prochain lancement.
                export.outputURL = mergingURL
                export.outputFileType = .mov
                export.shouldOptimizeForNetworkUse = false
                export.exportAsynchronously {
                    if export.status == .completed,
                       FileManager.default.fileExists(atPath: mergingURL.path) {
                        Task {
                            guard await self.isValidMergedRecording(mergingURL) else {
                                try? FileManager.default.removeItem(at: mergingURL)
                                completion(videoURL, false, "La vidéo fusionnée est incomplète; les sources ont été conservées.")
                                return
                            }
                            do {
                                if FileManager.default.fileExists(atPath: finalURL.path) {
                                    try FileManager.default.removeItem(at: finalURL)
                                }
                                try FileManager.default.moveItem(at: mergingURL, to: finalURL)
                                completion(finalURL, true, durationWarning)
                            } catch {
                                completion(videoURL, false, error.localizedDescription)
                            }
                        }
                    } else {
                        try? FileManager.default.removeItem(at: mergingURL)
                        completion(
                            videoURL,
                            false,
                            export.error?.localizedDescription
                                ?? "La fusion audio/vidéo a échoué; les sources ont été conservées."
                        )
                    }
                }
            } catch {
                completion(videoURL, false, error.localizedDescription)
            }
        }
    }

    /** Un nom final n'est reconnu qu'après validation des deux pistes. */
    private func isValidMergedRecording(_ url: URL) async -> Bool {
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        let asset = AVURLAsset(url: url)
        do {
            let duration = try await asset.load(.duration)
            let videos = try await asset.loadTracks(withMediaType: .video)
            let audios = try await asset.loadTracks(withMediaType: .audio)
            guard duration.isValid, duration.seconds > 0,
                  let video = videos.first,
                  let audio = audios.first else { return false }
            let videoRange = try await video.load(.timeRange)
            let audioRange = try await audio.load(.timeRange)
            return abs(videoRange.duration.seconds - audioRange.duration.seconds) <= 3
        } catch {
            return false
        }
    }

    private func hasReadableAudioRecording(_ url: URL) async -> Bool {
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        if url.pathExtension.lowercased() == "caf",
           let file = try? AVAudioFile(forReading: url),
           file.length > 0,
           file.fileFormat.sampleRate > 0,
           file.fileFormat.channelCount > 0 {
            // AVAudioFile sait relire directement un CAF PCM dont l'application
            // n'a pas eu le temps de finaliser la fermeture après un crash.
            return true
        }
        let asset = AVURLAsset(url: url)
        do {
            let duration = try await asset.load(.duration)
            let tracks = try await asset.loadTracks(withMediaType: .audio)
            return duration.isValid && duration.seconds > 0 && !tracks.isEmpty
        } catch {
            return false
        }
    }

    private func requestPermissions(completion: @escaping (Bool) -> Void) {
        let group = DispatchGroup()
        var camera = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
        var microphone = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            group.enter(); AVCaptureDevice.requestAccess(for: .video) { camera = $0; group.leave() }
        }
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            group.enter(); AVCaptureDevice.requestAccess(for: .audio) { microphone = $0; group.leave() }
        }
        if PHPhotoLibrary.authorizationStatus(for: .addOnly) == .notDetermined {
            group.enter(); PHPhotoLibrary.requestAuthorization(for: .addOnly) { _ in
                group.leave()
            }
        }
        // Refuser Photos ne doit jamais empêcher de filmer : les sources
        // restent alors dans Application Support et le bouton de récupération
        // permettra l'import dès que l'autorisation sera accordée.
        group.notify(queue: .main) { completion(camera && microphone) }
    }
}

private enum RecordingError: LocalizedError {
    case deviceUnavailable
    case configurationFailed
    case stabilizationUnavailable
    case voiceProcessingUnavailable
    case unsupportedAudioFormat(sampleRate: Double, channels: AVAudioChannelCount)
    case audioCaptureTimedOut
    case audioWriteFailed(String)
    case videoCaptureTimedOut(String)
    case insufficientStorage
    case testUnavailableWhileRecording
    case recoveryInProgress
    var errorDescription: String? {
        switch self {
        case .deviceUnavailable: return "Caméra avant ou microphone introuvable."
        case .configurationFailed: return "Impossible de configurer la capture vidéo."
        case .stabilizationUnavailable: return "iOS n’a pas activé la stabilisation vidéo sur ce profil."
        case .voiceProcessingUnavailable: return "iOS n’a pas activé le traitement vocal requis pour les modes micro."
        case .unsupportedAudioFormat(let sampleRate, let channels):
            return "Le microphone n'a pas fourni le format fiable requis (\(Int(sampleRate)) Hz, \(channels) canal/canaux au lieu de 48 000 Hz mono)."
        case .audioCaptureTimedOut:
            return "Le microphone n'a produit aucun fichier audio confirmé. Les sources déjà écrites restent conservées."
        case .audioWriteFailed(let message):
            return "L'écriture audio a échoué (\(message)). Toutes les sources restent conservées."
        case .videoCaptureTimedOut(let details):
            return "Les deux caméras n'ont pas produit de fragments vidéo confirmés (\(details)). Toutes les sources restent conservées."
        case .insufficientStorage:
            return "Moins de 5 Go sont disponibles. L’enregistrement a été arrêté proprement pour conserver les vidéos existantes."
        case .testUnavailableWhileRecording:
            return "Arrête l’enregistrement en cours avant de tester les caméras et le microphone."
        case .recoveryInProgress:
            return "La récupération des vidéos locales est en cours. Attends sa fin avant de démarrer une nouvelle capture."
        }
    }
}

private struct NativeRecordingSegment {
    let id: UUID
    let startedAt: Date
    let frontVideoURL: URL
    let rearVideoURL: URL
    let audioURL: URL
}

private struct PreparedCameraRecording {
    let finalURL: URL
    let merged: Bool
    let error: String?
}

private struct PhotoImportJournal: Codable {
    let state: String
    let createdAt: Date
    let frontLocalIdentifier: String?
    let rearLocalIdentifier: String?
}

private struct RecordingRecoverySnapshot {
    let finalVideos: [URL]
    let rawVideos: [URL]
    let mergingVideos: [URL]
    let temporaryVideos: [URL]
    let dualBases: Set<String>
    let pending: Int
}

private struct RecordingRecoverySummary {
    let pending: Int
    let recovered: Int
    let retained: Int
    let error: String?
}

private struct DualCameraRecoveryOutcome {
    let recovered: Int
    let retained: Int
    let error: String?
    let capturedAt: Date?
}
