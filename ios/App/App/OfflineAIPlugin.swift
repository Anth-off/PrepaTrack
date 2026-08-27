import Capacitor
import CryptoKit
import Foundation
import OfflineAIKit
import UIKit

@objc(OfflineAIPlugin)
public final class OfflineAIPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDownloadDelegate {
    public let identifier = "OfflineAIPlugin"
    public let jsName = "OfflineAI"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "analyze", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVisionEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "captureTrainingSample", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportTrainingDataset", returnType: CAPPluginReturnPromise),
    ]

    private let modelVersion = "qwen3-0.6b-q4km-1208e45"
    private let modelBytes: Int64 = 396_704_416
    private let modelSHA256 = "b0638f08417a2d3c8652760462eb5407c6e30173cf9608ad0820757a281eea0e"
    private let modelURL = URL(string: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/1208e45d782fe18602c5eaf10e5758d5b0f24c03/Qwen3-0.6B-Q4_K_M.gguf?download=true")!
    private var downloadCall: CAPPluginCall?
    private var downloadSession: URLSession!

    public override func load() {
        let configuration = URLSessionConfiguration.default
        configuration.allowsCellularAccess = false
        configuration.allowsExpensiveNetworkAccess = false
        configuration.waitsForConnectivity = true
        downloadSession = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        OfflineVisionAnalyzer.shared.onObservation = { [weak self] observation in
            self?.notifyListeners("visionObservation", data: [
                "at": observation.at.timeIntervalSince1970 * 1_000,
                "kind": observation.kind,
                "confidence": observation.confidence,
                "durationMs": observation.durationMs,
            ])
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        var result: [String: Any] = [
            "available": true,
            "ready": validInstalledModel(),
            "version": modelVersion,
            "bytes": modelBytes,
        ]
        result.merge(OfflineVisionAnalyzer.shared.diagnostics()) { _, new in new }
        call.resolve(result)
    }

    @objc func downloadModel(_ call: CAPPluginCall) {
        guard downloadCall == nil else { call.reject("Un téléchargement est déjà en cours."); return }
        if validInstalledModel() { call.resolve(["ready": true]); return }
        downloadCall = call
        downloadSession.downloadTask(with: modelURL).resume()
    }

    @objc func deleteModel(_ call: CAPPluginCall) {
        do {
            if FileManager.default.fileExists(atPath: installedModelURL.path) {
                try FileManager.default.removeItem(at: installedModelURL)
            }
            call.resolve(["ready": false])
        } catch { call.reject("Le modèle n’a pas pu être supprimé.", nil, error) }
    }

    @objc func analyze(_ call: CAPPluginCall) {
        guard validInstalledModel() else { call.reject("Le modèle hors ligne n’est pas installé."); return }
        guard ProcessInfo.processInfo.thermalState != .critical else {
            call.reject("L’analyse est suspendue pour protéger l’enregistrement vidéo."); return
        }
        guard let diagnosis = call.getObject("diagnosis"),
              JSONSerialization.isValidJSONObject(diagnosis),
              let json = try? JSONSerialization.data(withJSONObject: diagnosis),
              let facts = String(data: json, encoding: .utf8) else {
            call.reject("Diagnostic invalide."); return
        }
        let prompt = """
        <|im_start|>system
        Tu es le coach local de PrepaTrack. Réponds en français, factuel et direct. Ne change aucun chiffre. Ne crée aucune cause. Retourne uniquement un objet JSON avec title, explanation et action, chacun en une phrase courte. /no_think
        <|im_end|>
        <|im_start|>user
        Reformule ce diagnostic déterministe sans ajouter de fait : \(facts)
        <|im_end|>
        <|im_start|>assistant
        """
        Task.detached(priority: .utility) {
            do {
                let started = Date()
                let engine = try OfflineLlamaEngine(modelURL: self.installedModelURL)
                let raw = try await engine.generate(prompt: prompt, maximumTokens: 96)
                guard let output = self.validatedOutput(raw, allowedNumbers: self.numbers(in: facts)) else {
                    throw NSError(domain: "OfflineAI", code: 30, userInfo: [NSLocalizedDescriptionKey: "Réponse locale invalide."])
                }
                await MainActor.run {
                    var safeOutput = output
                    // L'action reste celle du moteur déterministe. Le modèle ne peut
                    // ni inventer une consigne ni modifier la décision métier.
                    safeOutput["action"] = diagnosis["action"] as? String ?? ""
                    UINotificationFeedbackGenerator().notificationOccurred(.warning)
                    call.resolve(safeOutput.merging([
                        "modelVersion": self.modelVersion,
                        "latencyMs": Int(Date().timeIntervalSince(started) * 1_000),
                    ]) { _, new in new })
                }
            } catch {
                await MainActor.run { call.reject("Le modèle local n’a pas produit de diagnostic fiable.", nil, error) }
            }
        }
    }

    @objc func setVisionEnabled(_ call: CAPPluginCall) {
        OfflineVisionAnalyzer.shared.setEnabled(call.getBool("enabled") ?? false)
        call.resolve()
    }

    @objc func captureTrainingSample(_ call: CAPPluginCall) {
        guard let label = call.getString("label"), !label.isEmpty else { call.reject("Libellé manquant."); return }
        do {
            let url = try OfflineVisionAnalyzer.shared.saveTrainingSample(label: label)
            call.resolve(["filename": url.lastPathComponent])
        } catch { call.reject(error.localizedDescription, nil, error) }
    }

    @objc func exportTrainingDataset(_ call: CAPPluginCall) {
        let directory = OfflineVisionAnalyzer.shared.trainingDirectory()
        DispatchQueue.main.async {
            let controller = UIActivityViewController(activityItems: [directory], applicationActivities: nil)
            self.bridge?.viewController?.present(controller, animated: true)
            call.resolve()
        }
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        notifyListeners("modelDownloadProgress", data: [
            "downloaded": totalBytesWritten,
            "total": totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : modelBytes,
        ])
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let call = downloadCall else { return }
        do {
            let values = try location.resourceValues(forKeys: [.fileSizeKey])
            guard Int64(values.fileSize ?? 0) == modelBytes, try sha256(location) == modelSHA256 else {
                throw NSError(domain: "OfflineAI", code: 31, userInfo: [NSLocalizedDescriptionKey: "Le contrôle d’intégrité du modèle a échoué."])
            }
            try FileManager.default.createDirectory(at: modelDirectory, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: installedModelURL.path) {
                _ = try FileManager.default.replaceItemAt(installedModelURL, withItemAt: location)
            } else {
                try FileManager.default.moveItem(at: location, to: installedModelURL)
            }
            var valuesToSet = URLResourceValues()
            valuesToSet.isExcludedFromBackup = true
            valuesToSet.fileProtection = .completeUntilFirstUserAuthentication
            var mutable = installedModelURL
            try mutable.setResourceValues(valuesToSet)
            downloadCall = nil
            call.resolve(["ready": true])
        } catch {
            downloadCall = nil
            call.reject(error.localizedDescription, nil, error)
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, let call = downloadCall else { return }
        downloadCall = nil
        call.reject("Le téléchargement Wi‑Fi a été interrompu.", nil, error)
    }

    private var modelDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PrepaTrack/AI", isDirectory: true)
    }
    private var installedModelURL: URL { modelDirectory.appendingPathComponent("\(modelVersion).gguf") }

    private func validInstalledModel() -> Bool {
        guard let size = try? installedModelURL.resourceValues(forKeys: [.fileSizeKey]).fileSize else { return false }
        return Int64(size) == modelBytes
    }

    private func sha256(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let data = try handle.read(upToCount: 4 * 1_024 * 1_024) ?? Data()
            if data.isEmpty { break }
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func validatedOutput(_ raw: String, allowedNumbers: Set<String>) -> [String: Any]? {
        guard let start = raw.firstIndex(of: "{"), let end = raw.lastIndex(of: "}") else { return nil }
        let json = String(raw[start...end])
        guard numbers(in: json).isSubset(of: allowedNumbers),
              let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let title = object["title"] as? String, !title.isEmpty, title.count <= 140,
              let explanation = object["explanation"] as? String, !explanation.isEmpty, explanation.count <= 280,
              let action = object["action"] as? String, !action.isEmpty, action.count <= 220 else { return nil }
        return ["title": title, "explanation": explanation, "action": action]
    }

    private func numbers(in value: String) -> Set<String> {
        guard let regex = try? NSRegularExpression(pattern: #"\d+(?:[.,]\d+)?"#) else { return [] }
        let range = NSRange(value.startIndex..., in: value)
        return Set(regex.matches(in: value, range: range).compactMap {
            Range($0.range, in: value).map { String(value[$0]).replacingOccurrences(of: ",", with: ".") }
        })
    }
}
