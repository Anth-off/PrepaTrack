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
    private let audioEngine = AVAudioEngine()
    private let audioStateLock = NSLock()
    private let sessionQueue = DispatchQueue(label: "com.n0thytvoff.prepatrack.recording")
    private var configured = false
    private var startedAt: Date?
    private var currentURL: URL?
    private var currentAudioURL: URL?
    private var audioFile: AVAudioFile?
    private var audioTapInstalled = false
    private var acceptsAudioBuffers = false
    private var audioWriteError: String?
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
            if self.movieOutput.isRecording {
                self.stopAudioCapture()
                self.movieOutput.stopRecording()
            }
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
            self.stopAudioCapture()
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
            do {
                try self.prepareAudioSessionForMicrophoneModes()
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
        didStartRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection]
    ) {
        audioStateLock.lock()
        acceptsAudioBuffers = outputFileURL == currentURL
        audioStateLock.unlock()
    }

    public func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        stopAudioCapture()
        let successfullyFinished = (error as NSError?)?
            .userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? (error == nil)
        guard FileManager.default.fileExists(atPath: outputFileURL.path) else {
            finish(saved: false, error: error?.localizedDescription ?? "Enregistrement interrompu", cleanupURLs: [])
            return
        }
        // Même si AVFoundation signale une interruption, le conteneur fragmenté
        // peut rester lisible. On tente donc l'import et on ne supprime jamais
        // le fichier durable tant que Photos ne l'a pas confirmé.
        let audioURL = currentAudioURL
        prepareFinalRecording(videoURL: outputFileURL, audioURL: audioURL) { [weak self] finalURL, merged, mergeError in
            guard let self else { return }
            self.saveToPhotos(finalURL) { saved, photoError in
                let reason = photoError
                    ?? mergeError
                    ?? self.audioWriteError
                    ?? (!successfullyFinished ? error?.localizedDescription : nil)
                var cleanupURLs = [outputFileURL]
                if merged {
                    if let audioURL { cleanupURLs.append(audioURL) }
                    if finalURL != outputFileURL { cleanupURLs.append(finalURL) }
                }
                self.finish(saved: saved, error: reason, cleanupURLs: cleanupURLs)
            }
        }
    }

    private func finish(saved: Bool, error: String?, cleanupURLs: [URL]) {
        sessionQueue.async {
            self.captureSession.stopRunning()
            self.stopAudioCapture()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            if saved {
                for url in Set(cleanupURLs) { try? FileManager.default.removeItem(at: url) }
            }
            self.currentURL = nil
            self.currentAudioURL = nil
            self.startedAt = nil
            self.audioWriteError = nil
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
        let baseName = "prepatrack-\(UUID().uuidString)"
        let videoURL = recordingsDirectory.appendingPathComponent("\(baseName).video.mov")
        let audioURL = recordingsDirectory.appendingPathComponent("\(baseName).audio.m4a")
        currentURL = videoURL
        currentAudioURL = audioURL
        audioWriteError = nil
        do {
            try startAudioCapture(to: audioURL)
            if !captureSession.isRunning { captureSession.startRunning() }
            try verifyVideoStabilization()
        } catch {
            stopAudioCapture()
            captureSession.stopRunning()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            currentURL = nil
            currentAudioURL = nil
            try? FileManager.default.removeItem(at: videoURL)
            try? FileManager.default.removeItem(at: audioURL)
            throw error
        }
        let start = Date()
        startedAt = start
        movieOutput.maxRecordedDuration = CMTime(seconds: 3_600, preferredTimescale: 600)
        movieOutput.movieFragmentInterval = CMTime(seconds: 5, preferredTimescale: 600)
        movieOutput.startRecording(to: videoURL, recordingDelegate: self)
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
            $0.pathExtension == "mov" && !$0.lastPathComponent.hasSuffix(".video.mov")
        }
        let rawVideos = durable.filter { $0.lastPathComponent.hasSuffix(".video.mov") }
        guard !finalVideos.isEmpty || !rawVideos.isEmpty || !temporary.isEmpty else { return }

        let importFiles = { [weak self] in
            guard let self else { return }
            let notify: (Bool, String?) -> Void = { saved, error in
                DispatchQueue.main.async {
                    var payload: [String: Any] = ["saved": saved, "recovered": true]
                    if let error { payload["error"] = error }
                    self.notifyListeners("recordingFinished", data: payload)
                }
            }
            let importVideo: (URL, [URL], String?) -> Void = { url, cleanup, earlierError in
                self.saveToPhotos(url) { saved, error in
                    if saved {
                        for candidate in Set(cleanup) { try? manager.removeItem(at: candidate) }
                    }
                    notify(saved, error ?? earlierError)
                }
            }

            let finalNames = Set(finalVideos.map { $0.deletingPathExtension().lastPathComponent })
            for url in finalVideos {
                let base = url.deletingPathExtension().lastPathComponent
                let raw = url.deletingLastPathComponent().appendingPathComponent("\(base).video.mov")
                let audio = url.deletingLastPathComponent().appendingPathComponent("\(base).audio.m4a")
                importVideo(url, [url, raw, audio], nil)
            }
            for videoURL in rawVideos {
                let videoStem = videoURL.deletingPathExtension().lastPathComponent
                let base = videoStem.hasSuffix(".video")
                    ? String(videoStem.dropLast(".video".count))
                    : videoStem
                guard !finalNames.contains(base) else { continue }
                let audioURL = videoURL.deletingLastPathComponent().appendingPathComponent("\(base).audio.m4a")
                self.prepareFinalRecording(videoURL: videoURL, audioURL: audioURL) { finalURL, merged, mergeError in
                    let cleanup = merged ? [videoURL, audioURL, finalURL] : [videoURL]
                    importVideo(finalURL, cleanup, mergeError)
                }
            }
            for url in temporary { importVideo(url, [url], nil) }
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
        guard let profile = selectFrontCaptureProfile() else {
            throw RecordingError.deviceUnavailable
        }
        let camera = profile.device
        let cameraInput = try AVCaptureDeviceInput(device: camera)
        var cameraAdded = false
        var outputAdded = false
        do {
            guard captureSession.canAddInput(cameraInput), captureSession.canAddOutput(movieOutput) else {
                throw RecordingError.configurationFailed
            }
            captureSession.addInput(cameraInput)
            cameraAdded = true
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
        let audioSession = AVAudioSession.sharedInstance()
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
            "audioChannels": audioSession.inputNumberOfChannels,
            "voiceProcessingEnabled": audioEngine.inputNode.isVoiceProcessingEnabled,
            "audioSessionCategory": audioSession.category.rawValue,
            "audioSessionMode": audioSession.mode.rawValue,
            "audioInputRoute": audioSession.currentRoute.inputs.first?.portName ?? "none",
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

    /** Configure la route qui permet à iOS de mémoriser un mode micro avant la capture. */
    private func prepareAudioSessionForMicrophoneModes() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .videoChat, options: [.defaultToSpeaker])
        try? session.setPreferredSampleRate(48_000)
        try? session.setPreferredInputNumberOfChannels(1)
    }

    /**
     * Les modes micro Apple exigent Voice Processing I/O. Le moteur enregistre
     * donc la piste réellement traitée dans un fichier AAC durable, tandis que
     * AVCaptureMovieFileOutput conserve la vidéo stabilisée sans posséder le micro.
     */
    private func startAudioCapture(to url: URL) throws {
        stopAudioCapture()
        try prepareAudioSessionForMicrophoneModes()
        let session = AVAudioSession.sharedInstance()
        try session.setActive(true)

        let input = audioEngine.inputNode
        try input.setVoiceProcessingEnabled(true)
        guard input.isVoiceProcessingEnabled else { throw RecordingError.voiceProcessingUnavailable }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw RecordingError.voiceProcessingUnavailable
        }
        let channels = Int(format.channelCount)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: channels >= 2 ? 256_000 : 160_000,
            AVEncoderAudioQualityKey: AVAudioQuality.max.rawValue,
        ]
        let file = try AVAudioFile(
            forWriting: url,
            settings: settings,
            commonFormat: format.commonFormat,
            interleaved: format.isInterleaved
        )
        audioStateLock.lock()
        audioFile = file
        acceptsAudioBuffers = false
        audioWriteError = nil
        audioStateLock.unlock()

        input.installTap(onBus: 0, bufferSize: 2_048, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.audioStateLock.lock()
            let target = self.acceptsAudioBuffers ? self.audioFile : nil
            self.audioStateLock.unlock()
            guard let target else { return }
            do {
                try target.write(from: buffer)
            } catch {
                self.audioStateLock.lock()
                if self.audioWriteError == nil { self.audioWriteError = error.localizedDescription }
                self.audioStateLock.unlock()
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

    private func stopAudioCapture() {
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
        audioStateLock.unlock()
        audioEngine.reset()
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

                guard let export = AVAssetExportSession(
                    asset: composition,
                    presetName: AVAssetExportPresetPassthrough
                ) else {
                    completion(videoURL, false, "Impossible de finaliser la vidéo; les sources ont été conservées.")
                    return
                }
                if FileManager.default.fileExists(atPath: finalURL.path) {
                    try FileManager.default.removeItem(at: finalURL)
                }
                export.outputURL = finalURL
                export.outputFileType = .mov
                export.shouldOptimizeForNetworkUse = false
                export.exportAsynchronously {
                    if export.status == .completed,
                       FileManager.default.fileExists(atPath: finalURL.path) {
                        completion(finalURL, true, nil)
                    } else {
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
    var errorDescription: String? {
        switch self {
        case .deviceUnavailable: return "Caméra avant ou microphone introuvable."
        case .configurationFailed: return "Impossible de configurer la capture vidéo."
        case .stabilizationUnavailable: return "iOS n’a pas activé la stabilisation vidéo sur ce profil."
        case .voiceProcessingUnavailable: return "iOS n’a pas activé le traitement vocal requis pour les modes micro."
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
