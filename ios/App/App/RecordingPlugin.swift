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
    private var terminalStopPending = false
    private var terminalHadSegments = false
    private var terminalAllSaved = true
    private var terminalRetained = false
    private var terminalError: String?
    private var terminalStartedAt: Date?
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
        recoverPendingRecordings()
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

    @objc private func applicationDidEnterBackground() {
        sessionQueue.async {
            self.applicationIsActive = false
            self.cancelResumeRetry()
            guard self.recordingRequested else { return }
            self.suspendedForInterruption = true
            self.finishActiveSegment(terminal: false, interrupted: true)
        }
    }

    @objc private func applicationDidBecomeActive() {
        sessionQueue.async {
            self.applicationIsActive = true
            // Certaines suspensions iOS ne livrent pas le callback `.ended`.
            // Une nouvelle activation confirme que l'app peut retenter la route.
            self.audioInterruptionActive = false
            self.cancelResumeRetry()
            self.resumeRecordingIfNeeded()
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
                call.reject("Autorise la caméra, le microphone et l’ajout à Photos dans Réglages iOS.")
                return
            }
            self.sessionQueue.async {
                do {
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
                call.reject("Permissions caméra, microphone ou Photos refusées.")
                return
            }
            self.sessionQueue.async {
                do {
                    try self.videoPipeline.configureIfNeeded()
                    let testURL = FileManager.default.temporaryDirectory
                        .appendingPathComponent("prepatrack-audio-test-\(UUID().uuidString).m4a")
                    try self.startAudioCapture(to: testURL, acceptImmediately: true)
                    Thread.sleep(forTimeInterval: 0.35)
                    self.stopAudioCapture()
                    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                    let size = ((try? testURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
                    try? FileManager.default.removeItem(at: testURL)
                    guard size > 1_024 else { throw RecordingError.voiceProcessingUnavailable }
                    DispatchQueue.main.async {
                        call.resolve(["captureProfile": self.captureProfilePayload()])
                    }
                } catch {
                    DispatchQueue.main.async { call.reject(error.localizedDescription) }
                }
            }
        }
    }

    /** Démarre un nouveau segment sans dépendre des imports Photos précédents. */
    private func startCapture() throws -> Date {
        try ensureRecordingSpaceAvailable()
        let segment = makeSegment(startedAt: Date())
        audioWriteError = nil
        do {
            try videoPipeline.configureIfNeeded()
            try videoPipeline.startSession()
            try startAudioCapture(to: segment.audioURL, acceptImmediately: true)
            try videoPipeline.startSegment(
                frontURL: segment.frontVideoURL,
                rearURL: segment.rearVideoURL,
                id: segment.id,
                startedAt: segment.startedAt,
                maxDurationSeconds: segmentDurationSeconds
            )
        } catch {
            stopAudioCapture()
            videoPipeline.stopSession()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            try? FileManager.default.removeItem(at: segment.frontVideoURL)
            try? FileManager.default.removeItem(at: segment.rearVideoURL)
            try? FileManager.default.removeItem(at: segment.audioURL)
            throw error
        }
        activeSegment = segment
        startedAt = segment.startedAt
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
            audioWriteError = nil
            rotationInProgress = false
            scheduleSegmentTimer()
            DispatchQueue.main.async {
                self.notifyListeners("recordingResumed", data: [
                    "startedAt": next.startedAt.timeIntervalSince1970 * 1_000,
                    "rotated": true,
                ])
            }
        } catch {
            finalizingSegmentIDs.remove(previous.id)
            rotationInProgress = false
            recordingRequested = false
            suspendedForInterruption = false
            beginTerminalStop(startedAt: previous.startedAt)
            finishActiveSegment(terminal: true, interrupted: false, forcedError: error.localizedDescription)
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
            for url in unique where !url.lastPathComponent.hasSuffix(".photo-import.json") {
                try? FileManager.default.removeItem(at: url)
            }
            for url in unique where url.lastPathComponent.hasSuffix(".photo-import.json") {
                try? FileManager.default.removeItem(at: url)
            }
        }
        sessionQueue.async {
            self.finalizingSegmentIDs.remove(segment.id)
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
        }
    }

    private func registerFinalization(_ segment: NativeRecordingSegment) {
        finalizingSegmentIDs.insert(segment.id)
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
            audioURL: recordingsDirectory.appendingPathComponent("\(baseName).audio.m4a")
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
            if !saved { try? FileManager.default.removeItem(at: journalURL) }
            completion(saved, error?.localizedDescription)
        }
    }

    /** Prépare en parallèle les deux vidéos qui partagent la même piste audio. */
    private func prepareDualFinalRecordings(
        videos: DualCameraSegmentFiles,
        audioURL: URL,
        completion: @escaping (PreparedCameraRecording, PreparedCameraRecording) -> Void
    ) {
        let group = DispatchGroup()
        let lock = NSLock()
        var front: PreparedCameraRecording?
        var rear: PreparedCameraRecording?

        group.enter()
        prepareFinalRecording(videoURL: videos.frontURL, audioURL: audioURL) { url, merged, error in
            lock.lock()
            front = PreparedCameraRecording(finalURL: url, merged: merged, error: error)
            lock.unlock()
            group.leave()
        }
        group.enter()
        prepareFinalRecording(videoURL: videos.rearURL, audioURL: audioURL) { url, merged, error in
            lock.lock()
            rear = PreparedCameraRecording(finalURL: url, merged: merged, error: error)
            lock.unlock()
            group.leave()
        }
        group.notify(queue: sessionQueue) {
            completion(
                front ?? PreparedCameraRecording(
                    finalURL: videos.frontURL,
                    merged: false,
                    error: "La vidéo avant n'a pas pu être finalisée."
                ),
                rear ?? PreparedCameraRecording(
                    finalURL: videos.rearURL,
                    merged: false,
                    error: "La vidéo arrière n'a pas pu être finalisée."
                )
            )
        }
    }

    /**
     * Récupère les captures abandonnées par une extinction, un crash ou une
     * ancienne version. Le dossier temporaire est aussi inspecté pour sauver
     * les fichiers laissés par les builds précédentes.
     */
    private func recoverPendingRecordings() {
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
        guard !finalVideos.isEmpty || !rawVideos.isEmpty || !mergingVideos.isEmpty || !temporary.isEmpty else { return }

        let importFiles = { [weak self] in
            guard let self else { return }
            let notify: (Bool, String?, Date?) -> Void = { saved, error, capturedAt in
                DispatchQueue.main.async {
                    var payload: [String: Any] = ["saved": saved, "recovered": true]
                    if let error { payload["error"] = error }
                    if let capturedAt {
                        payload["startedAt"] = capturedAt.timeIntervalSince1970 * 1_000
                    }
                    self.notifyListeners("recordingSegmentFinished", data: payload)
                }
            }
            let importVideo: (URL, [URL], String?) -> Void = { url, cleanup, earlierError in
                let capturedAt = self.captureDate(from: url)
                self.saveToPhotos(url, capturedAt: capturedAt) { saved, error in
                    if saved {
                        for candidate in Set(cleanup) { try? manager.removeItem(at: candidate) }
                    }
                    notify(saved, error ?? earlierError, capturedAt)
                }
            }

            Task {
                let dualBases = Set(
                    (finalVideos + rawVideos + mergingVideos)
                        .compactMap { self.dualCameraBaseName(for: $0) }
                )
                for base in dualBases.sorted() {
                    await self.recoverDualCameraPair(baseName: base, notify: notify)
                }

                var validFinalNames = Set<String>()
                for url in finalVideos where !self.isDualCameraVideo(url) {
                    let base = url.deletingPathExtension().lastPathComponent
                    let raw = url.deletingLastPathComponent().appendingPathComponent("\(base).video.mov")
                    let audio = self.sharedAudioURL(forVideo: url)
                    if await self.isValidMergedRecording(url) {
                        validFinalNames.insert(base)
                        let cleanup = self.isDualCameraVideo(url) ? [url, raw] : [url, raw, audio]
                        importVideo(url, cleanup, nil)
                    } else if manager.fileExists(atPath: raw.path) {
                        // Un ancien export interrompu ne doit jamais masquer les
                        // sources valides ni bloquer toutes les reprises suivantes.
                        try? manager.removeItem(at: url)
                    } else {
                        notify(false, "Une vidéo finale incomplète a été conservée pour diagnostic.", self.captureDate(from: url))
                    }
                }
                for partial in mergingVideos where !self.isDualCameraVideo(partial) {
                    let base = partial.lastPathComponent.replacingOccurrences(of: ".merging.mov", with: "")
                    let raw = partial.deletingLastPathComponent().appendingPathComponent("\(base).video.mov")
                    if manager.fileExists(atPath: raw.path) { try? manager.removeItem(at: partial) }
                }
                for videoURL in rawVideos where !self.isDualCameraVideo(videoURL) {
                    let videoStem = videoURL.deletingPathExtension().lastPathComponent
                    let base = videoStem.hasSuffix(".video")
                        ? String(videoStem.dropLast(".video".count))
                        : videoStem
                    guard !validFinalNames.contains(base) else { continue }
                    let audioURL = self.sharedAudioURL(forVideo: videoURL)
                    self.prepareFinalRecording(videoURL: videoURL, audioURL: audioURL) { finalURL, merged, mergeError in
                        guard merged else {
                            Task {
                                if await self.hasReadableAudioRecording(audioURL) {
                                    // Les deux sources restent associées dans le dossier
                                    // durable; une prochaine ouverture retentera la fusion.
                                    notify(false, mergeError ?? "La récupération audio/vidéo sera retentée.", self.captureDate(from: videoURL))
                                } else {
                                    // Après une extinction brutale, le conteneur AAC peut
                                    // être irrécupérable alors que la vidéo fragmentée reste
                                    // lisible. Sauver la vidéo muette dans Photos vaut mieux
                                    // que la laisser invisible indéfiniment.
                                    importVideo(
                                        videoURL,
                                        [videoURL, audioURL],
                                        "La piste audio était irrécupérable; la vidéo a été sauvée sans son."
                                    )
                                }
                            }
                            return
                        }
                        let cleanup = self.isDualCameraVideo(videoURL)
                            ? [videoURL, finalURL]
                            : [videoURL, audioURL, finalURL]
                        importVideo(finalURL, cleanup, mergeError)
                    }
                }
                for url in temporary { importVideo(url, [url], nil) }
            }
        }
        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if status == .authorized || status == .limited {
            importFiles()
        } else if status == .notDetermined {
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { next in
                if next == .authorized || next == .limited { importFiles() }
            }
        }
        // En cas de refus, les fichiers restent intacts pour une prochaine
        // ouverture après réactivation de l'autorisation dans Réglages iOS.
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
        ] where name.hasSuffix(suffix) {
            return String(name.dropLast(suffix.count))
        }
        return nil
    }

    /**
     * Récupère un segment double caméra comme une unité atomique. Les sources
     * et la piste audio partagée ne sont supprimées qu'après l'ajout confirmé
     * des deux angles dans Photos.
     */
    private func recoverDualCameraPair(
        baseName: String,
        notify: @escaping (Bool, String?, Date?) -> Void
    ) async {
        let directory = recordingsDirectory
        let frontRaw = directory.appendingPathComponent("\(baseName).front.video.mov")
        let rearRaw = directory.appendingPathComponent("\(baseName).rear.video.mov")
        let frontFinal = directory.appendingPathComponent("\(baseName).front.mov")
        let rearFinal = directory.appendingPathComponent("\(baseName).rear.mov")
        let frontMerging = directory.appendingPathComponent("\(baseName).front.merging.mov")
        let rearMerging = directory.appendingPathComponent("\(baseName).rear.merging.mov")
        let audio = directory.appendingPathComponent("\(baseName).audio.m4a")
        let manager = FileManager.default
        let capturedAt = captureDate(from: frontRaw)
        let journalURL = directory.appendingPathComponent("\(baseName).photo-import.json")

        if manager.fileExists(atPath: journalURL.path) {
            if let journal = readPhotoImportJournal(from: journalURL),
               photoImportIsConfirmed(journal) {
                for url in [
                    frontRaw,
                    rearRaw,
                    frontFinal,
                    rearFinal,
                    frontMerging,
                    rearMerging,
                    audio,
                    journalURL,
                ] {
                    try? manager.removeItem(at: url)
                }
                notify(true, "Les deux vidéos déjà ajoutées à Photos ont été confirmées après l'interruption.", capturedAt)
            } else {
                notify(
                    false,
                    "L'import Photos précédent a été interrompu dans un état ambigu. Les sources sont conservées sans créer de doublon.",
                    capturedAt
                )
            }
            return
        }

        if manager.fileExists(atPath: frontRaw.path) { try? manager.removeItem(at: frontMerging) }
        if manager.fileExists(atPath: rearRaw.path) { try? manager.removeItem(at: rearMerging) }

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
                audio,
                journalURL,
            ] + savedURLs
            let unique = Set(cleanup)
            for url in unique where !url.lastPathComponent.hasSuffix(".photo-import.json") {
                try? manager.removeItem(at: url)
            }
            try? manager.removeItem(at: journalURL)
        }
        notify(saved, error, capturedAt)
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

    /** Les deux angles d'un segment partagent exactement le même fichier AAC. */
    private func sharedAudioURL(forVideo url: URL) -> URL {
        var base = url.lastPathComponent
        for suffix in [".front.video.mov", ".rear.video.mov", ".front.mov", ".rear.mov"] {
            if base.hasSuffix(suffix) {
                base = String(base.dropLast(suffix.count))
                return url.deletingLastPathComponent().appendingPathComponent("\(base).audio.m4a")
            }
        }
        let stem = url.deletingPathExtension().lastPathComponent
        let legacyBase = stem.hasSuffix(".video")
            ? String(stem.dropLast(".video".count))
            : stem
        return url.deletingLastPathComponent().appendingPathComponent("\(legacyBase).audio.m4a")
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

    private func photoImportIsConfirmed(_ journal: PhotoImportJournal) -> Bool {
        guard let front = journal.frontLocalIdentifier,
              let rear = journal.rearLocalIdentifier else { return false }
        let authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard authorization == .authorized || authorization == .limited else { return false }
        return PHAsset.fetchAssets(
            withLocalIdentifiers: [front, rear],
            options: nil
        ).count == 2
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
        result["preferredMicrophoneMode"] = microphoneModeName(AVCaptureDevice.preferredMicrophoneMode)
        result["activeMicrophoneMode"] = microphoneModeName(AVCaptureDevice.activeMicrophoneMode)
        result["audioChannels"] = audioSession.inputNumberOfChannels
        result["voiceProcessingEnabled"] = audioEngine.inputNode.isVoiceProcessingEnabled
        result["audioSessionCategory"] = audioSession.category.rawValue
        result["audioSessionMode"] = audioSession.mode.rawValue
        result["audioInputRoute"] = audioSession.currentRoute.inputs.first?.portName ?? "none"
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
     * donc la piste réellement traitée dans un fichier AAC durable, tandis que
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
        audioStateLock.unlock()

        input.installTap(onBus: 0, bufferSize: 2_048, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.audioStateLock.lock()
            defer { self.audioStateLock.unlock() }
            guard self.acceptsAudioBuffers, let target = self.audioFile else { return }
            do {
                try target.write(from: buffer)
            } catch {
                if self.audioWriteError == nil { self.audioWriteError = error.localizedDescription }
            }
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
        let channels = Int(format.channelCount)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: channels >= 2 ? 256_000 : 160_000,
            AVEncoderAudioQualityKey: AVAudioQuality.max.rawValue,
        ]
        return try AVAudioFile(
            forWriting: url,
            settings: settings,
            commonFormat: format.commonFormat,
            interleaved: format.isInterleaved
        )
    }

    private func swapAudioFile(with file: AVAudioFile) -> String? {
        audioStateLock.lock()
        let previousError = audioWriteError
        audioFile = file
        acceptsAudioBuffers = true
        audioWriteError = nil
        audioStateLock.unlock()
        return previousError
    }

    private func stopAudioCapture() {
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
        audioStateLock.unlock()
        audioEngine.reset()
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
        guard let audioURL,
              FileManager.default.fileExists(atPath: audioURL.path) else {
            completion(videoURL, false, "La piste audio Voice Processing est absente; la vidéo seule a été conservée.")
            return
        }
        let stem = videoURL.deletingPathExtension().lastPathComponent
        let baseName = stem.hasSuffix(".video") ? String(stem.dropLast(".video".count)) : stem
        let finalURL = videoURL.deletingLastPathComponent().appendingPathComponent("\(baseName).mov")
        let mergingURL = videoURL.deletingLastPathComponent().appendingPathComponent("\(baseName).merging.mov")

        Task {
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
                let durationWarning = abs(videoDuration.seconds - audioDuration.seconds) > 3
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
        let initialPhotos = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        var photos = initialPhotos == .authorized || initialPhotos == .limited
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            group.enter(); AVCaptureDevice.requestAccess(for: .video) { camera = $0; group.leave() }
        }
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            group.enter(); AVCaptureDevice.requestAccess(for: .audio) { microphone = $0; group.leave() }
        }
        if PHPhotoLibrary.authorizationStatus(for: .addOnly) == .notDetermined {
            group.enter(); PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                photos = status == .authorized || status == .limited
                group.leave()
            }
        }
        group.notify(queue: .main) { completion(camera && microphone && photos) }
    }
}

private enum RecordingError: LocalizedError {
    case deviceUnavailable
    case configurationFailed
    case stabilizationUnavailable
    case voiceProcessingUnavailable
    case insufficientStorage
    var errorDescription: String? {
        switch self {
        case .deviceUnavailable: return "Caméra avant ou microphone introuvable."
        case .configurationFailed: return "Impossible de configurer la capture vidéo."
        case .stabilizationUnavailable: return "iOS n’a pas activé la stabilisation vidéo sur ce profil."
        case .voiceProcessingUnavailable: return "iOS n’a pas activé le traitement vocal requis pour les modes micro."
        case .insufficientStorage:
            return "Moins de 5 Go sont disponibles. L’enregistrement a été arrêté proprement pour conserver les vidéos existantes."
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
