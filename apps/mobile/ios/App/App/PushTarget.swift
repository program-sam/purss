import Foundation
import Security

/// Where the notification extension fetches the real notification text from: the PURSS's address and
/// the narrow fetch credential. Stored in the Keychain, in the access group shared by the app and the
/// extension. This file is compiled into both targets so the format lives in one place.
struct PushTarget: Codable, Equatable {
    let origin: String
    let fetchToken: String

    private static let service = "app.purss.push"
    private static let account = "target"

    /// `PurssKeychainGroup` in each target's Info.plist ($(AppIdentifierPrefix)app.purss.shared).
    private static var accessGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "PurssKeychainGroup") as? String
    }

    private static func query() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group = accessGroup, !group.isEmpty {
            query[kSecAttrAccessGroup as String] = group
        }
        return query
    }

    static func load() -> PushTarget? {
        var read = query()
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(read as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(PushTarget.self, from: data)
    }

    /// Returns an error message, or nil when stored.
    @discardableResult
    static func save(_ target: PushTarget) -> String? {
        guard let group = accessGroup, !group.isEmpty else { return "The keychain access group is not configured." }
        guard let data = try? JSONEncoder().encode(target) else { return "The notification target could not be encoded." }
        SecItemDelete(query() as CFDictionary)
        var add = query()
        add[kSecAttrAccessGroup as String] = group
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        return status == errSecSuccess ? nil : "The notification target could not be saved (keychain error \(status))."
    }

    /// Returns an error message, or nil when the item is gone (also when it was never there).
    @discardableResult
    static func delete() -> String? {
        let status = SecItemDelete(query() as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
            ? nil : "The notification target could not be removed (keychain error \(status))."
    }
}

/// Whether a 401 answer says a credential is gone for good: its error code must be `code` (`device_signed_out`
/// for the device token, `push_signed_out` for the fetch credential), as the page's transport requires. Any
/// other 401 (a proxy, a captive portal, a server mid-restart) is a failure to try again later. Compiled into
/// the app and the notification extension.
enum SignedOut {
    static func says(_ data: Data?, code: String) -> Bool {
        guard let data = data,
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let error = json["error"] as? [String: Any] else { return false }
        return error["code"] as? String == code
    }
}

/// Refuses every redirect, for sessions whose requests carry a credential: it goes only to the address it was
/// sent to (the 3xx answer comes back as the answer, a failure). Compiled into the app and the notification extension.
final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
