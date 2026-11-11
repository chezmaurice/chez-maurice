#if os(iOS)
import Foundation
import Security
import UIKit

/// The households this iPhone or iPad is paired to, as the Maurice app and
/// Carnet both see them (11 November 2026): joining a household, signing in,
/// signing out or forgetting one in either app is the same in the other, at
/// once. The same file lives in both apps (maurice/app/Maurice/Services,
/// carnet/CarnetApp/Services).
///
/// One Keychain item in an access group both apps hold (`keychain-access-groups`
/// in their entitlements; the team's profiles allow any group under its prefix),
/// written whole by whichever app changed something, then announced by a Darwin
/// notification. The other app reads it when told, or when it comes back to the
/// foreground, since a suspended app is not told. Each app keeps its own copy
/// in its own format (its local household ids, its own token items): this is
/// what the two agree on, households known by their address and their key.
struct SharedPairings: Codable, Equatable {
    struct Member: Codable, Equatable {
        let id: String
        var display_name: String
        var avatar_color: String
        var has_pin: Bool
        var role: String?
        var avatar_url: String?
        var username: String?
    }

    struct Household: Codable, Equatable {
        var server: String
        /// The household's identity key, once pinned (`/api/health`).
        var key: String?
        var name: String
        var color: String?
        var icon: String?
        var members: [Member]
        var active: String?
        /// Each signed-in member's session, by member id.
        var tokens: [String: String]

        /// The same household: the same key when both are known (it may have
        /// moved), else the same address.
        func same(server: String, key: String?) -> Bool {
            if let key, let mine = self.key { return key == mine }
            return server == self.server
        }
    }

    var households: [Household]
    /// The address of the household on screen.
    var current: String?

    func index(server: String, key: String?) -> Int? {
        households.firstIndex { $0.same(server: server, key: key) }
    }

    /// Fold another app's pairings in, the first time an app joins: what this
    /// one already holds wins, what only the other knows is added.
    mutating func absorb(_ other: SharedPairings) {
        for theirs in other.households {
            guard let i = index(server: theirs.server, key: theirs.key) else {
                households.append(theirs)
                continue
            }
            var h = households[i]
            for m in theirs.members where !h.members.contains(where: { $0.id == m.id }) { h.members.append(m) }
            h.tokens.merge(theirs.tokens) { mine, _ in mine }
            if h.key == nil { h.key = theirs.key }
            if h.active == nil { h.active = theirs.active }
            households[i] = h
        }
        if current == nil { current = other.current }
    }

    // MARK: - Keychain

    /// The team's prefix and a group of its own: both apps list it.
    private static let accessGroup = "F5B4ZC8LEU.eu.chezmaurice.shared"
    private static let notifyName = "eu.chezmaurice.shared.pairings"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "eu.chezmaurice.shared",
         kSecAttrAccount as String: "pairings",
         kSecAttrAccessGroup as String: accessGroup]
    }

    static func read() -> SharedPairings? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(SharedPairings.self, from: data)
    }

    /// Store these pairings and tell the other app.
    func write() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(self) else { return }
        var status = SecItemUpdate(Self.query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = Self.query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            print("[pairings] could not store the shared pairings: \(status)")
            return
        }
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             CFNotificationName(Self.notifyName as CFString), nil, nil, true)
    }

    /// Call `changed` on the main queue whenever the other app may have
    /// written: told by it, or back in the foreground.
    static func observe(_ changed: @escaping () -> Void) {
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
            DispatchQueue.main.async { NotificationCenter.default.post(name: .sharedPairingsChanged, object: nil) }
        }, notifyName as CFString, nil, .deliverImmediately)
        for name in [Notification.Name.sharedPairingsChanged, UIApplication.willEnterForegroundNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in changed() }
        }
    }
}

extension Notification.Name {
    static let sharedPairingsChanged = Notification.Name("eu.chezmaurice.sharedPairingsChanged")
}
#endif
