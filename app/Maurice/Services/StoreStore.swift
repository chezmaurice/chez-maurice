import Foundation
import Observation
import StoreKit

// MARK: - The hosting service (the tower)

/// The service that makes and bills hosted households: sign-up from the app,
/// and the account the App Store purchases are counted to. Its address is the
/// `MauriceTowerURL` Info.plist key (build setting MAURICE_TOWER_URL); a
/// household names its own in GET /api/me/store, which wins for its purchases.
enum Tower {
    static var baseURL: String {
        let configured = (Bundle.main.object(forInfoDictionaryKey: "MauriceTowerURL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let url = configured.flatMap { $0.isEmpty || $0.hasPrefix("$(") ? nil : $0 } ?? "https://account.chezmaurice.eu"
        return url.hasSuffix("/") ? String(url.dropLast()) : url
    }

    /// The zone hosted households live under: account.chezmaurice.eu → chezmaurice.eu.
    static var zone: String {
        guard let host = URL(string: baseURL)?.host else { return "chezmaurice.eu" }
        let labels = host.split(separator: ".")
        return labels.count > 2 ? labels.dropFirst().joined(separator: ".") : host
    }
}

/// A refusal from the tower: its code (`error`) and, when it gave one, a
/// sentence in the reader's language (`message`).
struct TowerError: LocalizedError {
    let status: Int
    let code: String
    let message: String?
    var errorDescription: String? { message ?? code }
}

private struct TowerRefusal: Decodable {
    let error: String?
    let message: String?
}

/// JSON to and from the tower. Not APIClient: no member token goes there, and
/// its refusals carry a `message` worth showing as is.
struct TowerClient {
    let baseURL: String
    /// Sent as Accept-Language, so the tower's sentences come in the app's language.
    var language: String? = nil

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(request(path, method: "GET"))
    }

    func post<T: Decodable>(_ path: String, body: some Encodable) async throws -> T {
        var r = request(path, method: "POST")
        r.httpBody = try JSONEncoder().encode(body)
        return try await send(r)
    }

    private func request(_ path: String, method: String) -> URLRequest {
        let base = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        var r = URLRequest(url: URL(string: base + path)!)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let language { r.setValue(language, forHTTPHeaderField: "Accept-Language") }
        r.timeoutInterval = 30
        return r
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.requestFailed }
        guard (200...299).contains(http.statusCode) else {
            let body = try? JSONDecoder().decode(TowerRefusal.self, from: data)
            throw TowerError(status: http.statusCode, code: body?.error ?? "http_\(http.statusCode)", message: body?.message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

// MARK: - The household's store

/// GET /api/me/store — given to the admin of a hosted household only.
struct StoreAccount: Decodable, Equatable {
    /// The tower account's token, a UUID: StoreKit's appAccountToken.
    let account: String
    /// The tower's base URL.
    let url: String
}

/// The tower's account, as GET /api/app/store/<account> and POST
/// /api/app/transaction give it. Times are milliseconds since 1970.
struct StoreAccountState: Decodable, Equatable {
    let name: String?
    let server: String?
    let state: String?
    let trial_ends_at: Double?
    let paid_through: Double?
    let paid_until: Double?
    /// Who bills the running subscription: "apple", "mollie", or nil.
    let via: String?
    /// "monthly" or "yearly"; nil without a subscription.
    let plan: String?
    /// The product identifiers the app may offer this account.
    let products: [String]?

    var trialEndsAt: Date? { trial_ends_at.map { Date(timeIntervalSince1970: $0 / 1000) } }
    var paidThrough: Date? { paid_through.map { Date(timeIntervalSince1970: $0 / 1000) } }

    /// A subscription is paid for now.
    var isSubscribed: Bool {
        guard plan != nil, let paidThrough else { return false }
        return paidThrough > Date()
    }

    /// Still in the free trial, with no subscription running.
    var isInTrial: Bool {
        guard !isSubscribed, let trialEndsAt else { return false }
        return trialEndsAt > Date()
    }
}

/// What the admin of a hosted household buys in the app (App Store, StoreKit 2):
/// the subscription, monthly or yearly, and top-ups of the household's budget.
/// The household server only says whether there is a store and which account
/// it is (GET /api/me/store); the tower holds the rest and believes nothing the
/// app says — every transaction is sent to it by id, and it reads it back from
/// Apple. A transaction is finished only once the tower has answered 200, so
/// one it has not counted is offered again at the next launch.
@Observable @MainActor
final class StoreStore {
    static let monthly = "eu.chezmaurice.maurice.sub.monthly"
    static let yearly = "eu.chezmaurice.maurice.sub.yearly"
    static let subscriptions = [monthly, yearly]
    static let topUps = ["eu.chezmaurice.maurice.topup.5", "eu.chezmaurice.maurice.topup.10", "eu.chezmaurice.maurice.topup.20"]

    /// Nil when this household has no store, or the reader is not its admin.
    private(set) var account: StoreAccount?
    /// The tower's view of the account; nil until it has answered.
    private(set) var state: StoreAccountState?
    /// The App Store's products, by identifier.
    private(set) var products: [String: Product] = [:]
    /// The product whose purchase is under way, or "restore".
    private(set) var busy: String?
    /// What went wrong last, in the reader's language.
    var error: String?
    /// A purchase waits for approval (Ask to Buy, a bank's check).
    private(set) var pending = false

    var hasStore: Bool { account != nil }

    /// The products to offer, in order, among those the tower allows.
    var subscriptionProducts: [Product] { offered(Self.subscriptions) }
    var topUpProducts: [Product] { offered(Self.topUps) }

    /// The subscription buttons: not while one is billed elsewhere — a
    /// subscription running through another channel is shown, never sold over.
    var offersSubscriptions: Bool { state != nil && state?.via != "mollie" && !subscriptionProducts.isEmpty }

    private var updates: Task<Void, Never>?
    private static let towerKey = "maurice.store.url"

    init() {
        // From launch: renewals, purchases finished on another device, Ask to
        // Buy approvals — and whatever the tower had not counted last time.
        updates = Task { [weak self] in
            for await result in Transaction.unfinished { await self?.handle(result) }
            for await result in Transaction.updates { await self?.handle(result) }
        }
    }

    /// Ask the household whether it has a store, then the tower and the App
    /// Store what to show. Quietly nothing for a member or a household at home.
    func refresh(_ session: SessionStore) async {
        guard session.activeDeviceUser?.role == "admin",
              let server = session.serverURL, let token = session.tokenForActiveUser,
              let found: StoreAccount = try? await APIClient(baseURL: server).get("/api/me/store", token: token)
        else {
            account = nil; state = nil
            return
        }
        if found != account { state = nil }
        account = found
        UserDefaults.standard.set(found.url, forKey: Self.towerKey)
        await loadState(session)
        await loadProducts()
    }

    private func loadState(_ session: SessionStore) async {
        guard let account else { return }
        do {
            state = try await tower(account.url, session).get("/api/app/store/\(account.account)")
        } catch {
            self.error = session.localized("store.error.unreachable")
        }
    }

    private func loadProducts() async {
        guard products.isEmpty else { return }
        if let found = try? await Product.products(for: Self.subscriptions + Self.topUps) {
            products = Dictionary(found.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        }
    }

    private func offered(_ ids: [String]) -> [Product] {
        let allowed = Set(state?.products ?? [])
        return ids.filter { allowed.contains($0) }.compactMap { products[$0] }
    }

    // MARK: Buying

    func purchase(_ product: Product, session: SessionStore, budget: BudgetStore? = nil) async {
        guard busy == nil, let account, let token = UUID(uuidString: account.account) else { return }
        error = nil; pending = false
        busy = product.id
        defer { busy = nil }
        do {
            switch try await product.purchase(options: [.appAccountToken(token)]) {
            case .success(let result):
                if case .unverified = result {
                    error = session.localized("store.error.unverified")
                } else if !(await handle(result)) {
                    error = session.localized("store.error.not_counted")
                }
                await loadState(session)
                if let budget { await budget.refresh(session) }
            case .pending:
                pending = true
            case .userCancelled:
                break
            @unknown default:
                break
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// « Restaurer les achats »: the App Store resends what this Apple Account
    /// holds, and every current entitlement goes to the tower again.
    func restore(session: SessionStore) async {
        guard busy == nil else { return }
        error = nil
        busy = "restore"
        defer { busy = nil }
        do {
            try await AppStore.sync()
        } catch {
            self.error = error.localizedDescription
            return
        }
        for await result in Transaction.currentEntitlements { await handle(result) }
        await loadState(session)
    }

    /// A transaction from anywhere (a purchase, the updates listener, a
    /// restore): sent to the tower by id, finished once it said 200. An
    /// unverified one is neither sent nor finished.
    @discardableResult
    private func handle(_ result: VerificationResult<Transaction>) async -> Bool {
        guard case .verified(let transaction) = result,
              let owner = transaction.appAccountToken?.uuidString.lowercased() else { return false }
        // The account the transaction names, at the tower last given — not
        // necessarily the household in view: a renewal can arrive anywhere.
        let url = account?.url ?? UserDefaults.standard.string(forKey: Self.towerKey) ?? Tower.baseURL
        struct Body: Encodable { let account: String; let transaction_id: String }
        do {
            let answer: StoreAccountState = try await TowerClient(baseURL: url)
                .post("/api/app/transaction", body: Body(account: owner, transaction_id: String(transaction.id)))
            await transaction.finish()
            if account?.account.lowercased() == owner { state = answer }
            return true
        } catch {
            // Left unfinished — a 404, a 409, a 503 no_store (the tower's
            // Apple side off), offline: offered again by Transaction.unfinished
            // at the next launch.
            print("[store] transaction \(transaction.id) not counted: \(error.localizedDescription)")
            return false
        }
    }

    private func tower(_ url: String, _ session: SessionStore) -> TowerClient {
        TowerClient(baseURL: url, language: session.localeIdentifier ?? Locale.preferredLanguages.first)
    }
}
