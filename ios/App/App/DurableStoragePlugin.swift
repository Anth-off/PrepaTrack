import Capacitor
import Foundation
import Security

@objc(DurableStoragePlugin)
public final class DurableStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DurableStoragePlugin"
    public let jsName = "DurableStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSession", returnType: CAPPluginReturnPromise),
    ]

    private var backupDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = base.appendingPathComponent("PrepaTrack", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private var backupURL: URL { backupDirectory.appendingPathComponent("durable-backup.json") }
    private var previousURL: URL { backupDirectory.appendingPathComponent("durable-backup.previous.json") }

    @objc func save(_ call: CAPPluginCall) {
        guard let value = call.getString("data"), let data = value.data(using: .utf8) else {
            call.reject("Sauvegarde native invalide")
            return
        }
        do {
            // Ne jamais remplacer une copie saine par un JSON tronqué ou invalide.
            _ = try JSONSerialization.jsonObject(with: data)
            if let current = validData(at: backupURL) {
                try current.write(
                    to: previousURL,
                    options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
                )
            }
            try data.write(to: backupURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            call.resolve(metadata(for: backupURL, source: "current"))
        } catch {
            call.reject("Impossible d’écrire la sauvegarde native", nil, error)
        }
    }

    @objc func load(_ call: CAPPluginCall) {
        let selected: (Data, URL, String)?
        if let current = validData(at: backupURL) {
            selected = (current, backupURL, "current")
        } else if let previous = validData(at: previousURL) {
            selected = (previous, previousURL, "previous")
        } else {
            selected = nil
        }
        guard let (data, url, source) = selected,
              let value = String(data: data, encoding: .utf8) else {
            call.resolve(["data": NSNull()])
            return
        }
        var result = metadata(for: url, source: source)
        result["data"] = value
        call.resolve(result)
    }

    @objc func status(_ call: CAPPluginCall) {
        if validData(at: backupURL) != nil {
            call.resolve(metadata(for: backupURL, source: "current"))
        } else if validData(at: previousURL) != nil {
            call.resolve(metadata(for: previousURL, source: "previous"))
        } else {
            call.resolve(["available": false])
        }
    }

    @objc func saveSession(_ call: CAPPluginCall) {
        guard let value = call.getString("data"), let data = value.data(using: .utf8) else {
            call.reject("Session native invalide")
            return
        }
        guard (try? JSONSerialization.jsonObject(with: data)) != nil else {
            call.reject("Session native illisible")
            return
        }
        let query = keychainQuery()
        let values: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            values.forEach { item[$0.key] = $0.value }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Impossible de protéger la session")
        }
    }

    @objc func loadSession(_ call: CAPPluginCall) {
        var query = keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.resolve(["data": NSNull()])
            return
        }
        call.resolve(["data": value])
    }

    @objc func clearSession(_ call: CAPPluginCall) {
        let status = SecItemDelete(keychainQuery() as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Impossible d’effacer la session protégée")
        }
    }

    private func keychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.n0thytvoff.prepatrack",
            kSecAttrAccount as String: "supabase-session",
        ]
    }

    private func validData(at url: URL) -> Data? {
        guard let data = try? Data(contentsOf: url),
              (try? JSONSerialization.jsonObject(with: data)) != nil else { return nil }
        return data
    }

    private func metadata(for url: URL, source: String) -> [String: Any] {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let modifiedAt = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let bytes = attributes?[.size] as? NSNumber
        return [
            "available": true,
            "savedAt": modifiedAt * 1_000,
            "bytes": bytes?.intValue ?? 0,
            "source": source,
            "redundant": validData(at: previousURL) != nil,
        ]
    }
}
