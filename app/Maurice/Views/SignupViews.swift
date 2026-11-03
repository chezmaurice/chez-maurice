import SwiftUI

/// The sign-up under way, kept on the device: the secret the tower gave for
/// asking after it (POST /api/app/signup). Quitting the app between the form
/// and the confirmation mail loses nothing; it is forgotten once the Maurice
/// is joined, or once the tower no longer knows it.
enum SignupPoll {
    private static let key = "maurice.signup.poll"
    static var saved: String? {
        get { UserDefaults.standard.string(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
}

/// « Créer mon Maurice »: the form, then the wait while the tower makes it,
/// then the household joined as a scanned invitation is — its first member,
/// its admin. Opened from the welcome screen.
struct SignupSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let onJoined: () -> Void
    @State private var poll: String? = SignupPoll.saved

    var body: some View {
        NavigationStack {
            Group {
                if let poll {
                    SignupWaitView(poll: poll, onJoined: onJoined, startOver: {
                        SignupPoll.saved = nil
                        self.poll = nil
                    })
                } else {
                    SignupForm { secret in
                        SignupPoll.saved = secret
                        poll = secret
                    }
                }
            }
            .navigationTitle(session.localized("signup.title"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(session.localized(poll == nil ? "common.cancel" : "common.close")) { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 520)
        #endif
    }
}

// MARK: - The form

/// GET /api/names/<name> on the tower.
private struct NameCheck: Decodable {
    let ok: Bool
    let name: String?
    let reason: String?
}

/// GET /api/suggest?q=… on the tower.
private struct SuggestResponse: Decodable {
    struct Suggestion: Decodable { let name: String; let ok: Bool }
    let suggestions: [Suggestion]
}

private struct SignupForm: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let onSent: (String) -> Void

    @State private var firstName = ""
    @State private var name = ""
    @State private var email = ""
    @State private var code = ""
    @State private var terms = false

    /// The address as the tower last judged it: nil while unasked.
    @State private var check: NameCheck?
    @State private var checking = false
    @State private var suggestions: [String] = []
    @State private var busy = false
    @State private var error: String?

    private var tower: TowerClient {
        TowerClient(baseURL: Tower.baseURL, language: session.localeIdentifier ?? Locale.preferredLanguages.first)
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces).lowercased() }

    private var canSend: Bool {
        !busy && terms && check?.ok == true
            && !firstName.trimmingCharacters(in: .whitespaces).isEmpty
            && email.contains("@")
    }

    var body: some View {
        Form {
            Section {
                TextField(session.localized("signup.first_name"), text: $firstName)
                    #if os(iOS)
                    .textContentType(.givenName)
                    #endif
            } footer: {
                Text(session.localized("signup.intro"))
            }

            Section {
                HStack(spacing: 2) {
                    TextField(session.localized("signup.name_placeholder"), text: $name)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    Text(".\(Tower.zone)").foregroundStyle(.secondary)
                }
                if !suggestions.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(suggestions, id: \.self) { s in
                                Button(s) { name = s }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                            }
                        }
                    }
                }
            } header: {
                Text(session.localized("signup.name"))
            } footer: {
                nameStatus
            }

            Section {
                TextField(session.localized("signup.email"), text: $email)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    #endif
                TextField(session.localized("signup.code"), text: $code)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.characters)
                    #endif
            } footer: {
                Text(session.localized("signup.code_caption"))
            }

            Section {
                Toggle(isOn: $terms) {
                    Text(termsText).font(.footnote)
                }
            }

            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }

            Section {
                Button { Task { await send() } } label: {
                    HStack {
                        Spacer()
                        if busy { ProgressView().controlSize(.small) } else { Text(session.localized("signup.submit")) }
                        Spacer()
                    }
                }
                .disabled(!canSend)
            }
        }
        .formStyle(.grouped)
        // The address, asked about as it is typed.
        .task(id: trimmedName) {
            check = nil
            guard !trimmedName.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            checking = true
            defer { checking = false }
            let path = "/api/names/" + (trimmedName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? trimmedName)
            if let answer: NameCheck = try? await tower.get(path), !Task.isCancelled { check = answer }
        }
        // Addresses to choose from, from the first name.
        .task(id: firstName.trimmingCharacters(in: .whitespaces)) {
            let q = firstName.trimmingCharacters(in: .whitespaces)
            guard q.count >= 2 else { suggestions = []; return }
            try? await Task.sleep(for: .milliseconds(900))
            guard !Task.isCancelled else { return }
            let path = "/api/suggest?q=" + (q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q)
            if let answer: SuggestResponse = try? await tower.get(path), !Task.isCancelled {
                suggestions = Array(answer.suggestions.filter(\.ok).map(\.name).prefix(4))
            }
        }
    }

    @ViewBuilder private var nameStatus: some View {
        if checking {
            Text(session.localized("signup.name.checking"))
        } else if let check, !trimmedName.isEmpty {
            if check.ok {
                Label(session.localized("signup.name.ok", "\(check.name ?? trimmedName).\(Tower.zone)"), systemImage: "checkmark.circle")
                    .foregroundStyle(.green)
            } else {
                Label(session.localized(check.reason == "taken" ? "signup.name.taken"
                                        : check.reason == "reserved" ? "signup.name.reserved" : "signup.name.shape"),
                      systemImage: "xmark.circle")
                    .foregroundStyle(.red)
            }
        } else {
            Text(session.localized("signup.name_caption"))
        }
    }

    private var termsText: AttributedString {
        let raw = session.localized("signup.terms", SafetyLinks.terms.absoluteString, SafetyLinks.privacy.absoluteString)
        return (try? AttributedString(markdown: raw)) ?? AttributedString(raw)
    }

    private func send() async {
        guard canSend else { return }
        error = nil
        busy = true
        defer { busy = false }
        struct Body: Encodable {
            let name, owner_name, email, code, terms, via: String
        }
        struct Answer: Decodable { let poll: String }
        do {
            let answer: Answer = try await tower.post("/api/app/signup", body: Body(
                name: check?.name ?? trimmedName,
                owner_name: firstName.trimmingCharacters(in: .whitespaces),
                email: email.trimmingCharacters(in: .whitespaces),
                code: code.trimmingCharacters(in: .whitespaces),
                terms: "yes", via: "app"))
            onSent(answer.poll)
        } catch let e as TowerError {
            if ["taken", "reserved", "shape"].contains(e.code) { check = NameCheck(ok: false, name: nil, reason: e.code) }
            error = e.message ?? session.localized("signup.error.generic")
        } catch {
            self.error = session.localized("signup.error.unreachable")
        }
    }
}

// MARK: - The wait

/// GET /api/app/signup/<poll> on the tower.
private struct SignupState: Decodable {
    let state: String
    let server: String?
    let invite_code: String?
}

/// Asks the tower every few seconds how the new Maurice is doing: the mail to
/// confirm first, then the making, then the household joined.
private struct SignupWaitView: View {
    @Environment(SessionStore.self) private var session
    let poll: String
    let onJoined: () -> Void
    let startOver: () -> Void

    @State private var state: String?
    /// The tower no longer knows the sign-up, or gave up on it.
    @State private var lost = false

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: icon)
                .font(.system(size: 46, weight: .light))
                .foregroundStyle(.secondary)
                .symbolEffect(.pulse, isActive: !lost && state != "unverified")
            Text(session.localized(headline))
                .font(.title3.weight(.medium))
                .multilineTextAlignment(.center)
            if let detail {
                Text(session.localized(detail))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if !lost { ProgressView().controlSize(.small) }
            Spacer()
            Button(session.localized("signup.start_over"), role: lost ? nil : .destructive) { startOver() }
                .font(.footnote)
                .buttonStyle(.borderless)
        }
        .padding(28)
        .frame(maxWidth: 460)
        .frame(maxWidth: .infinity)
        .task(id: poll) { await follow() }
    }

    private var icon: String {
        if lost { return "exclamationmark.triangle" }
        return state == "unverified" || state == nil ? "envelope.badge" : "sparkles"
    }

    private var headline: String {
        if lost { return "signup.wait.lost" }
        switch state {
        case nil, "unverified": return "signup.wait.confirm"
        case "waiting": return "signup.wait.queue"
        default: return "signup.wait.making"
        }
    }

    private var detail: String? {
        if lost { return nil }
        switch state {
        case nil, "unverified": return "signup.wait.confirm_detail"
        case "waiting": return "signup.wait.queue_detail"
        default: return "signup.wait.making_detail"
        }
    }

    private func follow() async {
        let tower = TowerClient(baseURL: Tower.baseURL)
        let path = "/api/app/signup/" + (poll.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? poll)
        while !Task.isCancelled {
            do {
                let s: SignupState = try await tower.get(path)
                state = s.state
                if s.state == "live", let server = s.server, let code = s.invite_code,
                   let url = PairingView.normalizedURL(server) {
                    SignupPoll.saved = nil
                    session.receive(Invitation(server: url, code: code))
                    onJoined()
                    return
                }
                if ["failed", "closed"].contains(s.state) { forget(); return }
            } catch let e as TowerError where e.status == 404 {
                forget()
                return
            } catch {
                // Offline for a moment: ask again.
            }
            try? await Task.sleep(for: .seconds(4))
        }
    }

    /// Nothing more will come of this sign-up: say so, and stop asking at launch.
    private func forget() {
        lost = true
        SignupPoll.saved = nil
    }
}
