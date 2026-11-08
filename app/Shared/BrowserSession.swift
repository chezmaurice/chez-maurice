import Foundation
import Security

/// The session the Safari extension saves with. The app publishes the active
/// member's whenever it changes; the extension (MauriceSafariExtension) reads
/// it when its popup asks, so Safari needs no sign-in of its own: whoever is
/// signed in to the app is who saves. Kept in the keychain under the app
/// group, as the push keys are (PushSeal.swift).
enum BrowserSession {
    static let group = "group.eu.chezmaurice.maurice"
    private static let service = "eu.chezmaurice.maurice.browser"
    private static let account = "active"

    struct Value: Codable, Equatable {
        let serverUrl: String
        let token: String
        let member: Member?
        let household: String?
        struct Member: Codable, Equatable {
            let name: String
            let color: String?
        }
    }

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrAccessGroup as String: group,
         // On the Mac, the keychain an app group can share (iOS has no other).
         kSecUseDataProtectionKeychain as String: true]
    }

    /// The active session, or nil to withdraw it (signed out, no member).
    static func publish(_ value: Value?) {
        guard let value, let data = try? JSONEncoder().encode(value) else {
            SecItemDelete(query as CFDictionary)
            return
        }
        if read() == value { return }
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            status = SecItemAdd(add as CFDictionary, nil)
        }
        if status != errSecSuccess { print("[browser] could not publish the session: \(status)") }
    }

    static func read() -> Value? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Value.self, from: data)
    }
}
