import AVFoundation
import AVFAudio
import Capacitor
import Photos

@objc(RecordingPlugin)
public final class RecordingPlugin: CAPPlugin, CAPBridgedPlugin, AVCaptureFileOutputRecordingDelegate {
    public let identifier = "RecordingPlugin"
    public let jsName = "NativeRecording"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "test", returnType: CAPPluginReturnPromise),
    ]

    private let captureSession = AVCaptureSession()
    private let movieOutput = AVCaptureMovieFileOutput()
    private let sessionQueue = DispatchQueue(label: "com.n0thytvoff.prepatrack.recording")
    private var configured = false
    private var startedAt: Date?
    private var currentURL: URL?
    private var stopCalls: [CAPPluginCall] = []
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var pendingPhotoOperations = 0
    /** Des fichiers courts limitent la perte maximale après un crash brutal. */
    private var segmentDurationSeconds: Double = 10 * 60
    // L'intention utilisateur reste active quand iOS coupe matériellement la
    // caméra au verrouillage. Elle permet une reprise dans un nouveau fichier.
    private var recordingRequested = false
    private var suspendedForBackground = false
    private var applicationIsActive = true

    public override func load() {
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
            selector: #selector(applicationWillTerminate),
            name: UIApplication.willTerminateNotification,
            object: nil
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
        beginBackgroundFinalization()
        sessionQueue.async {
            self.applicationIsActive = false
            guard self.recordingRequested ||
                    self.movieOutput.isRecording ||
                    self.currentURL != nil ||
                    self.pendingPhotoOperations > 0 else {
                self.endBackgroundFinalization()
                return
            }
            guard self.recordingRequested else { return }
            self.suspendedForBackground = true
            if self.movieOutput.isRecording { self.movieOutput.stopRecording() }
        }
    }

    @objc private func applicationWillTerminate() {
        beginBackgroundFinalization()
        sessionQueue.async {
            guard self.recordingRequested ||
                    self.movieOutput.isRecording ||
                    self.currentURL != nil ||
                    self.pendingPhotoOperations > 0 else {
                self.endBackgroundFinalization()
                return
            }
            guard self.recordingRequested else { return }
            self.suspendedForBackground = true
            if self.movieOutput.isRecording { self.movieOutput.stopRecording() }
        }
    }

    @objc private func applicationDidBecomeActive() {
        sessionQueue.async {
            self.applicationIsActive = true
            self.resumeRecordingIfNeeded()
        }
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
                    let requestedDuration = Double(call.getInt("maxDurationSeconds") ?? 600)
                    self.segmentDurationSeconds = min(600, max(60, requestedDuration))
                    self.recordingRequested = true
                    self.suspendedForBackground = false
                    guard !self.movieOutput.isRecording else {
                        DispatchQueue.main.async {
                            call.resolve(["startedAt": (self.startedAt ?? Date()).timeIntervalSince1970 * 1_000])
                        }
                        return
                    }
                    let startedAt = try self.startCapture()
                    DispatchQueue.main.async {
                        UIApplication.shared.isIdleTimerDisabled = true
                        call.resolve(["startedAt": startedAt.timeIntervalSince1970 * 1_000])
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
            self.suspendedForBackground = false
            guard self.movieOutput.isRecording else {
                if self.currentURL != nil {
                    // AVFoundation termine encore le conteneur local. L'appel
                    // sera libéré dès que le MOV durable sera exploitable.
                    self.stopCalls.append(call)
                    return
                }
                DispatchQueue.main.async { call.resolve(["saved": false]) }
                return
            }
            self.stopCalls.append(call)
            self.movieOutput.stopRecording()
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        sessionQueue.async {
            var result: [String: Any] = ["recording": self.movieOutput.isRecording]
            if let startedAt = self.startedAt {
                result["startedAt"] = startedAt.timeIntervalSince1970 * 1_000
            }
            DispatchQueue.main.async { call.resolve(result) }
        }
    }

    @objc func test(_ call: CAPPluginCall) {
        requestPermissions { granted in
            granted ? call.resolve() : call.reject("Permissions caméra, microphone ou Photos refusées.")
        }
    }

    public func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        let successfullyFinished = (error as NSError?)?
            .userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? (error == nil)
        sessionQueue.async {
            guard FileManager.default.fileExists(atPath: outputFileURL.path) else {
                self.finishWithoutFile(error?.localizedDescription ?? "Enregistrement interrompu")
                return
            }

            let nsError = error as NSError?
            let reachedDurationLimit =
                nsError?.domain == AVFoundationErrorDomain &&
                nsError?.code == AVError.Code.maximumDurationReached.rawValue
            let shouldRotate =
                reachedDurationLimit &&
                self.recordingRequested &&
                !self.suspendedForBackground &&
                self.applicationIsActive

            self.currentURL = nil
            let calls = self.stopCalls
            self.stopCalls.removeAll()

            var continues = false
            var rotationError: String?
            if shouldRotate {
                do {
                    _ = try self.startCapture(preserveSessionStart: true)
                    continues = true
                } catch {
                    self.recordingRequested = false
                    rotationError = error.localizedDescription
                }
            }

            if !continues {
                self.captureSession.stopRunning()
                try? AVAudioSession.sharedInstance().setActive(
                    false,
                    options: .notifyOthersOnDeactivation
                )
                self.startedAt = nil
            }

            // Le fichier MOV est maintenant finalisé dans Application Support :
            // l'arrêt utilisateur n'attend plus le lent import dans Photos.
            // Même si iOS suspend l'app juste après, ce fichier sera récupéré au
            // prochain lancement.
            DispatchQueue.main.async {
                UIApplication.shared.isIdleTimerDisabled = continues
                let securedPayload: [String: Any] = [
                    "saved": false,
                    "pending": true,
                ]
                calls.forEach { $0.resolve(securedPayload) }
            }

            let originalError =
                rotationError ??
                (!successfullyFinished && !reachedDurationLimit ? error?.localizedDescription : nil)
            self.pendingPhotoOperations += 1
            self.prepareForPhotos(outputFileURL) { [weak self] preparedURL, preparationError in
                guard let self else { return }
                self.saveToPhotos(preparedURL) { saved, photoError in
                    self.sessionQueue.async {
                        if saved {
                            try? FileManager.default.removeItem(at: outputFileURL)
                            if preparedURL != outputFileURL {
                                try? FileManager.default.removeItem(at: preparedURL)
                            }
                        } else if preparedURL != outputFileURL {
                            try? FileManager.default.removeItem(at: preparedURL)
                        }

                        // À la jonction automatique, AVCaptureMovieFileOutput
                        // reste brièvement inactif entre deux fichiers. C'est
                        // l'intention utilisateur et le cycle de vie qui font
                        // foi, sinon un ancien import ferait clignoter l'UI à
                        // tort sur « arrêté » pendant cette fenêtre.
                        let isRecording =
                            self.recordingRequested &&
                            self.applicationIsActive &&
                            !self.suspendedForBackground
                        let willResume =
                            self.recordingRequested &&
                            self.suspendedForBackground &&
                            !isRecording
                        let reason = photoError ?? preparationError ?? originalError
                        DispatchQueue.main.async {
                            var payload: [String: Any] = [
                                "saved": saved,
                                "continues": isRecording,
                            ]
                            if let reason { payload["error"] = reason }
                            if willResume {
                                payload["interrupted"] = true
                                payload["willResume"] = true
                            }
                            self.notifyListeners("recordingFinished", data: payload)
                        }
                        self.pendingPhotoOperations = max(0, self.pendingPhotoOperations - 1)
                        if self.pendingPhotoOperations == 0 &&
                           (self.applicationIsActive || !self.movieOutput.isRecording) {
                            self.endBackgroundFinalization()
                        }
                        // Le déverrouillage peut arriver pendant la préparation
                        // ou l'import dans Photos.
                        self.resumeRecordingIfNeeded()
                    }
                }
            }
        }
    }

    private func finishWithoutFile(_ error: String) {
        captureSession.stopRunning()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        currentURL = nil
        startedAt = nil
        recordingRequested = false
        suspendedForBackground = false
        let calls = stopCalls
        stopCalls.removeAll()
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = false
            calls.forEach { $0.reject(error) }
            self.notifyListeners("recordingFinished", data: [
                "saved": false,
                "error": error,
            ])
        }
        endBackgroundFinalization()
    }

    /** Démarre un nouveau fichier avec la configuration déjà validée. */
    private func startCapture(preserveSessionStart: Bool = false) throws -> Date {
        try configureIfNeeded()
        let audioChannels = try configureAudioSession()
        configureAudioOutput(channels: audioChannels)
        if !captureSession.isRunning { captureSession.startRunning() }
        let url = recordingsDirectory
            .appendingPathComponent("prepatrack-\(UUID().uuidString).mov")
        let start = preserveSessionStart ? (startedAt ?? Date()) : Date()
        currentURL = url
        startedAt = start
        movieOutput.maxRecordedDuration = CMTime(
            seconds: segmentDurationSeconds,
            preferredTimescale: 600
        )
        // Une table de fragments fréquente rend le dernier fichier beaucoup
        // plus récupérable après un crash ou une extinction brutale.
        movieOutput.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
        movieOutput.startRecording(to: url, recordingDelegate: self)
        return start
    }

    /**
     * Reprend uniquement une capture interrompue par le verrouillage. L'arrêt
     * manuel remet `recordingRequested` à false et reste toujours prioritaire.
     */
    private func resumeRecordingIfNeeded() {
        guard recordingRequested,
              suspendedForBackground,
              currentURL == nil,
              !movieOutput.isRecording,
              applicationIsActive else { return }
        do {
            let resumedAt = try startCapture()
            suspendedForBackground = false
            DispatchQueue.main.async {
                UIApplication.shared.isIdleTimerDisabled = true
                self.notifyListeners("recordingResumed", data: [
                    "startedAt": resumedAt.timeIntervalSince1970 * 1_000,
                ])
            }
        } catch {
            recordingRequested = false
            suspendedForBackground = false
            DispatchQueue.main.async {
                UIApplication.shared.isIdleTimerDisabled = false
                self.notifyListeners("recordingResumeFailed", data: [
                    "error": error.localizedDescription,
                ])
            }
        }
    }

    private func saveToPhotos(_ url: URL, completion: @escaping (Bool, String?) -> Void) {
        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
        }) { saved, error in
            completion(saved, error?.localizedDescription)
        }
    }

    /**
     * Remuxe sans réencoder et place le début des pistes audio et vidéo au même
     * instant. Cela retire le léger décalage de démarrage observé sur certains
     * iPhone sans ralentir l'arrêt : ce travail se fait après que le fichier
     * durable a déjà été rendu à l'interface.
     */
    private func prepareForPhotos(
        _ sourceURL: URL,
        completion: @escaping (URL, String?) -> Void
    ) {
        let asset = AVURLAsset(url: sourceURL)
        let keys = ["tracks", "duration", "playable"]
        asset.loadValuesAsynchronously(forKeys: keys) {
            var loadingError: NSError?
            guard keys.allSatisfy({
                asset.statusOfValue(forKey: $0, error: &loadingError) == .loaded
            }) else {
                completion(
                    sourceURL,
                    loadingError?.localizedDescription ?? "La vidéo brute sera importée sans correction audio."
                )
                return
            }

            let videoTracks = asset.tracks(withMediaType: .video)
            let audioTracks = asset.tracks(withMediaType: .audio)
            guard !videoTracks.isEmpty, !audioTracks.isEmpty else {
                completion(sourceURL, audioTracks.isEmpty ? "La piste audio est absente." : nil)
                return
            }

            let composition = AVMutableComposition()
            do {
                for source in videoTracks {
                    guard let target = composition.addMutableTrack(
                        withMediaType: .video,
                        preferredTrackID: kCMPersistentTrackID_Invalid
                    ) else { continue }
                    try target.insertTimeRange(source.timeRange, of: source, at: .zero)
                    target.preferredTransform = source.preferredTransform
                }
                for source in audioTracks {
                    guard let target = composition.addMutableTrack(
                        withMediaType: .audio,
                        preferredTrackID: kCMPersistentTrackID_Invalid
                    ) else { continue }
                    try target.insertTimeRange(source.timeRange, of: source, at: .zero)
                }
            } catch {
                completion(sourceURL, error.localizedDescription)
                return
            }

            let normalizedURL = FileManager.default.temporaryDirectory
                // Ne correspond volontairement pas au préfixe de récupération
                // des sources brutes, afin d'éviter un double import après crash.
                .appendingPathComponent("normalized-prepatrack-\(UUID().uuidString).mov")
            guard let exporter = AVAssetExportSession(
                asset: composition,
                presetName: AVAssetExportPresetPassthrough
            ) else {
                completion(sourceURL, "La normalisation audio n'est pas disponible.")
                return
            }
            exporter.outputURL = normalizedURL
            exporter.outputFileType = .mov
            exporter.shouldOptimizeForNetworkUse = false
            exporter.exportAsynchronously {
                if exporter.status == .completed,
                   FileManager.default.fileExists(atPath: normalizedURL.path) {
                    completion(normalizedURL, nil)
                } else {
                    try? FileManager.default.removeItem(at: normalizedURL)
                    completion(
                        sourceURL,
                        exporter.error?.localizedDescription ?? "La vidéo brute sera importée sans correction audio."
                    )
                }
            }
        }
    }

    private func beginBackgroundFinalization() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(
            withName: "Finaliser la vidéo PrepaTrack"
        ) { [weak self] in
            // Le MOV fragmenté reste dans Application Support. S'il n'a pas eu
            // le temps d'être importé, recoverPendingRecordings() le reprendra.
            self?.endBackgroundFinalization()
        }
    }

    private func endBackgroundFinalization() {
        DispatchQueue.main.async {
            guard self.backgroundTask != .invalid else { return }
            let task = self.backgroundTask
            self.backgroundTask = .invalid
            UIApplication.shared.endBackgroundTask(task)
        }
    }

    /**
     * Récupère les captures abandonnées par une extinction, un crash ou une
     * ancienne version. Le dossier temporaire est aussi inspecté pour sauver
     * les fichiers laissés par les builds précédentes.
     */
    private func recoverPendingRecordings() {
        let manager = FileManager.default
        let durable = (try? manager.contentsOfDirectory(
            at: recordingsDirectory,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        let temporary = ((try? manager.contentsOfDirectory(
            at: manager.temporaryDirectory,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        )) ?? []).filter {
            $0.lastPathComponent.hasPrefix("prepatrack-") &&
            !$0.lastPathComponent.hasPrefix("prepatrack-normalized-") &&
            $0.pathExtension == "mov"
        }
        let pending = (durable + temporary).filter {
            ((try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) > 0
        }
        guard !pending.isEmpty else { return }

        let importFiles = { [weak self] in
            self?.recoverPendingRecordings(pending, at: 0)
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

    /** Importe en série pour ne pas saturer Photos au lancement. */
    private func recoverPendingRecordings(_ pending: [URL], at index: Int) {
        guard index < pending.count else { return }
        let sourceURL = pending[index]
        prepareForPhotos(sourceURL) { [weak self] preparedURL, preparationError in
            guard let self else { return }
            self.saveToPhotos(preparedURL) { saved, photoError in
                if saved {
                    try? FileManager.default.removeItem(at: sourceURL)
                    if preparedURL != sourceURL {
                        try? FileManager.default.removeItem(at: preparedURL)
                    }
                } else if preparedURL != sourceURL {
                    try? FileManager.default.removeItem(at: preparedURL)
                }
                DispatchQueue.main.async {
                    var payload: [String: Any] = [
                        "saved": saved,
                        "recovered": true,
                        "continues": false,
                    ]
                    if let error = photoError ?? preparationError {
                        payload["error"] = error
                    }
                    self.notifyListeners("recordingFinished", data: payload)
                }
                self.recoverPendingRecordings(pending, at: index + 1)
            }
        }
    }

    private func configureIfNeeded() throws {
        guard !configured else { return }
        captureSession.beginConfiguration()
        defer { captureSession.commitConfiguration() }
        captureSession.automaticallyConfiguresApplicationAudioSession = false
        captureSession.sessionPreset = .hd1280x720
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let microphone = AVCaptureDevice.default(for: .audio) else {
            throw RecordingError.deviceUnavailable
        }
        let cameraInput = try AVCaptureDeviceInput(device: camera)
        let microphoneInput = try AVCaptureDeviceInput(device: microphone)
        guard captureSession.canAddInput(cameraInput), captureSession.canAddInput(microphoneInput),
              captureSession.canAddOutput(movieOutput) else {
            throw RecordingError.configurationFailed
        }
        captureSession.addInput(cameraInput)
        captureSession.addInput(microphoneInput)
        captureSession.addOutput(movieOutput)
        // 1× est le champ de vision natif maximal. Sur l'iPhone 15 Plus, la
        // caméra TrueDepth avant est un capteur unique : un facteur inférieur
        // à 1× n'existe pas et ne ferait qu'inventer des pixels.
        do {
            try camera.lockForConfiguration()
            camera.videoZoomFactor = max(1, camera.minAvailableVideoZoomFactor)
            if camera.isGeometricDistortionCorrectionSupported {
                camera.isGeometricDistortionCorrectionEnabled = true
            }
            // Une cadence fixe donne à la stabilisation cinématique une
            // fenêtre temporelle régulière, particulièrement importante sur
            // un chariot qui vibre. On garde 30 i/s pour limiter le flou de
            // mouvement sans augmenter la définition ni la taille du fichier.
            let preferredFPS = 30.0
            if camera.activeFormat.videoSupportedFrameRateRanges.contains(where: {
                $0.minFrameRate <= preferredFPS && $0.maxFrameRate >= preferredFPS
            }) {
                let duration = CMTime(value: 1, timescale: 30)
                camera.activeVideoMinFrameDuration = duration
                camera.activeVideoMaxFrameDuration = duration
            }
            camera.unlockForConfiguration()
        } catch {
            // Le réglage par défaut reste utilisable si iOS réserve brièvement
            // la caméra pendant une transition système.
        }
        if let connection = movieOutput.connection(with: .video) {
            if connection.isVideoOrientationSupported { connection.videoOrientation = .portrait }
            if connection.isVideoStabilizationSupported {
                let format = camera.activeFormat
                if #available(iOS 18.0, *),
                   format.isVideoStabilizationModeSupported(.cinematicExtendedEnhanced) {
                    // Mode recommandé par Apple pour la meilleure stabilité.
                    // Il recadre davantage, mais le zoom optique reste à son
                    // minimum afin de conserver tout le champ encore disponible.
                    connection.preferredVideoStabilizationMode = .cinematicExtendedEnhanced
                } else if format.isVideoStabilizationModeSupported(.cinematicExtended) {
                    connection.preferredVideoStabilizationMode = .cinematicExtended
                } else if format.isVideoStabilizationModeSupported(.cinematic) {
                    connection.preferredVideoStabilizationMode = .cinematic
                } else if format.isVideoStabilizationModeSupported(.standard) {
                    connection.preferredVideoStabilizationMode = .standard
                } else {
                    connection.preferredVideoStabilizationMode = .auto
                }
            }
        }
        configured = true
    }

    /**
     * Garde la musique des autres apps (Spotify, Apple Music…) pendant la
     * captation, force le micro du téléphone, et active l'annulation d'écho
     * pour laisser le moins de musique possible dans la vidéo.
     */
    private func configureAudioSession() throws -> Int {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .videoChat,
            options: [.mixWithOthers, .allowBluetoothA2DP, .defaultToSpeaker]
        )
        try? session.setPreferredSampleRate(48_000)
        // Un tampon court réduit la latence d'entrée qui se manifestait par un
        // léger retard du son sur l'image après multiplexage.
        try? session.setPreferredIOBufferDuration(0.005)
        try session.setActive(true)

        preferBuiltInMicrophone(session)

        let stereo = session.inputNumberOfChannels >= 2 &&
            session.preferredInput?.dataSources?.contains(where: {
                $0.selectedPolarPattern == .stereo
            }) == true
        if stereo {
            try? session.setPreferredInputNumberOfChannels(2)
            try? session.setPreferredInputOrientation(.portrait)
            return 2
        }
        try? session.setPreferredInputNumberOfChannels(1)
        return 1
    }

    /** Évite le micro du casque, qui enregistrerait surtout la musique. */
    private func preferBuiltInMicrophone(_ session: AVAudioSession) {
        guard let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }) else {
            return
        }
        try? session.setPreferredInput(builtIn)
        let source = builtIn.dataSources?.first(where: { $0.orientation == .front })
            ?? builtIn.dataSources?.first
        guard let source else { return }
        if source.supportedPolarPatterns?.contains(.cardioid) == true {
            try? source.setPreferredPolarPattern(.cardioid)
        }
        try? builtIn.setPreferredDataSource(source)
    }

    /** Encode le son en AAC 48 kHz avec le débit maximal utile à 1 ou 2 canaux. */
    private func configureAudioOutput(channels: Int) {
        guard let connection = movieOutput.connection(with: .audio) else { return }
        let supported = Set(movieOutput.supportedOutputSettingsKeys(for: connection))
        let candidates: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: channels >= 2 ? 256_000 : 160_000,
            AVEncoderAudioQualityKey: AVAudioQuality.max.rawValue,
        ]
        let settings = candidates.filter { supported.contains($0.key) }
        if !settings.isEmpty { movieOutput.setOutputSettings(settings, for: connection) }
    }

    private func requestPermissions(completion: @escaping (Bool) -> Void) {
        let group = DispatchGroup()
        var camera = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
        var microphone = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        let photoStatus = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        var photos = photoStatus == .authorized || photoStatus == .limited
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
    var errorDescription: String? {
        switch self {
        case .deviceUnavailable: return "Caméra avant ou microphone introuvable."
        case .configurationFailed: return "Impossible de configurer la capture vidéo."
        }
    }
}
