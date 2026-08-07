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
                    // Le fichier est déjà arrêté mais Photos termine encore son
                    // import : la clôture doit attendre le même accusé final.
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
        var result: [String: Any] = ["recording": movieOutput.isRecording]
        if let startedAt { result["startedAt"] = startedAt.timeIntervalSince1970 * 1_000 }
        call.resolve(result)
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
        guard FileManager.default.fileExists(atPath: outputFileURL.path) else {
            finish(saved: false, error: error?.localizedDescription ?? "Enregistrement interrompu", sourceURL: nil)
            return
        }
        // Même si AVFoundation signale une interruption, le conteneur fragmenté
        // peut rester lisible. On tente donc l'import et on ne supprime jamais
        // le fichier durable tant que Photos ne l'a pas confirmé.
        saveToPhotos(outputFileURL) { [weak self] saved, photoError in
            let reason = photoError ?? (!successfullyFinished ? error?.localizedDescription : nil)
            self?.finish(saved: saved, error: reason, sourceURL: outputFileURL)
        }
    }

    private func finish(saved: Bool, error: String?, sourceURL: URL?) {
        sessionQueue.async {
            self.captureSession.stopRunning()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            if saved, let url = sourceURL { try? FileManager.default.removeItem(at: url) }
            self.currentURL = nil
            self.startedAt = nil
            let calls = self.stopCalls
            self.stopCalls.removeAll()
            let interruptedForBackground = self.recordingRequested && self.suspendedForBackground
            DispatchQueue.main.async {
                UIApplication.shared.isIdleTimerDisabled = false
                var payload: [String: Any] = ["saved": saved]
                if let error { payload["error"] = error }
                if interruptedForBackground {
                    payload["interrupted"] = true
                    payload["willResume"] = true
                }
                calls.forEach { saved ? $0.resolve(payload) : $0.reject(error ?? "La vidéo n’a pas pu être ajoutée à Photos.") }
                self.notifyListeners("recordingFinished", data: payload)
            }
            // Le déverrouillage peut arriver pendant l'import dans Photos.
            // Retenter ici évite de perdre cette course entre les callbacks.
            self.resumeRecordingIfNeeded()
        }
    }

    /** Démarre un nouveau fichier avec la configuration déjà validée. */
    private func startCapture() throws -> Date {
        try configureIfNeeded()
        let audioChannels = try configureAudioSession()
        configureAudioOutput(channels: audioChannels)
        if !captureSession.isRunning { captureSession.startRunning() }
        let url = recordingsDirectory
            .appendingPathComponent("prepatrack-\(UUID().uuidString).mov")
        let start = Date()
        currentURL = url
        startedAt = start
        movieOutput.maxRecordedDuration = CMTime(seconds: 3_600, preferredTimescale: 600)
        movieOutput.movieFragmentInterval = CMTime(seconds: 5, preferredTimescale: 600)
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
        )) ?? []).filter { $0.lastPathComponent.hasPrefix("prepatrack-") && $0.pathExtension == "mov" }
        let pending = (durable + temporary).filter {
            ((try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) > 0
        }
        guard !pending.isEmpty else { return }

        let importFiles = { [weak self] in
            guard let self else { return }
            for url in pending {
                self.saveToPhotos(url) { saved, error in
                    if saved { try? manager.removeItem(at: url) }
                    DispatchQueue.main.async {
                        var payload: [String: Any] = ["saved": saved, "recovered": true]
                        if let error { payload["error"] = error }
                        self.notifyListeners("recordingFinished", data: payload)
                    }
                }
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
     * Utilise le traitement audio prévu par Apple pour une captation vidéo,
     * le micro dirigé vers la caméra avant et le stéréo lorsqu'il existe.
     */
    private func configureAudioSession() throws -> Int {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .videoRecording, options: [])
        try? session.setPreferredSampleRate(48_000)
        try session.setActive(true)

        if let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
            try? session.setPreferredInput(builtIn)
            if let front = builtIn.dataSources?.first(where: { $0.orientation == .front }) {
                if front.supportedPolarPatterns?.contains(.stereo) == true {
                    try? front.setPreferredPolarPattern(.stereo)
                }
                try? builtIn.setPreferredDataSource(front)
            }
        }
        if session.inputNumberOfChannels >= 2 {
            try? session.setPreferredInputOrientation(.portrait)
        }
        return max(1, min(2, session.inputNumberOfChannels))
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
        var photos = PHPhotoLibrary.authorizationStatus(for: .addOnly) == .authorized
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
