import Foundation
import CryptoKit
import dnssd

/// Following a household that moved to another address.
///
/// A household that changes its name leaves a TXT record under the old one:
/// `_maurice.<old host>  TXT  "v=maurice1; moved=https://<new host>"`. When the
/// old address stops answering, the device reads that record, asks the new
/// address to sign a nonce of its own (`/api/health?proof=…`), and follows only
/// if the signature checks against the identity key it pinned at pairing. A
/// forged record can point here anywhere; it cannot make the device move.
/// The server's half is `services/householdKey.ts`; the record's spelling is in
/// `docs/moving-a-household.md`. Carnet carries the same file, copied as is.
enum HouseholdMove {
    private static let proofContext = "maurice-household-proof:v1\n"

    /// The new address of the household at `serverURL`, if its old name says it
    /// moved and the new address proves it holds `key`. Nil otherwise.
    static func follow(from serverURL: String, key: String) async -> String? {
        guard let host = URL(string: serverURL)?.host, !host.isEmpty,
              let target = await movedTarget(host: host),
              target != serverURL,
              await proves(target, key: key) else { return nil }
        return target
    }

    /// The `moved=` address of `_maurice.<host>`'s TXT record: https only.
    static func movedTarget(host: String) async -> String? {
        for record in await txtRecords("_maurice.\(host)") {
            if let target = parse(record) { return target }
        }
        return nil
    }

    /// `v=maurice1; moved=https://…` → the address, without a trailing slash.
    static func parse(_ record: String) -> String? {
        var fields: [String: String] = [:]
        for part in record.split(separator: ";") {
            let kv = part.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if kv.count == 2 { fields[kv[0].lowercased()] = kv[1] }
        }
        guard fields["v"] == "maurice1", let raw = fields["moved"],
              let url = URL(string: raw), url.scheme == "https", let h = url.host, !h.isEmpty else { return nil }
        return raw.hasSuffix("/") ? String(raw.dropLast()) : raw
    }

    /// True when `serverURL` signs a fresh nonce with the private half of `key`.
    static func proves(_ serverURL: String, key: String) async -> Bool {
        guard let keyData = Data(base64URL: key),
              let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData) else { return false }
        var bytes = [UInt8](repeating: 0, count: 24)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return false }
        let nonce = Data(bytes).base64URLEncoded()
        struct Proof: Decodable { let identity_key: String?; let proof: String? }
        guard let url = URL(string: "\(serverURL)/api/health?proof=\(nonce)") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let h = try? JSONDecoder().decode(Proof.self, from: data), h.identity_key == key,
              let proof = h.proof.flatMap({ Data(base64URL: $0) }) else { return false }
        return pub.isValidSignature(proof, for: Data((proofContext + nonce).utf8))
    }

    // MARK: - DNS

    /// The TXT records of `name`, each one's strings joined, through the
    /// system resolver (mDNSResponder). Empty on any failure or after 5 s.
    static func txtRecords(_ name: String) async -> [String] {
        await withCheckedContinuation { (cont: CheckedContinuation<[String], Never>) in
            final class Box: @unchecked Sendable {
                var records: [String] = []
                var ref: DNSServiceRef?
                var done = false
                let cont: CheckedContinuation<[String], Never>
                init(_ c: CheckedContinuation<[String], Never>) { cont = c }
                func finish() {
                    guard !done else { return }
                    done = true
                    if let r = ref { DNSServiceRefDeallocate(r) }
                    ref = nil
                    cont.resume(returning: records)
                }
            }
            let queue = DispatchQueue(label: "maurice.household-move.dns")
            let box = Box(cont)
            let ctx = Unmanaged.passRetained(box)
            let callback: DNSServiceQueryRecordReply = { _, flags, _, err, _, _, _, rdlen, rdata, _, context in
                guard let context else { return }
                let box = Unmanaged<Box>.fromOpaque(context).takeUnretainedValue()
                if err == DNSServiceErrorType(kDNSServiceErr_NoError), let rdata {
                    box.records.append(HouseholdMove.decodeTXT(Data(bytes: rdata, count: Int(rdlen))))
                }
                if err != DNSServiceErrorType(kDNSServiceErr_NoError) || flags & DNSServiceFlags(kDNSServiceFlagsMoreComing) == 0 { box.finish() }
            }
            queue.async {
                var ref: DNSServiceRef?
                let err = DNSServiceQueryRecord(&ref, DNSServiceFlags(kDNSServiceFlagsTimeout | kDNSServiceFlagsReturnIntermediates), 0, name,
                                                UInt16(kDNSServiceType_TXT), UInt16(kDNSServiceClass_IN), callback, ctx.toOpaque())
                guard err == DNSServiceErrorType(kDNSServiceErr_NoError), let ref else { box.finish(); ctx.release(); return }
                box.ref = ref
                DNSServiceSetDispatchQueue(ref, queue)
                queue.asyncAfter(deadline: .now() + 5) { box.finish(); ctx.release() }
            }
        }
    }

    /// A TXT record's rdata: length-prefixed strings, joined.
    static func decodeTXT(_ data: Data) -> String {
        var out = ""
        var i = data.startIndex
        while i < data.endIndex {
            let n = Int(data[i]); i = data.index(after: i)
            let end = data.index(i, offsetBy: n, limitedBy: data.endIndex) ?? data.endIndex
            out += String(decoding: data[i..<end], as: UTF8.self)
            i = end
        }
        return out
    }
}

extension Data {
    init?(base64URL s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        self.init(base64Encoded: b)
    }

    func base64URLEncoded() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
