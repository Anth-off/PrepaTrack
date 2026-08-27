import AVFoundation
import CoreImage
import UIKit
import Vision

struct OfflineVisionObservation {
    let at: Date
    let kind: String
    let confidence: Double
    let durationMs: Int
}

/** Échantillonneur borné : la file caméra ne patiente jamais après Vision. */
final class OfflineVisionAnalyzer {
    static let shared = OfflineVisionAnalyzer()

    private let queue = DispatchQueue(label: "com.n0thytvoff.prepatrack.ai.vision", qos: .utility)
    private let lock = NSLock()
    private var busy = false
    private var enabled = false
    private var lastAcceptedAt = Date.distantPast
    private var latestBuffer: CVPixelBuffer?
    private var candidateKind: String?
    private var candidateStartedAt: Date?
    var onObservation: ((OfflineVisionObservation) -> Void)?

    private init() {
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in self?.discardTransientState() }
    }

    func setEnabled(_ value: Bool) {
        lock.lock(); enabled = value; lock.unlock()
        if !value { discardTransientState() }
    }

    func submit(_ pixelBuffer: CVPixelBuffer, at: Date = Date()) {
        lock.lock()
        let thermal = ProcessInfo.processInfo.thermalState
        let interval: TimeInterval = thermal == .serious ? 5 : 1
        let allowed = enabled && thermal != .critical && !busy && at.timeIntervalSince(lastAcceptedAt) >= interval
        if allowed {
            busy = true
            lastAcceptedAt = at
            latestBuffer = pixelBuffer
        }
        lock.unlock()
        guard allowed else { return }

        queue.async { [weak self] in
            self?.analyze(pixelBuffer, at: at)
            self?.lock.lock(); self?.busy = false; self?.lock.unlock()
        }
    }

    private func analyze(_ pixelBuffer: CVPixelBuffer, at: Date) {
        let request = VNDetectHumanRectanglesRequest()
        request.upperBodyOnly = false
        do {
            try VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .right).perform([request])
        } catch { return }
        let people = request.results ?? []
        let central = CGRect(x: 0.25, y: 0.15, width: 0.5, height: 0.7)
        let inPath = people.filter { $0.boundingBox.intersects(central) }
        let kind: String?
        let confidence: Double
        if people.count >= 2 {
            kind = "congestion"
            confidence = Double(people.map(\.confidence).max() ?? 0)
        } else if let person = inPath.max(by: { $0.confidence < $1.confidence }) {
            kind = "person_in_path"
            confidence = Double(person.confidence)
        } else {
            kind = nil
            confidence = 0
        }

        if candidateKind != kind {
            candidateKind = kind
            candidateStartedAt = kind == nil ? nil : at
        }
        guard let kind, confidence >= 0.65, let started = candidateStartedAt else { return }
        let duration = max(0, Int(at.timeIntervalSince(started) * 1_000))
        guard duration >= 3_000 else { return }
        onObservation?(OfflineVisionObservation(at: at, kind: kind, confidence: confidence, durationMs: duration))
    }

    func saveTrainingSample(label: String) throws -> URL {
        lock.lock(); let buffer = latestBuffer; lock.unlock()
        guard let buffer else { throw NSError(domain: "OfflineAI", code: 20, userInfo: [NSLocalizedDescriptionKey: "Aucune image caméra disponible."]) }
        let safe = label.replacingOccurrences(of: "[^a-zA-Z0-9_-]", with: "-", options: .regularExpression)
        let root = trainingDirectory()
        let url = root.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1_000))-\(safe).jpg")
        let image = CIImage(cvPixelBuffer: buffer)
        let context = CIContext(options: [.useSoftwareRenderer: true])
        guard let color = CGColorSpace(name: CGColorSpace.sRGB),
              let data = context.jpegRepresentation(of: image, colorSpace: color, options: [:]) else {
            throw NSError(domain: "OfflineAI", code: 21, userInfo: [NSLocalizedDescriptionKey: "La miniature n’a pas pu être créée."])
        }
        try data.write(to: url, options: Data.WritingOptions.atomic)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: url.path
        )
        return url
    }

    func trainingDirectory() -> URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PrepaTrack/AITraining", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = root
        try? mutable.setResourceValues(values)
        return root
    }

    func diagnostics() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return [
            "visionEnabled": enabled,
            "visionBusy": busy,
            "thermal": ProcessInfo.processInfo.thermalState.label,
            "samplingSeconds": ProcessInfo.processInfo.thermalState == .serious ? 5 : 1,
        ]
    }

    private func discardTransientState() {
        lock.lock()
        latestBuffer = nil
        candidateKind = nil
        candidateStartedAt = nil
        lock.unlock()
    }
}

private extension ProcessInfo.ThermalState {
    var label: String {
        switch self {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }
}
