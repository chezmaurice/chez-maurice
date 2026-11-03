import Foundation

/// A friend from another household, invited here as a guest by a member
/// (specs/cross-household-share.md, section A): a single-use code whose
/// redeemer becomes a guest who sees only the inviter, and whom only the
/// inviter can share with.
///
/// The one place the app speaks to the route — `POST /api/me/guest-invite`
/// → `{ code, link?, expires_at }`, the shape of `/api/me/device-code`.
enum GuestInvite {
    struct Code: Decodable, Identifiable {
        let code: String
        /// The page to send; built from the server and the code when absent.
        let link: String?
        let expires_at: String
        var id: String { code }

        func invitation(server: String) -> Invitation {
            link.flatMap(Invitation.init) ?? Invitation(server: server, code: code)
        }
    }

    enum Outcome {
        case code(Code)
        /// The server says this member may not (a guest, a child the admin
        /// has not allowed, an API token) or does not know the route yet:
        /// the row goes away.
        case notAllowed
        case failed(String)
    }

    @MainActor static func create(server: String, member: String, token: String) async -> Outcome {
        do {
            let code: Code = try await APIClient(baseURL: server)
                .post("/api/me/guest-invite", body: [String: String](), token: token)
            return .code(code)
        } catch APIError.server(let status, _) where status == 403 || status == 404 {
            refused.insert("\(server)|\(member)")
            return .notAllowed
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// Members the server refused during this run of the app: the row stays
    /// hidden for them until the app restarts (an admin may allow a child later).
    @MainActor static func isRefused(server: String?, member: String?) -> Bool {
        guard let server, let member else { return false }
        return refused.contains("\(server)|\(member)")
    }

    @MainActor private static var refused: Set<String> = []
}
