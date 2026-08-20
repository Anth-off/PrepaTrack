import AVFoundation
import CoreImage
import CoreMedia
import CoreVideo
import Metal
import UIKit

/**
 * Capture simultanément les caméras avant et arrière dans deux fichiers
 * indépendants en 720p/30. Les deux fichiers utilisent exactement les mêmes
 * timestamps issus d'AVCaptureDataOutputSynchronizer.
 *
 * Chaque image reçoit un bandeau permanent, placé dans le carré central que
 * Photos conserve pour ses miniatures. Il contient le rôle de la caméra et la
 * date/heure de début du segment, ce qui permet d'identifier immédiatement les
 * deux angles sans ouvrir les vidéos.
 */
final class DualCameraVideoPipeline: NSObject, AVCaptureDataOutputSynchronizerDelegate {
    private let session = AVCaptureMultiCamSession()
    private let outputQueue = DispatchQueue(
        label: "com.n0thytvoff.prepatrack.recording.video",
        qos: .userInitiated
    )
    private let frontOutput = AVCaptureVideoDataOutput()
    private let backOutput = AVCaptureVideoDataOutput()
    private var frameRenderer: DualCameraFrameOverlayRenderer?
    private var synchronizer: AVCaptureDataOutputSynchronizer?

    private var configured = false
    private var profile: DualCameraCaptureProfile?
    private var frontConnection: AVCaptureConnection?
    private var backConnection: AVCaptureConnection?
    private var segmentWriter: DualCameraSegmentWriter?
    private var durationLimitReported = false
    private var consecutiveRenderingFailures = 0
    private var renderingFailureReported = false
    private var sessionObservers: [NSObjectProtocol] = []

    var onDurationLimitReached: ((UUID) -> Void)?
    var onRenderingFailed: ((Error) -> Void)?
    var onSessionInterrupted: (() -> Void)?
    var onSessionInterruptionEnded: (() -> Void)?

    override init() {
        super.init()
        let center = NotificationCenter.default
        sessionObservers.append(center.addObserver(
            forName: .AVCaptureSessionWasInterrupted,
            object: session,
            queue: nil
        ) { [weak self] _ in self?.onSessionInterrupted?() })
        sessionObservers.append(center.addObserver(
            forName: .AVCaptureSessionInterruptionEnded,
            object: session,
            queue: nil
        ) { [weak self] _ in self?.onSessionInterruptionEnded?() })
        sessionObservers.append(center.addObserver(
            forName: .AVCaptureSessionRuntimeError,
            object: session,
            queue: nil
        ) { [weak self] _ in
            // Ne jamais laisser l'audio continuer seul si AVFoundation arrête
            // la session vidéo. Le plugin ferme les sources durablement puis
            // retente une nouvelle tranche.
            self?.onRenderingFailed?(DualCameraPipelineError.sessionFailed)
        })
    }

    deinit {
        for observer in sessionObservers { NotificationCenter.default.removeObserver(observer) }
    }

    var isSessionRunning: Bool { session.isRunning }

    var isRecording: Bool {
        outputQueue.sync { segmentWriter != nil }
    }

    func configureIfNeeded() throws {
        guard !configured else { return }
        guard AVCaptureMultiCamSession.isMultiCamSupported else {
            throw DualCameraPipelineError.multiCamUnavailable
        }
        frameRenderer = try DualCameraFrameOverlayRenderer()

        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera],
            mediaType: .video,
            position: .unspecified
        )
        guard let frontDevice = discovery.devices.first(where: { $0.position == .front }),
              let backDevice = discovery.devices.first(where: { $0.position == .back }),
              discovery.supportedMultiCamDeviceSets.contains(where: {
                  $0.contains(frontDevice) && $0.contains(backDevice)
              }),
              let frontProfile = selectProfile(for: frontDevice, maximumStabilizationRank: 5),
              let backProfile = selectProfile(for: backDevice, maximumStabilizationRank: 2) else {
            throw DualCameraPipelineError.multiCamPairUnavailable
        }

        let frontInput = try AVCaptureDeviceInput(device: frontDevice)
        let backInput = try AVCaptureDeviceInput(device: backDevice)
        var configurationCommitted = false
        session.beginConfiguration()
        session.usesApplicationAudioSession = false
        session.automaticallyConfiguresApplicationAudioSession = false
        do {
            guard session.canAddInput(frontInput), session.canAddInput(backInput) else {
                throw DualCameraPipelineError.configurationFailed
            }
            session.addInputWithNoConnections(frontInput)
            session.addInputWithNoConnections(backInput)

            try configureDevice(frontDevice, profile: frontProfile)
            try configureDevice(backDevice, profile: backProfile)

            configureOutput(frontOutput)
            configureOutput(backOutput)
            guard session.canAddOutput(frontOutput), session.canAddOutput(backOutput) else {
                throw DualCameraPipelineError.configurationFailed
            }
            session.addOutputWithNoConnections(frontOutput)
            session.addOutputWithNoConnections(backOutput)

            guard let frontPort = frontInput.ports(
                for: .video,
                sourceDeviceType: frontDevice.deviceType,
                sourceDevicePosition: .front
            ).first,
            let backPort = backInput.ports(
                for: .video,
                sourceDeviceType: backDevice.deviceType,
                sourceDevicePosition: .back
            ).first else {
                throw DualCameraPipelineError.configurationFailed
            }

            let frontConnection = AVCaptureConnection(inputPorts: [frontPort], output: frontOutput)
            let backConnection = AVCaptureConnection(inputPorts: [backPort], output: backOutput)
            guard session.canAddConnection(frontConnection), session.canAddConnection(backConnection) else {
                throw DualCameraPipelineError.configurationFailed
            }
            session.addConnection(frontConnection)
            session.addConnection(backConnection)
            configureConnection(frontConnection, profile: frontProfile, mirror: true)
            configureConnection(backConnection, profile: backProfile, mirror: false)
            self.frontConnection = frontConnection
            self.backConnection = backConnection
            session.commitConfiguration()
            configurationCommitted = true

            guard session.hardwareCost <= 1.0 else {
                rollbackConfiguration()
                throw DualCameraPipelineError.hardwareBudgetExceeded
            }
            guard session.systemPressureCost <= 1.0 else {
                rollbackConfiguration()
                throw DualCameraPipelineError.systemPressureExceeded
            }

            let synchronizer = AVCaptureDataOutputSynchronizer(dataOutputs: [frontOutput, backOutput])
            synchronizer.setDelegate(self, queue: outputQueue)
            self.synchronizer = synchronizer
            profile = DualCameraCaptureProfile(
                frontCamera: frontDevice.localizedName,
                backCamera: backDevice.localizedName,
                width: Int(frontProfile.dimensions.height),
                height: Int(frontProfile.dimensions.width),
                framesPerSecond: 30,
                frontFieldOfView: frontProfile.fieldOfView,
                backFieldOfView: backProfile.fieldOfView,
                frontRequestedStabilization: frontProfile.stabilizationMode,
                backRequestedStabilization: backProfile.stabilizationMode,
                hardwareCost: session.hardwareCost,
                systemPressureCost: session.systemPressureCost
            )
            configured = true
        } catch {
            if !configurationCommitted { session.commitConfiguration() }
            rollbackConfiguration()
            throw error
        }
    }

    /**
     * Construit les deux bandeaux avant de démarrer la session et l'audio.
     * Le plugin peut ainsi refuser immédiatement une capture si les ressources
     * Metal ne sont pas disponibles, sans créer de segment partiel.
     */
    func validateOverlayResources(at date: Date) throws {
        try configureIfNeeded()
        try outputQueue.sync {
            guard let frameRenderer else {
                throw DualCameraPipelineError.renderingUnavailable
            }
            try frameRenderer.updateTimestamp(date)
        }
    }

    func startSession() throws {
        try configureIfNeeded()
        if !session.isRunning { session.startRunning() }
        guard session.isRunning else { throw DualCameraPipelineError.sessionFailed }
        guard waitForActiveStabilization(frontConnection),
              waitForActiveStabilization(backConnection) else {
            session.stopRunning()
            throw DualCameraPipelineError.stabilizationUnavailable
        }
    }

    func stopSession() {
        if session.isRunning { session.stopRunning() }
    }

    func startSegment(
        frontURL: URL,
        rearURL: URL,
        id: UUID,
        startedAt: Date,
        maxDurationSeconds: TimeInterval
    ) throws {
        try outputQueue.sync {
            guard segmentWriter == nil else { throw DualCameraPipelineError.segmentAlreadyActive }
            guard let frameRenderer else {
                throw DualCameraPipelineError.renderingUnavailable
            }
            try frameRenderer.updateTimestamp(startedAt)
            segmentWriter = try DualCameraSegmentWriter(
                id: id,
                frontURL: frontURL,
                rearURL: rearURL,
                maxDurationSeconds: maxDurationSeconds
            )
            durationLimitReported = false
            resetRenderingFailureState()
        }
    }

    /**
     * Échange le writer sur la même file que les frames. Le segment suivant
     * reçoit donc l'image suivante sans attendre la finalisation du précédent.
     */
    func rotateSegment(
        frontURL: URL,
        rearURL: URL,
        id: UUID,
        startedAt: Date,
        maxDurationSeconds: TimeInterval,
        didSwitch: () -> Void,
        completion: @escaping (Result<DualCameraSegmentFiles, Error>) -> Void
    ) throws {
        try outputQueue.sync {
            guard let previous = segmentWriter else { throw DualCameraPipelineError.noActiveSegment }
            guard let frameRenderer else {
                throw DualCameraPipelineError.renderingUnavailable
            }
            let next = try DualCameraSegmentWriter(
                id: id,
                frontURL: frontURL,
                rearURL: rearURL,
                maxDurationSeconds: maxDurationSeconds
            )
            try frameRenderer.updateTimestamp(startedAt)
            segmentWriter = next
            durationLimitReported = false
            resetRenderingFailureState()
            didSwitch()
            previous.finish(completion: completion)
        }
    }

    func stopSegment(completion: @escaping (Result<DualCameraSegmentFiles, Error>) -> Void) {
        outputQueue.async {
            guard let previous = self.segmentWriter else {
                completion(.failure(DualCameraPipelineError.noActiveSegment))
                return
            }
            self.segmentWriter = nil
            self.durationLimitReported = false
            self.resetRenderingFailureState()
            previous.finish(completion: completion)
        }
    }

    func profilePayload() -> [String: Any] {
        guard let profile else { return [:] }
        return [
            "camera": "\(profile.frontCamera) + \(profile.backCamera)",
            "cameraLayout": "separateFrontBack",
            "videoFileCountPerSegment": 2,
            "width": profile.width,
            "height": profile.height,
            "framesPerSecond": profile.framesPerSecond,
            "fieldOfView": Double(profile.frontFieldOfView),
            "backFieldOfView": Double(profile.backFieldOfView),
            "zoomFactor": 1.0,
            "requestedStabilization": stabilizationName(profile.frontRequestedStabilization),
            "activeStabilization": stabilizationName(frontConnection?.activeVideoStabilizationMode ?? .off),
            "backRequestedStabilization": stabilizationName(profile.backRequestedStabilization),
            "backActiveStabilization": stabilizationName(backConnection?.activeVideoStabilizationMode ?? .off),
            "hardwareCost": Double(profile.hardwareCost),
            "systemPressureCost": Double(profile.systemPressureCost),
            "timestampOverlay": true,
            "thumbnailSafeBanner": true,
        ]
    }

    func dataOutputSynchronizer(
        _ synchronizer: AVCaptureDataOutputSynchronizer,
        didOutput synchronizedDataCollection: AVCaptureSynchronizedDataCollection
    ) {
        guard let frontData = synchronizedDataCollection.synchronizedData(for: frontOutput)
                as? AVCaptureSynchronizedSampleBufferData,
              let backData = synchronizedDataCollection.synchronizedData(for: backOutput)
                as? AVCaptureSynchronizedSampleBufferData,
              !frontData.sampleBufferWasDropped,
              !backData.sampleBufferWasDropped else { return }
        let frontSample = frontData.sampleBuffer
        let backSample = backData.sampleBuffer
        guard CMSampleBufferDataIsReady(frontSample),
              CMSampleBufferDataIsReady(backSample),
              let frontBuffer = CMSampleBufferGetImageBuffer(frontSample),
              let backBuffer = CMSampleBufferGetImageBuffer(backSample),
              let frameRenderer,
              let writer = segmentWriter else { return }

        // Un timestamp commun garantit que les deux fichiers restent alignés,
        // même si les horloges matérielles des capteurs diffèrent légèrement.
        let presentationTime = CMSampleBufferGetPresentationTimeStamp(frontSample)
        let duration = normalizedDuration(CMSampleBufferGetDuration(frontSample))
        guard let renderedFrames = frameRenderer.render(front: frontBuffer, rear: backBuffer),
              let renderedFrontSample = makeSampleBuffer(
                  pixelBuffer: renderedFrames.front.pixelBuffer,
                  formatDescription: renderedFrames.front.formatDescription,
                  presentationTime: presentationTime,
                  duration: duration
              ),
              let renderedRearSample = makeSampleBuffer(
                  pixelBuffer: renderedFrames.rear.pixelBuffer,
                  formatDescription: renderedFrames.rear.formatDescription,
                  presentationTime: presentationTime,
                  duration: duration
              ) else {
            recordRenderingFailure()
            return
        }
        resetRenderingFailureState()

        do {
            if try writer.append(
                front: renderedFrontSample,
                rear: renderedRearSample
            ), !durationLimitReported {
                durationLimitReported = true
                onDurationLimitReached?(writer.id)
            }
        } catch {
            if !durationLimitReported {
                durationLimitReported = true
                onDurationLimitReached?(writer.id)
            }
        }
    }

    private func normalizedDuration(_ duration: CMTime) -> CMTime {
        guard duration.isValid, duration.isNumeric, duration.seconds > 0 else {
            return CMTime(value: 1, timescale: 30)
        }
        return duration
    }

    private func recordRenderingFailure() {
        consecutiveRenderingFailures += 1
        guard consecutiveRenderingFailures >= 30, !renderingFailureReported else { return }
        renderingFailureReported = true
        onRenderingFailed?(
            DualCameraPipelineError.consecutiveRenderingFailures(consecutiveRenderingFailures)
        )
    }

    private func resetRenderingFailureState() {
        consecutiveRenderingFailures = 0
        renderingFailureReported = false
    }

    private func configureOutput(_ output: AVCaptureVideoDataOutput) {
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        ]
    }

    private func waitForActiveStabilization(_ connection: AVCaptureConnection?) -> Bool {
        guard let connection, connection.isVideoStabilizationSupported else { return false }
        for _ in 0..<10 {
            if connection.activeVideoStabilizationMode != .off { return true }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return connection.activeVideoStabilizationMode != .off
    }

    private func configureDevice(_ device: AVCaptureDevice, profile: CameraFormatProfile) throws {
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        device.activeFormat = profile.format
        device.videoZoomFactor = device.minAvailableVideoZoomFactor
        if device.isGeometricDistortionCorrectionSupported {
            device.isGeometricDistortionCorrectionEnabled = true
        }
        let duration = CMTime(value: 1, timescale: 30)
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration
    }

    private func configureConnection(
        _ connection: AVCaptureConnection,
        profile: CameraFormatProfile,
        mirror: Bool
    ) {
        if #available(iOS 17.0, *), connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90
        } else if connection.isVideoOrientationSupported {
            connection.videoOrientation = .portrait
        }
        if connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = mirror
        }
        if connection.isVideoStabilizationSupported {
            connection.preferredVideoStabilizationMode = profile.stabilizationMode
        }
    }

    private func selectProfile(
        for device: AVCaptureDevice,
        maximumStabilizationRank: Int
    ) -> CameraFormatProfile? {
        let all = device.formats.compactMap { format -> CameraFormatProfile? in
            let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            guard format.isMultiCamSupported,
                  format.videoSupportedFrameRateRanges.contains(where: {
                      $0.minFrameRate <= 30 && $0.maxFrameRate >= 30
                  }) else { return nil }
            let stabilization = strongestStabilizationMode(
                for: format,
                maximumRank: maximumStabilizationRank
            )
            return CameraFormatProfile(
                format: format,
                dimensions: dimensions,
                fieldOfView: format.geometricDistortionCorrectedVideoFieldOfView,
                stabilizationMode: stabilization
            )
        }
        let preferred = all.filter {
            $0.dimensions.width == 1_280 && $0.dimensions.height == 720
        }
        let fallback = all.filter {
            $0.dimensions.width <= 1_920 && $0.dimensions.height <= 1_080
        }
        let candidates = preferred.isEmpty ? fallback : preferred
        return candidates.max {
            let lhs = stabilizationRank($0.stabilizationMode) * 10_000 + Int($0.fieldOfView)
            let rhs = stabilizationRank($1.stabilizationMode) * 10_000 + Int($1.fieldOfView)
            return lhs < rhs
        }
    }

    private func strongestStabilizationMode(
        for format: AVCaptureDevice.Format,
        maximumRank: Int
    ) -> AVCaptureVideoStabilizationMode {
        if #available(iOS 18.0, *), maximumRank >= 5,
           format.isVideoStabilizationModeSupported(.cinematicExtendedEnhanced) {
            return .cinematicExtendedEnhanced
        }
        if maximumRank >= 4, format.isVideoStabilizationModeSupported(.cinematicExtended) { return .cinematicExtended }
        if maximumRank >= 3, format.isVideoStabilizationModeSupported(.cinematic) { return .cinematic }
        if maximumRank >= 2, format.isVideoStabilizationModeSupported(.standard) { return .standard }
        return .auto
    }

    private func rollbackConfiguration() {
        guard !session.inputs.isEmpty || !session.outputs.isEmpty else { return }
        session.beginConfiguration()
        for output in session.outputs { session.removeOutput(output) }
        for input in session.inputs { session.removeInput(input) }
        session.commitConfiguration()
        frontConnection = nil
        backConnection = nil
        synchronizer = nil
        profile = nil
        configured = false
    }

    private func makeSampleBuffer(
        pixelBuffer: CVPixelBuffer,
        formatDescription: CMFormatDescription,
        presentationTime: CMTime,
        duration: CMTime
    ) -> CMSampleBuffer? {
        var sampleBuffer: CMSampleBuffer?
        var timing = CMSampleTimingInfo(
            duration: duration,
            presentationTimeStamp: presentationTime,
            decodeTimeStamp: .invalid
        )
        let status = CMSampleBufferCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            dataReady: true,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: formatDescription,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        )
        return status == noErr ? sampleBuffer : nil
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
        default: return "off"
        }
    }
}

struct DualCameraSegmentFiles {
    let frontURL: URL
    let rearURL: URL
}

/**
 * Possède les deux writers d'un même segment. Les samples reçus ici ont le
 * même PTS; la limite de durée et la finalisation sont donc communes.
 */
private final class DualCameraSegmentWriter {
    let id: UUID
    private let files: DualCameraSegmentFiles
    private let frontWriter: FragmentedVideoWriter
    private let rearWriter: FragmentedVideoWriter

    init(
        id: UUID,
        frontURL: URL,
        rearURL: URL,
        maxDurationSeconds: TimeInterval
    ) throws {
        guard frontURL.standardizedFileURL != rearURL.standardizedFileURL else {
            throw DualCameraPipelineError.identicalOutputURLs
        }
        guard maxDurationSeconds.isFinite, maxDurationSeconds > 0 else {
            throw DualCameraPipelineError.invalidSegmentDuration
        }
        self.id = id
        files = DualCameraSegmentFiles(frontURL: frontURL, rearURL: rearURL)
        frontWriter = try FragmentedVideoWriter(
            id: id,
            url: frontURL,
            maxDurationSeconds: maxDurationSeconds
        )
        rearWriter = try FragmentedVideoWriter(
            id: id,
            url: rearURL,
            maxDurationSeconds: maxDurationSeconds
        )
    }

    /** Retourne true dès que les deux fichiers doivent être remplacés. */
    func append(front: CMSampleBuffer, rear: CMSampleBuffer) throws -> Bool {
        try frontWriter.prepareIfNeeded(for: front)
        try rearWriter.prepareIfNeeded(for: rear)
        let frontTimestamp = CMSampleBufferGetPresentationTimeStamp(front)
        let rearTimestamp = CMSampleBufferGetPresentationTimeStamp(rear)
        if frontWriter.hasReachedDurationLimit(at: frontTimestamp) ||
            rearWriter.hasReachedDurationLimit(at: rearTimestamp) {
            return true
        }

        // Si un encodeur subit momentanément de la contre-pression, les deux
        // images sont ignorées ensemble pour ne jamais décaler les angles.
        guard frontWriter.isReadyForMoreMediaData,
              rearWriter.isReadyForMoreMediaData else { return false }
        try frontWriter.appendPrepared(front)
        try rearWriter.appendPrepared(rear)
        return false
    }

    func finish(completion: @escaping (Result<DualCameraSegmentFiles, Error>) -> Void) {
        let group = DispatchGroup()
        let lock = NSLock()
        var firstError: Error?

        func finish(
            _ writer: FragmentedVideoWriter,
            expectedURL: URL
        ) {
            group.enter()
            writer.finish { result in
                if case .failure(let error) = result {
                    lock.lock()
                    if firstError == nil { firstError = error }
                    lock.unlock()
                } else if !FileManager.default.fileExists(atPath: expectedURL.path) {
                    lock.lock()
                    if firstError == nil { firstError = DualCameraPipelineError.writerFailed }
                    lock.unlock()
                }
                group.leave()
            }
        }

        finish(frontWriter, expectedURL: files.frontURL)
        finish(rearWriter, expectedURL: files.rearURL)
        group.notify(queue: .global(qos: .utility)) {
            lock.lock()
            let error = firstError
            lock.unlock()
            if let error {
                completion(.failure(error))
            } else {
                completion(.success(self.files))
            }
        }
    }
}

private final class FragmentedVideoWriter {
    let id: UUID
    private let url: URL
    private let maxDurationSeconds: TimeInterval
    private var assetWriter: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var firstTimestamp: CMTime?
    private var lastTimestamp: CMTime?
    private var accepting = true

    init(id: UUID, url: URL, maxDurationSeconds: TimeInterval) throws {
        self.id = id
        self.url = url
        self.maxDurationSeconds = maxDurationSeconds
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    func prepareIfNeeded(for sampleBuffer: CMSampleBuffer) throws {
        guard accepting else { throw DualCameraPipelineError.writerFailed }
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if assetWriter == nil { try prepareWriter(for: sampleBuffer, firstTimestamp: timestamp) }
    }

    func hasReachedDurationLimit(at timestamp: CMTime) -> Bool {
        guard let firstTimestamp else { return false }
        return CMTimeSubtract(timestamp, firstTimestamp).seconds >= maxDurationSeconds
    }

    var isReadyForMoreMediaData: Bool {
        accepting && assetWriter?.status == .writing && videoInput?.isReadyForMoreMediaData == true
    }

    func appendPrepared(_ sampleBuffer: CMSampleBuffer) throws {
        guard accepting else { throw DualCameraPipelineError.writerFailed }
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard let assetWriter, let videoInput else {
            throw DualCameraPipelineError.writerFailed
        }
        guard assetWriter.status == .writing else {
            throw assetWriter.error ?? DualCameraPipelineError.writerFailed
        }
        guard videoInput.isReadyForMoreMediaData,
              videoInput.append(sampleBuffer) else {
            throw assetWriter.error ?? DualCameraPipelineError.writerFailed
        }
        lastTimestamp = timestamp
    }

    func finish(completion: @escaping (Result<URL, Error>) -> Void) {
        accepting = false
        guard let assetWriter, let videoInput else {
            completion(.failure(DualCameraPipelineError.emptySegment))
            return
        }
        if let lastTimestamp { assetWriter.endSession(atSourceTime: lastTimestamp) }
        videoInput.markAsFinished()
        assetWriter.finishWriting {
            if assetWriter.status == .completed,
               FileManager.default.fileExists(atPath: self.url.path) {
                completion(.success(self.url))
            } else {
                completion(.failure(assetWriter.error ?? DualCameraPipelineError.writerFailed))
            }
        }
    }

    private func prepareWriter(for sampleBuffer: CMSampleBuffer, firstTimestamp: CMTime) throws {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            throw DualCameraPipelineError.writerFailed
        }
        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        writer.movieFragmentInterval = CMTime(seconds: 5, preferredTimescale: 600)
        if #available(iOS 17.0, *) {
            writer.initialMovieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
        }
        writer.shouldOptimizeForNetworkUse = false
        let input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 3_500_000,
                    AVVideoExpectedSourceFrameRateKey: 30,
                    AVVideoMaxKeyFrameIntervalKey: 60,
                    AVVideoAllowFrameReorderingKey: false,
                ],
            ]
        )
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw DualCameraPipelineError.writerFailed }
        writer.add(input)
        guard writer.startWriting() else {
            throw writer.error ?? DualCameraPipelineError.writerFailed
        }
        writer.startSession(atSourceTime: firstTimestamp)
        assetWriter = writer
        videoInput = input
        self.firstTimestamp = firstTimestamp
    }
}

private final class DualCameraFrameOverlayRenderer {
    private let device: MTLDevice
    private var textureCache: CVMetalTextureCache?
    private var commandQueue: MTLCommandQueue?
    private var pipeline: MTLComputePipelineState?
    private var frontOutputState = CameraRenderOutputState()
    private var rearOutputState = CameraRenderOutputState()
    private var frontLabelTexture: MTLTexture?
    private var rearLabelTexture: MTLTexture?

    init() throws {
        guard let device = MTLCreateSystemDefaultDevice(),
              let library = device.makeDefaultLibrary(),
              let function = library.makeFunction(name: "prepaTrackCameraOverlay"),
              let commandQueue = device.makeCommandQueue() else {
            throw DualCameraPipelineError.renderingUnavailable
        }
        self.device = device
        self.commandQueue = commandQueue
        pipeline = try device.makeComputePipelineState(function: function)
        var cache: CVMetalTextureCache?
        guard CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &cache) == kCVReturnSuccess,
              let cache else { throw DualCameraPipelineError.renderingUnavailable }
        textureCache = cache
    }

    func updateTimestamp(_ date: Date) throws {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "fr_FR")
        formatter.timeZone = .current
        formatter.dateFormat = "dd/MM/yyyy  HH:mm:ss"
        let timestamp = formatter.string(from: date)
        let frontLabel = try makeLabelTexture(cameraLabel: "AVANT", timestamp: timestamp)
        let rearLabel = try makeLabelTexture(cameraLabel: "ARRIÈRE", timestamp: timestamp)
        frontLabelTexture = frontLabel
        rearLabelTexture = rearLabel
    }

    /**
     * Rend les deux angles avec une seule file Metal et un seul command buffer.
     * Le CPU attend donc une fois par paire synchronisée, pas une fois par caméra.
     */
    func render(front: CVPixelBuffer, rear: CVPixelBuffer) -> RenderedCameraFrames? {
        guard prepareIfNeeded(with: front, state: &frontOutputState),
              prepareIfNeeded(with: rear, state: &rearOutputState),
              let frontPool = frontOutputState.outputPool,
              let rearPool = rearOutputState.outputPool,
              let frontOutputTexture = makeTexture(from: allocateBuffer(pool: frontPool)),
              let rearOutputTexture = makeTexture(from: allocateBuffer(pool: rearPool)),
              let frontInputTexture = makeTexture(from: front),
              let rearInputTexture = makeTexture(from: rear),
              let frontLabelTexture,
              let rearLabelTexture,
              let frontFormatDescription = frontOutputState.outputFormatDescription,
              let rearFormatDescription = rearOutputState.outputFormatDescription,
              let commandQueue,
              let pipeline,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeComputeCommandEncoder() else { return nil }

        encoder.setComputePipelineState(pipeline)
        encode(
            input: frontInputTexture.texture,
            label: frontLabelTexture,
            output: frontOutputTexture.texture,
            with: encoder,
            pipeline: pipeline
        )
        encode(
            input: rearInputTexture.texture,
            label: rearLabelTexture,
            output: rearOutputTexture.texture,
            with: encoder,
            pipeline: pipeline
        )
        encoder.endEncoding()
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()
        guard commandBuffer.status == .completed else { return nil }

        return RenderedCameraFrames(
            front: RenderedCameraFrame(
                pixelBuffer: frontOutputTexture.pixelBuffer,
                formatDescription: frontFormatDescription
            ),
            rear: RenderedCameraFrame(
                pixelBuffer: rearOutputTexture.pixelBuffer,
                formatDescription: rearFormatDescription
            )
        )
    }

    private func makeLabelTexture(cameraLabel: String, timestamp: String) throws -> MTLTexture {
        let width = 620
        let height = 124
        let bytesPerPixel = 4
        let bytesPerRow = width * bytesPerPixel
        var bitmap = [UInt8](repeating: 0, count: bytesPerRow * height)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue |
            CGImageAlphaInfo.premultipliedFirst.rawValue

        let drewLabel = bitmap.withUnsafeMutableBytes { storage -> Bool in
            guard let baseAddress = storage.baseAddress,
                  let context = CGContext(
                    data: baseAddress,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: bitmapInfo
                  ) else { return false }

            // UIKit dessine avec une origine en haut à gauche. Le bitmap brut
            // est ensuite retourné ligne par ligne avant son transfert vers
            // Metal afin que texture[y = 0] désigne bien le haut du bandeau.
            context.translateBy(x: 0, y: CGFloat(height))
            context.scaleBy(x: 1, y: -1)
            UIGraphicsPushContext(context)
            defer { UIGraphicsPopContext() }

            let size = CGSize(width: width, height: height)
            UIColor.black.withAlphaComponent(0.78).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 18).fill()
            UIColor.white.withAlphaComponent(0.92).setStroke()
            let border = UIBezierPath(
                roundedRect: CGRect(x: 2, y: 2, width: size.width - 4, height: size.height - 4),
                cornerRadius: 16
            )
            border.lineWidth = 3
            border.stroke()
            (cameraLabel as NSString).draw(
                in: CGRect(x: 20, y: 13, width: 180, height: 46),
                withAttributes: [
                    .font: UIFont.systemFont(ofSize: 34, weight: .black),
                    .foregroundColor: UIColor.white,
                ]
            )
            (timestamp as NSString).draw(
                in: CGRect(x: 20, y: 66, width: size.width - 40, height: 42),
                withAttributes: [
                    .font: UIFont.monospacedDigitSystemFont(ofSize: 30, weight: .bold),
                    .foregroundColor: UIColor.white,
                ]
            )
            context.flush()
            return true
        }

        guard drewLabel else {
            throw DualCameraPipelineError.renderingUnavailable
        }

        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm,
            width: width,
            height: height,
            mipmapped: false
        )
        descriptor.storageMode = .shared
        descriptor.usage = [.shaderRead]
        guard let labelTexture = device.makeTexture(descriptor: descriptor) else {
            throw DualCameraPipelineError.renderingUnavailable
        }
        // La transformation du CGContext produit déjà un raster UIKit avec
        // l'origine en haut à gauche. Sa première ligne correspond donc
        // directement à y = 0 dans la texture Metal.
        bitmap.withUnsafeBytes { storage in
            guard let baseAddress = storage.baseAddress else { return }
            labelTexture.replace(
                region: MTLRegionMake2D(0, 0, width, height),
                mipmapLevel: 0,
                withBytes: baseAddress,
                bytesPerRow: bytesPerRow
            )
        }
        return labelTexture
    }

    private func encode(
        input: MTLTexture,
        label: MTLTexture,
        output: MTLTexture,
        with encoder: MTLComputeCommandEncoder,
        pipeline: MTLComputePipelineState
    ) {
        let width = Float(output.width)
        let height = Float(output.height)
        let centralSquareSide = min(width, height)
        let centralSquareOrigin = SIMD2(
            (width - centralSquareSide) / 2,
            (height - centralSquareSide) / 2
        )
        let labelWidth = min(Float(label.width), centralSquareSide - 40)
        let labelHeight = labelWidth * Float(label.height) / Float(label.width)
        var parameters = OverlayParameters(
            labelPosition: SIMD2(
                centralSquareOrigin.x + (centralSquareSide - labelWidth) / 2,
                centralSquareOrigin.y + 24
            ),
            labelSize: SIMD2(labelWidth, labelHeight)
        )

        encoder.setTexture(input, index: 0)
        encoder.setTexture(label, index: 1)
        encoder.setTexture(output, index: 2)
        encoder.setBytes(&parameters, length: MemoryLayout<OverlayParameters>.size, index: 0)
        let threadWidth = pipeline.threadExecutionWidth
        let threadHeight = max(1, pipeline.maxTotalThreadsPerThreadgroup / threadWidth)
        encoder.dispatchThreads(
            MTLSize(width: Int(width), height: Int(height), depth: 1),
            threadsPerThreadgroup: MTLSize(width: threadWidth, height: threadHeight, depth: 1)
        )
    }

    private func prepareIfNeeded(
        with pixelBuffer: CVPixelBuffer,
        state: inout CameraRenderOutputState
    ) -> Bool {
        let dimensions = CMVideoDimensions(
            width: Int32(CVPixelBufferGetWidth(pixelBuffer)),
            height: Int32(CVPixelBufferGetHeight(pixelBuffer))
        )
        if state.outputPool != nil, dimensions.width == state.preparedDimensions.width,
           dimensions.height == state.preparedDimensions.height { return true }
        var pool: CVPixelBufferPool?
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
            kCVPixelBufferWidthKey as String: Int(dimensions.width),
            kCVPixelBufferHeightKey as String: Int(dimensions.height),
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
        let poolAttributes = [kCVPixelBufferPoolMinimumBufferCountKey as String: 4]
        guard CVPixelBufferPoolCreate(
            kCFAllocatorDefault,
            poolAttributes as CFDictionary,
            attributes as CFDictionary,
            &pool
        ) == kCVReturnSuccess, let pool else { return false }
        guard let sample = allocateBuffer(pool: pool) else { return false }
        var description: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: sample,
            formatDescriptionOut: &description
        ) == noErr else { return false }
        state.outputPool = pool
        state.outputFormatDescription = description
        state.preparedDimensions = dimensions
        return true
    }

    private func allocateBuffer(pool: CVPixelBufferPool) -> CVPixelBuffer? {
        var pixelBuffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(
            kCFAllocatorDefault,
            pool,
            &pixelBuffer
        ) == kCVReturnSuccess else { return nil }
        return pixelBuffer
    }

    private func makeTexture(from pixelBuffer: CVPixelBuffer?) -> MetalPixelBufferTexture? {
        guard let pixelBuffer, let textureCache else { return nil }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        var texture: CVMetalTexture?
        guard CVMetalTextureCacheCreateTextureFromImage(
            kCFAllocatorDefault,
            textureCache,
            pixelBuffer,
            nil,
            .bgra8Unorm,
            width,
            height,
            0,
            &texture
        ) == kCVReturnSuccess,
        let texture,
        let metalTexture = CVMetalTextureGetTexture(texture) else { return nil }
        return MetalPixelBufferTexture(pixelBuffer: pixelBuffer, cvTexture: texture, texture: metalTexture)
    }
}

private struct MetalPixelBufferTexture {
    let pixelBuffer: CVPixelBuffer
    let cvTexture: CVMetalTexture
    let texture: MTLTexture
}

private struct CameraRenderOutputState {
    var outputPool: CVPixelBufferPool?
    var outputFormatDescription: CMFormatDescription?
    var preparedDimensions = CMVideoDimensions(width: 0, height: 0)
}

private struct RenderedCameraFrame {
    let pixelBuffer: CVPixelBuffer
    let formatDescription: CMFormatDescription
}

private struct RenderedCameraFrames {
    let front: RenderedCameraFrame
    let rear: RenderedCameraFrame
}

private struct OverlayParameters {
    var labelPosition: SIMD2<Float>
    var labelSize: SIMD2<Float>
}

private struct CameraFormatProfile {
    let format: AVCaptureDevice.Format
    let dimensions: CMVideoDimensions
    let fieldOfView: Float
    let stabilizationMode: AVCaptureVideoStabilizationMode
}

private struct DualCameraCaptureProfile {
    let frontCamera: String
    let backCamera: String
    let width: Int
    let height: Int
    let framesPerSecond: Int
    let frontFieldOfView: Float
    let backFieldOfView: Float
    let frontRequestedStabilization: AVCaptureVideoStabilizationMode
    let backRequestedStabilization: AVCaptureVideoStabilizationMode
    let hardwareCost: Float
    let systemPressureCost: Float
}

enum DualCameraPipelineError: LocalizedError {
    case multiCamUnavailable
    case multiCamPairUnavailable
    case configurationFailed
    case hardwareBudgetExceeded
    case systemPressureExceeded
    case sessionFailed
    case segmentAlreadyActive
    case noActiveSegment
    case identicalOutputURLs
    case invalidSegmentDuration
    case emptySegment
    case writerFailed
    case renderingUnavailable
    case consecutiveRenderingFailures(Int)
    case stabilizationUnavailable

    var errorDescription: String? {
        switch self {
        case .multiCamUnavailable:
            return "La capture simultanée avant/arrière n’est pas disponible sur cet iPhone."
        case .multiCamPairUnavailable:
            return "iOS n’a trouvé aucun couple avant/arrière compatible."
        case .configurationFailed:
            return "Impossible de configurer les deux caméras."
        case .hardwareBudgetExceeded:
            return "La configuration des deux caméras dépasse la capacité matérielle disponible."
        case .systemPressureExceeded:
            return "L’iPhone est trop sollicité pour enregistrer durablement les deux caméras."
        case .sessionFailed:
            return "Les deux caméras n’ont pas pu démarrer."
        case .segmentAlreadyActive:
            return "Un segment vidéo est déjà actif."
        case .noActiveSegment:
            return "Aucun segment vidéo actif."
        case .identicalOutputURLs:
            return "Les vidéos avant et arrière doivent utiliser deux fichiers distincts."
        case .invalidSegmentDuration:
            return "La durée maximale du segment vidéo est invalide."
        case .emptySegment:
            return "Le segment vidéo ne contient aucune image."
        case .writerFailed:
            return "L’encodage du segment vidéo a échoué."
        case .renderingUnavailable:
            return "Le moteur graphique nécessaire aux deux caméras est indisponible."
        case .consecutiveRenderingFailures(let count):
            return "Le rendu vidéo des deux caméras a échoué \(count) fois de suite."
        case .stabilizationUnavailable:
            return "iOS n’a pas activé la stabilisation de la caméra avant en mode deux caméras."
        }
    }
}
