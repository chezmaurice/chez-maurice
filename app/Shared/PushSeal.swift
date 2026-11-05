import CryptoKit
import Foundation
import Security

/// Pushes sealed for this device. The app gives each household it registers
/// with a P-256 public key and a 16-byte secret, as a Web Push subscription
/// does; the household encrypts every push to them (RFC 8291, aes128gcm), so
/// Apple — and, for a household without the APNs key, Chez Maurice's push
/// relay — carries "New message" and a blob. The notification service
/// extension opens the blob and shows who wrote and what.
///
/// The keys live in the keychain under the app group, which both the app and
/// the extension belong to, readable after the first unlock: a push arrives on
/// a locked phone. The same file is compiled into Carnet, with its own group.
enum PushSeal {
    static let group = "group.eu.chezmaurice.maurice"
    private static let service = "eu.chezmaurice.push-seal"
    private static let account = "v1"

    struct Keys: Encodable { let p256dh: String; let auth: String }

    /// The keys households seal this device's pushes to, made the first time.
    static func keys() -> Keys? {
        guard let (key, auth) = stored() ?? made() else { return nil }
        return Keys(p256dh: base64URL(key.publicKey.x963Representation), auth: base64URL(auth))
    }

    /// A push's sealed content, opened: `title`, `body`, `conversationId`,
    /// `householdTag`. Nil if it was not sealed for this device.
    static func open(_ sealed: String) -> [String: Any]? {
        guard let (key, auth) = stored() else { return nil }
        return open(sealed, key: key, auth: auth)
    }

    static func open(_ sealed: String, key: P256.KeyAgreement.PrivateKey, auth: Data) -> [String: Any]? {
        guard let blob = fromBase64URL(sealed) else { return nil }
        let b = [UInt8](blob)
        // RFC 8188 header: salt (16), record size (4), key id length (1), key id — the sender's public key.
        guard b.count > 21 else { return nil }
        let idLength = Int(b[20])
        guard b.count >= 21 + idLength + 16 else { return nil }
        let salt = Data(b[0..<16])
        let senderKey = Data(b[21..<(21 + idLength)])
        let sealedRecord = Data(b[(21 + idLength)...])

        guard let sender = try? P256.KeyAgreement.PublicKey(x963Representation: senderKey),
              let secret = try? key.sharedSecretFromKeyAgreement(with: sender) else { return nil }
        let ecdh = secret.withUnsafeBytes { Data($0) }

        // RFC 8291 §3.3–3.4, the receiving side.
        let ikm = hmac(hmac(auth, ecdh), Data("WebPush: info\0".utf8) + key.publicKey.x963Representation + senderKey + Data([1]))
        let prk = hmac(salt, ikm)
        let cek = hmac(prk, Data("Content-Encoding: aes128gcm\0".utf8) + Data([1])).prefix(16)
        let nonce = hmac(prk, Data("Content-Encoding: nonce\0".utf8) + Data([1])).prefix(12)

        guard let gcmNonce = try? AES.GCM.Nonce(data: nonce),
              let box = try? AES.GCM.SealedBox(nonce: gcmNonce, ciphertext: sealedRecord.dropLast(16), tag: sealedRecord.suffix(16)),
              let padded = try? AES.GCM.open(box, using: SymmetricKey(data: cek)) else { return nil }
        // One record: the content, the delimiter 0x02, then any zero padding.
        let plain = [UInt8](padded)
        guard let end = plain.lastIndex(where: { $0 != 0 }), plain[end] == 2 else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(plain[..<end])) as? [String: Any]
    }

    // MARK: - Keychain

    private static func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrAccessGroup as String: group]
    }

    private static func stored() -> (P256.KeyAgreement.PrivateKey, Data)? {
        var q = query()
        q[kSecReturnData as String] = true
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, data.count == 48,
              let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: data.prefix(32)) else { return nil }
        return (key, Data(data.suffix(16)))
    }

    private static func made() -> (P256.KeyAgreement.PrivateKey, Data)? {
        let key = P256.KeyAgreement.PrivateKey()
        var auth = Data(count: 16)
        guard auth.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }) == errSecSuccess else { return nil }
        var q = query()
        q[kSecValueData as String] = key.rawRepresentation + auth
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        // Two callers at once: the first one's keys win.
        if status == errSecDuplicateItem { return stored() }
        return status == errSecSuccess ? (key, auth) : nil
    }

    // MARK: - Bytes

    private static func hmac(_ key: Data, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    private static func base64URL(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func fromBase64URL(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b += String(repeating: "=", count: (4 - b.count % 4) % 4)
        return Data(base64Encoded: b)
    }
}
