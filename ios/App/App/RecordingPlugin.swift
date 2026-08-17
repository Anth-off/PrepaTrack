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
        CAPPluginMethod(name: "showMicrophoneModes", returnType: CAPPluginReturnPromise),
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
    private var captureCamera: AVCaptureDevice?
    private var requestedStabilizationMode: AVCaptureVideoStabilizationMode = .off

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
                    if self.movieOutput.isRecording {
                        self.recordingRequested = true
                        self.suspendedForBackground = false
                        DispatchQueue.main.async {
                            call.resolve([
                                "startedAt": (self.startedAt ?? Date()).timeIntervalSince1970 * 1_000,
                                "captureProfile": self.captureProfilePayload(),
                            ])
                        }
                        return
                    }
                    // Le fichier précédent peut être arrêté mais encore en
                    // cours d'import dans Photos. En démarrer un autre ici
                    // écraserait `currentURL`, puis le callback précédent
                    // arrêterait la nouvelle capture.
                    guard self.currentURL == nil else {
                        DispatchQueue.main.async {
                            call.reject("La vidéo précédente est encore en cours de sauvegarde dans Photos.")
                        }
                        return
                    }
                    self.recordingRequested = true
                    self.suspendedForBackground = false
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
        sessionQueue.async {
            // Pendant l'import Photos, l'enregistrement n'accepte pas encore
            // un nouveau départ. Le signaler comme actif empêche l'interface
            // de proposer un second démarrage dans cette courte fenêtre.
            var result: [String: Any] = [
                "recording": self.movieOutput.isRecording || self.currentURL != nil,
            ]
            if let startedAt = self.startedAt {
                result["startedAt"] = startedAt.timeIntervalSince1970 * 1_000
            }
            if self.configured {
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
            let recording = self.movieOutput.isRecording
            DispatchQueue.main.async {
                guard recording else {
                    call.reject("Démarre d’abord l’enregistrement pour choisir le mode micro iOS.")
                    return
                }
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
                    try self.configureIfNeeded()
                    DispatchQueue.main.async {
                        call.resolve(["captureProfile": self.captureProfilePayload()])
                    }
                } catch {
                    DispatchQueue.main.async { call.reject(error.localizedDescription) }
                }
            }
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
        do {
            try verifyVideoStabilization()
        } catch {
            captureSession.stopRunning()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            throw error
        }
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
        captureSession.usesApplicationAudioSession = true
        captureSession.automaticallyConfiguresApplicationAudioSession = false
        if #available(iOS 18.0, *) {
            captureSession.configuresApplicationAudioSessionToMixWithOthers = false
        }
        guard let profile = selectFrontCaptureProfile(),
              let microphone = AVCaptureDevice.default(for: .audio) else {
            throw RecordingError.deviceUnavailable
        }
        let camera = profile.device
        let cameraInput = try AVCaptureDeviceInput(device: camera)
        let microphoneInput = try AVCaptureDeviceInput(device: microphone)
        var cameraAdded = false
        var microphoneAdded = false
        var outputAdded = false
        do {
            guard captureSession.canAddInput(cameraInput), captureSession.canAddInput(microphoneInput),
                  captureSession.canAddOutput(movieOutput) else {
                throw RecordingError.configurationFailed
            }
            captureSession.addInput(cameraInput)
            cameraAdded = true
            captureSession.addInput(microphoneInput)
            microphoneAdded = true
            captureSession.addOutput(movieOutput)
            outputAdded = true
            try camera.lockForConfiguration()
            defer { camera.unlockForConfiguration() }
            camera.activeFormat = profile.format
            camera.videoZoomFactor = camera.minAvailableVideoZoomFactor
            // Conserver la correction Apple évite les déformations de visages
            // et de lignes droites aux bords. La sélection compare donc le
            // champ réellement disponible après cette correction.
            if camera.isGeometricDistortionCorrectionSupported {
                camera.isGeometricDistortionCorrectionEnabled = true
            }
            let duration = CMTime(value: 1, timescale: 30)
            camera.activeVideoMinFrameDuration = duration
            camera.activeVideoMaxFrameDuration = duration
        } catch {
            if outputAdded { captureSession.removeOutput(movieOutput) }
            if microphoneAdded { captureSession.removeInput(microphoneInput) }
            if cameraAdded { captureSession.removeInput(cameraInput) }
            throw error
        }
        captureCamera = camera
        requestedStabilizationMode = profile.stabilizationMode
        applyVideoConnectionConfiguration()
        configured = true
    }

    /**
     * Sélectionne explicitement le format avant 720p/30 stabilisé ayant le
     * plus grand champ horizontal. Un simple preset pouvait être réévalué au
     * commit de la session et rendre le mode demandé inactif silencieusement.
     */
    private func selectFrontCaptureProfile() -> VideoCaptureProfile? {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera],
            mediaType: .video,
            position: .front
        )
        let allCandidates = discovery.devices.flatMap { device in
            device.formats.compactMap { format -> VideoCaptureProfile? in
                let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
                guard format.videoSupportedFrameRateRanges.contains(where: {
                    $0.minFrameRate <= 30 && $0.maxFrameRate >= 30
                }), let stabilization = strongestStabilizationMode(for: format) else {
                    return nil
                }
                return VideoCaptureProfile(
                    device: device,
                    format: format,
                    dimensions: dimensions,
                    fieldOfView: format.geometricDistortionCorrectedVideoFieldOfView,
                    stabilizationMode: stabilization
                )
            }
        }
        let candidates720p = allCandidates.filter {
            $0.dimensions.width == 1_280 && $0.dimensions.height == 720
        }
        let candidates1080p = allCandidates.filter {
            $0.dimensions.width == 1_920 && $0.dimensions.height == 1_080
        }
        let candidates = !candidates720p.isEmpty ? candidates720p : candidates1080p
        guard let bestRank = candidates.map({ stabilizationRank($0.stabilizationMode) }).max() else {
            return nil
        }
        return candidates
            .filter { stabilizationRank($0.stabilizationMode) == bestRank }
            .max { $0.fieldOfView < $1.fieldOfView }
    }

    private func strongestStabilizationMode(
        for format: AVCaptureDevice.Format
    ) -> AVCaptureVideoStabilizationMode? {
        if #available(iOS 18.0, *),
           format.isVideoStabilizationModeSupported(.cinematicExtendedEnhanced) {
            return .cinematicExtendedEnhanced
        }
        if format.isVideoStabilizationModeSupported(.cinematicExtended) { return .cinematicExtended }
        if format.isVideoStabilizationModeSupported(.cinematic) { return .cinematic }
        if format.isVideoStabilizationModeSupported(.standard) { return .standard }
        return nil
    }

    private func applyVideoConnectionConfiguration() {
        guard let connection = movieOutput.connection(with: .video) else { return }
        if connection.isVideoOrientationSupported { connection.videoOrientation = .portrait }
        if connection.isVideoStabilizationSupported {
            connection.preferredVideoStabilizationMode = requestedStabilizationMode
        }
    }

    private func verifyVideoStabilization() throws {
        guard let connection = movieOutput.connection(with: .video),
              connection.isVideoStabilizationSupported else {
            throw RecordingError.stabilizationUnavailable
        }
        applyVideoConnectionConfiguration()
        if !waitForActiveStabilization(connection) {
            requestedStabilizationMode = .auto
            connection.preferredVideoStabilizationMode = .auto
        }
        guard waitForActiveStabilization(connection) else {
            throw RecordingError.stabilizationUnavailable
        }
    }

    private func waitForActiveStabilization(_ connection: AVCaptureConnection) -> Bool {
        for _ in 0..<10 {
            if connection.activeVideoStabilizationMode != .off { return true }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return connection.activeVideoStabilizationMode != .off
    }

    private func captureProfilePayload() -> [String: Any] {
        guard let camera = captureCamera else { return [:] }
        let dimensions = CMVideoFormatDescriptionGetDimensions(camera.activeFormat.formatDescription)
        let connection = movieOutput.connection(with: .video)
        return [
            "camera": camera.localizedName,
            "width": Int(dimensions.width),
            "height": Int(dimensions.height),
            "framesPerSecond": 30,
            "fieldOfView": Double(camera.activeFormat.geometricDistortionCorrectedVideoFieldOfView),
            "zoomFactor": Double(camera.videoZoomFactor),
            "requestedStabilization": stabilizationName(requestedStabilizationMode),
            "activeStabilization": stabilizationName(connection?.activeVideoStabilizationMode ?? .off),
            "preferredMicrophoneMode": microphoneModeName(AVCaptureDevice.preferredMicrophoneMode),
            "activeMicrophoneMode": microphoneModeName(AVCaptureDevice.activeMicrophoneMode),
            "audioChannels": AVAudioSession.sharedInstance().inputNumberOfChannels,
        ]
    }

    private func stabilizationRank(_ mode: AVCaptureVideoStabilizationMode) -> Int {
        if #available(iOS 18.0, *), mode == .cinematicExtendedEnhanced { return 5 }
        switch mode {
        case .cinematicExtended: return 4
        case .cinematic: return 3
        case .standard: return 2
        case .auto: return 1
        default: return 0
        }
    }

    private func stabilizationName(_ mode: AVCaptureVideoStabilizationMode) -> String {
        if #available(iOS 18.0, *), mode == .cinematicExtendedEnhanced {
            return "cinematicExtendedEnhanced"
        }
        switch mode {
        case .cinematicExtended: return "cinematicExtended"
        case .cinematic: return "cinematic"
        case .standard: return "standard"
        case .auto: return "auto"
        case .off: return "off"
        default: return "other"
        }
    }

    private func microphoneModeName(_ mode: AVCaptureDevice.MicrophoneMode) -> String {
        switch mode {
        case .standard: return "standard"
        case .voiceIsolation: return "voiceIsolation"
        case .wideSpectrum: return "wideSpectrum"
        @unknown default: return "automatic"
        }
    }

    /**
     * Utilise une session entrée/sortie non mixable : contrairement à la
     * catégorie `.record`, elle fournit à iOS le chemin de sortie nécessaire
     * aux modes micro système, dont « Large spectre ». Le profil vidéo reste
     * à 48 kHz et iOS garde la main sur le traitement/polar pattern afin de ne
     * pas rendre un mode incompatible en forçant le stéréo.
     */
    private func configureAudioSession() throws -> Int {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .videoRecording, options: [.defaultToSpeaker])
        try? session.setPreferredSampleRate(48_000)
        try? session.setPreferredInputNumberOfChannels(1)
        try session.setActive(true)

        if let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
            try? session.setPreferredInput(builtIn)
            if let front = builtIn.dataSources?.first(where: { $0.orientation == .front }) {
                try? front.setPreferredPolarPattern(nil)
                try? builtIn.setPreferredDataSource(front)
            }
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
    var errorDescription: String? {
        switch self {
        case .deviceUnavailable: return "Caméra avant ou microphone introuvable."
        case .configurationFailed: return "Impossible de configurer la capture vidéo."
        case .stabilizationUnavailable: return "iOS n’a pas activé la stabilisation vidéo sur ce profil."
        }
    }
}

private struct VideoCaptureProfile {
    let device: AVCaptureDevice
    let format: AVCaptureDevice.Format
    let dimensions: CMVideoDimensions
    let fieldOfView: Float
    let stabilizationMode: AVCaptureVideoStabilizationMode
}
