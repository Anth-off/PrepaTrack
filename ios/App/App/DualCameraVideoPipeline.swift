import AVFoundation
import CoreImage
import CoreMedia
import CoreVideo
import Metal
import MetalKit
import UIKit

/**
 * Capture simultanément les caméras avant et arrière dans un flux 720p/30.
 *
 * La caméra avant reste l'image principale afin de préserver le cadrage des
 * versions précédentes. La caméra arrière est incrustée. Le bandeau temporel
 * est rendu dans la même passe Metal que le PiP : il est donc présent dans
 * toutes les images et dans toute miniature choisie par Photos.
 */
final class DualCameraVideoPipeline: NSObject, AVCaptureDataOutputSynchronizerDelegate {
    private let session = AVCaptureMultiCamSession()
    private let outputQueue = DispatchQueue(
        label: "com.n0thytvoff.prepatrack.recording.video",
        qos: .userInitiated
    )
    private let frontOutput = AVCaptureVideoDataOutput()
    private let backOutput = AVCaptureVideoDataOutput()
    private var mixer: DualCameraFrameMixer?
    private var synchronizer: AVCaptureDataOutputSynchronizer?

    private var configured = false
    private var profile: DualCameraCaptureProfile?
    private var frontConnection: AVCaptureConnection?
    private var backConnection: AVCaptureConnection?
    private var writer: FragmentedVideoWriter?
    private var durationLimitReported = false
    private var sessionObservers: [NSObjectProtocol] = []

    var onDurationLimitReached: ((UUID) -> Void)?
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
    }

    deinit {
        for observer in sessionObservers { NotificationCenter.default.removeObserver(observer) }
    }

    var isSessionRunning: Bool { session.isRunning }

    var isRecording: Bool {
        outputQueue.sync { writer != nil }
    }

    func configureIfNeeded() throws {
        guard !configured else { return }
        guard AVCaptureMultiCamSession.isMultiCamSupported else {
            throw DualCameraPipelineError.multiCamUnavailable
        }
        mixer = try DualCameraFrameMixer()

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

    func startSession() throws {
        try configureIfNeeded()
        if !session.isRunning { session.startRunning() }
        guard session.isRunning else { throw DualCameraPipelineError.sessionFailed }
        guard waitForActiveStabilization(frontConnection) else {
            session.stopRunning()
            throw DualCameraPipelineError.stabilizationUnavailable
        }
    }

    func stopSession() {
        if session.isRunning { session.stopRunning() }
    }

    func startSegment(
        to url: URL,
        id: UUID,
        startedAt: Date,
        maxDurationSeconds: TimeInterval
    ) throws {
        try outputQueue.sync {
            guard writer == nil else { throw DualCameraPipelineError.segmentAlreadyActive }
            guard let mixer else { throw DualCameraPipelineError.renderingUnavailable }
            mixer.updateTimestamp(startedAt)
            writer = try FragmentedVideoWriter(
                id: id,
                url: url,
                maxDurationSeconds: maxDurationSeconds
            )
            durationLimitReported = false
        }
    }

    /**
     * Échange le writer sur la même file que les frames. Le segment suivant
     * reçoit donc l'image suivante sans attendre la finalisation du précédent.
     */
    func rotateSegment(
        to url: URL,
        id: UUID,
        startedAt: Date,
        maxDurationSeconds: TimeInterval,
        didSwitch: () -> Void,
        completion: @escaping (Result<URL, Error>) -> Void
    ) throws {
        try outputQueue.sync {
            guard let previous = writer else { throw DualCameraPipelineError.noActiveSegment }
            guard let mixer else { throw DualCameraPipelineError.renderingUnavailable }
            let next = try FragmentedVideoWriter(id: id, url: url, maxDurationSeconds: maxDurationSeconds)
            mixer.updateTimestamp(startedAt)
            writer = next
            durationLimitReported = false
            didSwitch()
            previous.finish(completion: completion)
        }
    }

    func stopSegment(completion: @escaping (Result<URL, Error>) -> Void) {
        outputQueue.async {
            guard let previous = self.writer else {
                completion(.failure(DualCameraPipelineError.noActiveSegment))
                return
            }
            self.writer = nil
            self.durationLimitReported = false
            previous.finish(completion: completion)
        }
    }

    func profilePayload() -> [String: Any] {
        guard let profile else { return [:] }
        return [
            "camera": "\(profile.frontCamera) + \(profile.backCamera)",
            "cameraLayout": "frontFullBackPiP",
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
              let mixer,
              let writer else { return }

        guard let mixed = mixer.mix(fullScreen: frontBuffer, pictureInPicture: backBuffer),
              let formatDescription = mixer.outputFormatDescription,
              let mixedSample = makeSampleBuffer(
                  pixelBuffer: mixed,
                  formatDescription: formatDescription,
                  presentationTime: CMSampleBufferGetPresentationTimeStamp(frontSample),
                  duration: CMSampleBufferGetDuration(frontSample)
              ) else { return }

        do {
            if try writer.append(mixedSample), !durationLimitReported {
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

    /** Retourne true quand la limite du segment est atteinte. */
    func append(_ sampleBuffer: CMSampleBuffer) throws -> Bool {
        guard accepting else { return true }
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if let firstTimestamp,
           CMTimeSubtract(timestamp, firstTimestamp).seconds >= maxDurationSeconds {
            return true
        }
        if assetWriter == nil { try prepareWriter(for: sampleBuffer, firstTimestamp: timestamp) }
        guard let assetWriter, let videoInput else {
            throw DualCameraPipelineError.writerFailed
        }
        guard assetWriter.status == .writing else {
            throw assetWriter.error ?? DualCameraPipelineError.writerFailed
        }
        if videoInput.isReadyForMoreMediaData {
            guard videoInput.append(sampleBuffer) else {
                throw assetWriter.error ?? DualCameraPipelineError.writerFailed
            }
            lastTimestamp = timestamp
        }
        return false
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

private final class DualCameraFrameMixer {
    private let device: MTLDevice
    private var textureCache: CVMetalTextureCache?
    private var commandQueue: MTLCommandQueue?
    private var pipeline: MTLComputePipelineState?
    private var outputPool: CVPixelBufferPool?
    private(set) var outputFormatDescription: CMFormatDescription?
    private var preparedDimensions = CMVideoDimensions(width: 0, height: 0)
    private var labelTexture: MTLTexture?

    init() throws {
        guard let device = MTLCreateSystemDefaultDevice(),
              let library = device.makeDefaultLibrary(),
              let function = library.makeFunction(name: "prepaTrackDualCameraMixer"),
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

    func updateTimestamp(_ date: Date) {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "fr_FR")
        formatter.timeZone = .current
        formatter.dateFormat = "dd/MM/yyyy  HH:mm:ss"
        let text = formatter.string(from: date)
        let size = CGSize(width: 520, height: 72)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            UIColor.black.withAlphaComponent(0.72).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 16).fill()
            (text as NSString).draw(
                in: CGRect(x: 18, y: 15, width: size.width - 36, height: size.height - 24),
                withAttributes: [
                    .font: UIFont.monospacedDigitSystemFont(ofSize: 30, weight: .bold),
                    .foregroundColor: UIColor.white,
                ]
            )
        }
        if let cgImage = image.cgImage {
            labelTexture = try? MTKTextureLoader(device: device).newTexture(
                cgImage: cgImage,
                options: [.SRGB: false]
            )
        }
    }

    func mix(fullScreen: CVPixelBuffer, pictureInPicture: CVPixelBuffer?) -> CVPixelBuffer? {
        guard prepareIfNeeded(with: fullScreen),
              let outputPool,
              let outputTexture = makeTexture(from: allocateBuffer(pool: outputPool)),
              let fullTexture = makeTexture(from: fullScreen),
              let pipTexture = makeTexture(from: pictureInPicture ?? fullScreen),
              let labelTexture,
              let commandQueue,
              let pipeline,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeComputeCommandEncoder() else { return nil }

        let outputBuffer = outputTexture.pixelBuffer
        let width = Float(outputTexture.texture.width)
        let height = Float(outputTexture.texture.height)
        let pipWidth = width * 0.34
        let pipHeight = height * 0.34
        var parameters = MixerParameters(
            pipPosition: SIMD2(width - pipWidth - 20, height - pipHeight - 20),
            pipSize: SIMD2(pipWidth, pipHeight),
            labelPosition: SIMD2(20, 20),
            labelSize: SIMD2(min(Float(labelTexture.width), width - 40), Float(labelTexture.height)),
            pipBorderWidth: 4
        )

        encoder.setComputePipelineState(pipeline)
        encoder.setTexture(fullTexture.texture, index: 0)
        encoder.setTexture(pipTexture.texture, index: 1)
        encoder.setTexture(labelTexture, index: 2)
        encoder.setTexture(outputTexture.texture, index: 3)
        encoder.setBytes(&parameters, length: MemoryLayout<MixerParameters>.size, index: 0)
        let threadWidth = pipeline.threadExecutionWidth
        let threadHeight = max(1, pipeline.maxTotalThreadsPerThreadgroup / threadWidth)
        encoder.dispatchThreads(
            MTLSize(width: Int(width), height: Int(height), depth: 1),
            threadsPerThreadgroup: MTLSize(width: threadWidth, height: threadHeight, depth: 1)
        )
        encoder.endEncoding()
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()
        guard commandBuffer.status == .completed else { return nil }
        return outputBuffer
    }

    private func prepareIfNeeded(with pixelBuffer: CVPixelBuffer) -> Bool {
        let dimensions = CMVideoDimensions(
            width: Int32(CVPixelBufferGetWidth(pixelBuffer)),
            height: Int32(CVPixelBufferGetHeight(pixelBuffer))
        )
        if outputPool != nil, dimensions.width == preparedDimensions.width,
           dimensions.height == preparedDimensions.height { return true }
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
        outputPool = pool
        outputFormatDescription = description
        preparedDimensions = dimensions
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

private struct MixerParameters {
    var pipPosition: SIMD2<Float>
    var pipSize: SIMD2<Float>
    var labelPosition: SIMD2<Float>
    var labelSize: SIMD2<Float>
    var pipBorderWidth: Float
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
    case emptySegment
    case writerFailed
    case renderingUnavailable
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
        case .emptySegment:
            return "Le segment vidéo ne contient aucune image."
        case .writerFailed:
            return "L’encodage du segment vidéo a échoué."
        case .renderingUnavailable:
            return "Le moteur graphique nécessaire aux deux caméras est indisponible."
        case .stabilizationUnavailable:
            return "iOS n’a pas activé la stabilisation de la caméra avant en mode deux caméras."
        }
    }
}
