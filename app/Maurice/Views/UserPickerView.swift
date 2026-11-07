import SwiftUI

/// The PINs everybody tries first — the server refuses them too
/// (server/src/services/credentials.ts, pinProblem); said here first, in the
/// member's language.
enum PinRules {
    private static let common: Set<String> = [
        "1004", "2000", "6969", "1122", "1313", "2001", "1010", "4321", "1984", "1999", "2580", "0852",
        "121212", "112233", "123321", "159753", "696969", "000000", "123123", "654321", "111222",
    ]

    static func tooEasy(_ pin: String) -> Bool {
        let d = pin.compactMap(\.wholeNumberValue)
        guard d.count == pin.count, d.count >= 4 else { return false }
        if Set(d).count == 1 { return true }                                         // 1111
        let step = d[1] - d[0]
        if abs(step) == 1, zip(d, d.dropFirst()).allSatisfy({ $1 - $0 == step }) { return true } // 1234, 9876
        if pin.count % 2 == 0, String(repeating: String(pin.prefix(2)), count: pin.count / 2) == pin { return true } // 1212
        if pin.count == 6, pin.prefix(3) == pin.suffix(3) { return true }            // 123123
        return common.contains(pin)
    }
}

/// User picker: tap an avatar, enter PIN if needed, start chatting.
struct UserPickerView: View {
    @Environment(SessionStore.self) private var session
    @State private var users: [ServerUser] = []
    @State private var isLoading = true
    @State private var error: String?
    @State private var pinTarget: ServerUser?
    @State private var pinText = ""
    @State private var pinError: String?
    @State private var showAddHousehold = false
    @State private var showAdminLogin = false
    @State private var adminUsername = ""
    @State private var adminPassword = ""
    @State private var adminError: String?
    // Invite-code enrollment + self-service PIN setup.
    @State private var showEnroll = false
    @State private var enrollCode = ""
    @State private var enrollError: String?
    @State private var enrollBusy = false
    /// An open invitation: the code is good and the server asks who is joining.
    @State private var enrollNeedsProfile = false
    @State private var enrollName = ""
    @State private var enrollColor = InviteEnrollSheet.colors[0]
    /// A redeemed enrollment held until a member sets their PIN (members only).
    @State private var pendingEnroll: (userId: String, token: String, user: DeviceUser)?
    @State private var pinSetupText = ""
    @State private var pinSetupConfirm = ""
    @State private var pinSetupError: String?
    @State private var confirmForget = false

    var body: some View {
        ZStack {
        EntryBackground()
        GeometryReader { geo in
        ScrollView {
        VStack(spacing: 22) {
            VStack(spacing: 10) {
                Image("BowlerEmblem")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 56)
                    .foregroundStyle(.primary)
                    .accessibilityHidden(true)
                Text(session.localized("picker.title"))
                    .font(.wordmark(30))
                householdMenu
            }

            // User grid
            if isLoading {
                ProgressView()
                    .padding(40)
            } else if users.isEmpty {
                VStack(spacing: 14) {
                    Text(session.localized("picker.empty"))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    Button { openEnroll() } label: {
                        // Ink button: its label in the card's own ground colour.
                        Text(session.localized("enroll.cta"))
                            .foregroundStyle(Color.platformBackground)
                            .frame(maxWidth: 320)
                    }
                    .controlSize(.large)
                    .glassProminentButton()
                }
            } else {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 90, maximum: 120), spacing: 24)],
                    spacing: 24
                ) {
                    ForEach(users) { user in
                        UserAvatarButton(user: user, serverURL: session.serverURL) {
                            handleUserTap(user)
                        }
                    }
                }
            }

            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else if session.sessionEnded {
                Text(session.localized("picker.session_ended"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Everything that is not "pick yourself": an invitation code, the
            // admin's password, and forgetting this household on this device.
            Menu {
                Button { openEnroll() } label: {
                    Label(session.localized("enroll.cta"), systemImage: "envelope.open")
                }
                Button { showAdminLogin = true } label: {
                    Label(session.localized("picker.admin_signin"), systemImage: "key")
                }
                Divider()
                Button(role: .destructive) { confirmForget = true } label: {
                    Label(session.localized("picker.disconnect"), systemImage: "rectangle.portrait.and.arrow.right")
                }
            } label: {
                Text(session.localized("welcome.more_options"))
            }
            .menuStyle(.button)
            .fixedSize()
            .glassBorderedButton()
        }
        .entryCard()
        .padding(20)
        // Centred when it fits, scrolling when the household is large.
        .frame(maxWidth: .infinity, minHeight: geo.size.height)
        }
        .scrollBounceBehavior(.basedOnSize)
        }
        }
        .sheet(item: $pinTarget, onDismiss: { pinText = ""; pinError = nil }) { target in
            PinSheet(
                user: target,
                serverURL: session.serverURL,
                pinText: $pinText,
                pinError: $pinError,
                onSubmit: { submitPin(for: target) },
                onCancel: { pinTarget = nil }
            )
        }
        .sheet(isPresented: $showAdminLogin, onDismiss: {
            adminUsername = ""; adminPassword = ""; adminError = nil
        }) {
            AdminLoginSheet(
                username: $adminUsername,
                password: $adminPassword,
                error: $adminError,
                onSubmit: { Task { await adminLogin() } },
                onCancel: { showAdminLogin = false }
            )
        }
        .sheet(isPresented: $showEnroll, onDismiss: {
            enrollCode = ""; enrollError = nil; enrollNeedsProfile = false; enrollName = ""
        }) {
            InviteEnrollSheet(
                code: $enrollCode,
                error: $enrollError,
                needsProfile: enrollNeedsProfile,
                name: $enrollName,
                color: $enrollColor,
                busy: enrollBusy,
                onSubmit: { Task { await enrollWithCode() } },
                onCancel: { showEnroll = false }
            )
        }
        // Self-service PIN setup (members only, after enrolling — required)
        .sheet(isPresented: Binding(get: { pendingEnroll != nil }, set: { _ in })) {
            PinSetupSheet(
                pin: $pinSetupText,
                confirm: $pinSetupConfirm,
                error: $pinSetupError,
                onSubmit: { Task { await submitPinSetup() } }
            )
            .interactiveDismissDisabled()
        }
        .confirmationDialog(
            session.localized("household.forget.title", session.currentHousehold?.name ?? ""),
            isPresented: $confirmForget, titleVisibility: .visible
        ) {
            Button(session.localized("household.forget.confirm"), role: .destructive) { session.unpair() }
            Button(session.localized("common.cancel"), role: .cancel) {}
        } message: {
            Text(session.localized("household.forget.body"))
        }
        .task(id: session.currentHouseholdId) {
            await fetchUsers()
        }
        // A scanned or opened invitation lands here: use its code straight
        // away, as if typed — an open one then asks who is joining.
        .task(id: session.pendingInvitation?.code) {
            guard let invitation = session.pendingInvitation,
                  invitation.server == session.serverURL else { return }
            session.pendingInvitation = nil
            enrollCode = invitation.code
            enrollError = nil
            enrollNeedsProfile = false
            showEnroll = true
            // Not awaited here: clearing pendingInvitation above changes this
            // task's id, and SwiftUI would cancel it mid-request — the server
            // opening a session the app never received, the member asked for
            // the code again, and their second try told as a device let in by
            // the admin (31 October 2026).
            Task { await enrollWithCode() }
        }
        .sheet(isPresented: $showAddHousehold) {
            PairingView(onPaired: { showAddHousehold = false })
                .environment(session)
        }
    }

    /// The household this picker is for, as a menu: the others paired on
    /// this device, and adding one more.
    private var householdMenu: some View {
        Menu {
            ForEach(session.households) { h in
                Button { session.switchHousehold(h.id) } label: {
                    if h.id == session.currentHouseholdId {
                        Label(h.name, systemImage: "checkmark")
                    } else {
                        Text(h.name)
                    }
                }
            }
            Divider()
            Button { showAddHousehold = true } label: {
                Label(session.localized("household.add"), systemImage: "plus")
            }
        } label: {
            HStack(spacing: 6) {
                if let h = session.currentHousehold {
                    FoyerBadge(household: h, size: 18, radius: 5)
                }
                Text(session.currentHousehold?.name ?? "")
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .fixedSize()
    }

    private func openEnroll() {
        enrollCode = ""
        enrollError = nil
        enrollNeedsProfile = false
        showEnroll = true
    }

    private func enrollWithCode() async {
        guard let url = session.serverURL else { return }
        let api = APIClient(baseURL: url)
        enrollError = nil
        enrollBusy = true
        defer { enrollBusy = false }
        do {
            var body: [String: String] = ["code": enrollCode.trimmingCharacters(in: .whitespacesAndNewlines)]
            if let deviceId = session.deviceId { body["device_id"] = deviceId }
            if enrollNeedsProfile {
                let name = enrollName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                body["display_name"] = name
                body["avatar_color"] = enrollColor
            }
            let resp: EnrollResponse = try await api.post("/api/auth/enroll", body: body)
            if resp.needs_profile == true {
                // An open invitation: ask who is joining, then send again.
                enrollNeedsProfile = true
                return
            }
            guard let userId = resp.user_id, let token = resp.token else {
                enrollError = session.localized("enroll.failed")
                return
            }
            let me: ServerUser = try await api.get("/api/users/me", token: token)
            showEnroll = false
            enrollCode = ""
            enrollNeedsProfile = false
            enrollName = ""
            if resp.needs_pin == true {
                // Hold the session until the member sets their PIN.
                pendingEnroll = (userId, token, DeviceUser(from: me))
            } else {
                // Guest: sign in now; the device stays locked to this account.
                finishEnroll(userId: userId, token: token, user: DeviceUser(from: me))
            }
        } catch let err as APIError {
            if case .server(_, let msg) = err { enrollError = msg } else { enrollError = err.localizedDescription }
        } catch {
            enrollError = error.localizedDescription
        }
    }

    private func submitPinSetup() async {
        guard let pending = pendingEnroll, let url = session.serverURL else { return }
        let pin = pinSetupText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard pin.count >= 4, pin.count <= 6, pin.allSatisfy(\.isNumber) else {
            pinSetupError = session.localized("pinsetup.invalid"); return
        }
        guard pin == pinSetupConfirm.trimmingCharacters(in: .whitespacesAndNewlines) else {
            pinSetupError = session.localized("pinsetup.mismatch"); return
        }
        guard !PinRules.tooEasy(pin) else {
            pinSetupError = session.localized("pinsetup.weak"); return
        }
        let api = APIClient(baseURL: url)
        do {
            let _: OkResponse = try await api.post("/api/auth/set-pin", body: ["pin": pin], token: pending.token)
            let u = pending.user
            finishEnroll(userId: pending.userId, token: pending.token,
                         user: DeviceUser(id: u.id, displayName: u.displayName, avatarColor: u.avatarColor, hasPin: true,
                                          role: u.role, avatarURL: u.avatarURL, username: u.username))
            pendingEnroll = nil
            pinSetupText = ""; pinSetupConfirm = ""; pinSetupError = nil
        } catch let err as APIError {
            if case .server(_, let msg) = err { pinSetupError = msg } else { pinSetupError = err.localizedDescription }
        } catch {
            pinSetupError = error.localizedDescription
        }
    }

    private func finishEnroll(userId: String, token: String, user: DeviceUser) {
        session.sessionEnded = false
        session.loginUser(userId, token: token)
        var updated = session.deviceUsers.filter { $0.id != userId }
        updated.append(user)
        session.updateDeviceUsers(updated)
    }

    private func fetchUsers() async {
        guard let url = session.serverURL else { return }
        isLoading = true
        error = nil

        do {
            let api = APIClient(baseURL: url)

            // Any member's token will do; one the server refuses is dropped
            // (APIClient.note) and the next is tried.
            users = []
            for token in session.deviceUsers.compactMap({ session.tokenForUser($0.id) }) {
                do {
                    users = try await api.get("/api/users", token: token)
                    break
                } catch APIError.server(401, _) {
                    continue
                }
            }
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    private func adminLogin() async {
        guard let url = session.serverURL else { return }
        let api = APIClient(baseURL: url)
        adminError = nil

        do {
            let response: LoginResponse = try await api.post(
                "/api/auth/login",
                body: ["username": adminUsername, "password": adminPassword]
            )

            session.sessionEnded = false
            session.loginUser(response.user_id, token: response.token)
            users = try await api.get("/api/users", token: response.token)
            session.updateDeviceUsers(users.map { DeviceUser(from: $0) })

            showAdminLogin = false
            adminUsername = ""
            adminPassword = ""
        } catch let err as APIError {
            switch err {
            case .server(_, let msg): adminError = msg
            default: adminError = err.localizedDescription
            }
        } catch {
            adminError = error.localizedDescription
        }
    }

    private func handleUserTap(_ user: ServerUser) {
        // Users with a PIN must always verify, even if a token is cached
        if user.has_pin {
            pinTarget = user
            pinText = ""
            pinError = nil
            return
        }

        // No PIN — switch with the cached token. Without one there is no way
        // in from here: the server never opens a session for a member with
        // no PIN on their id alone. An invitation code is the way back.
        if session.switchToUser(user.id) {
            session.sessionEnded = false
            return
        }
        enrollCode = ""
        enrollNeedsProfile = false
        enrollError = session.localized("picker.needs_invite", user.display_name)
        showEnroll = true
    }

    private func submitPin(for user: ServerUser) {
        Task { await loginUser(user, pin: pinText) }
    }

    private func loginUser(_ user: ServerUser, pin: String?) async {
        guard let url = session.serverURL else { return }
        let api = APIClient(baseURL: url)

        do {
            var body: [String: String] = ["user_id": user.id]
            if let pin { body["pin"] = pin }
            if let deviceId = session.deviceId { body["device_id"] = deviceId }

            let response: LoginResponse = try await api.post(
                "/api/auth/login",
                body: body
            )

            session.sessionEnded = false
            session.loginUser(user.id, token: response.token)

            let deviceUser = DeviceUser(from: user)
            var updated = session.deviceUsers.filter { $0.id != user.id }
            updated.append(deviceUser)
            session.updateDeviceUsers(updated)

            if users.isEmpty {
                users = try await api.get("/api/users", token: response.token)
                session.updateDeviceUsers(users.map { DeviceUser(from: $0) })
            }

            pinTarget = nil
            pinText = ""
            pinError = nil
        } catch {
            if pinTarget != nil {
                pinError = session.localized("picker.pin.error")
                pinText = ""
            } else {
                self.error = error.localizedDescription
            }
        }
    }
}

// MARK: - User Avatar Button

private struct UserAvatarButton: View {
    let user: ServerUser
    var serverURL: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                UserAvatar(avatarURL: user.avatar_url, serverURL: serverURL,
                           initial: String(user.display_name.prefix(1)),
                           color: Color(hex: user.avatar_color), size: 64)

                VStack(spacing: 2) {
                    Text(user.display_name)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.primary)

                    if user.has_pin {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Sheets
//
// The steps of signing in are system sheets with a form: the same chrome as
// the rest of the OS, and the same steps as Carnet (glossary of 2 November
// 2026). Each says what it asks in its title and keeps its buttons in the bar.

/// A sheet's frame: a navigation bar with Cancel and the action, a grouped form.
private struct StepSheet<Content: View>: View {
    let title: String
    var cancel: (label: String, action: () -> Void)?
    let confirm: String
    let canConfirm: Bool
    var busy = false
    let onConfirm: () -> Void
    @ViewBuilder var content: () -> Content

    var body: some View {
        NavigationStack {
            Form { content() }
                .formStyle(.grouped)
                .navigationTitle(title)
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    if let cancel {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(cancel.label, action: cancel.action)
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        if busy {
                            ProgressView().controlSize(.small)
                        } else {
                            Button(confirm, action: onConfirm).disabled(!canConfirm)
                        }
                    }
                }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #else
        .frame(minWidth: 380, minHeight: 280)
        #endif
    }
}

/// An error under the fields, in the form's own footer style.
private struct SheetError: View {
    let text: String?
    var body: some View {
        if let text { Text(text).foregroundStyle(.red) }
    }
}

private struct PinSheet: View {
    let user: ServerUser
    let serverURL: String?
    @Binding var pinText: String
    @Binding var pinError: String?
    let onSubmit: () -> Void
    let onCancel: () -> Void

    var body: some View {
        StepSheet(title: user.display_name,
                  cancel: (L("picker.pin.cancel"), onCancel),
                  confirm: L("picker.pin.submit"),
                  canConfirm: !pinText.isEmpty,
                  onConfirm: onSubmit) {
            Section {
                HStack {
                    Spacer()
                    UserAvatar(avatarURL: user.avatar_url, serverURL: serverURL,
                               initial: String(user.display_name.prefix(1)),
                               color: Color(hex: user.avatar_color), size: 64)
                    Spacer()
                }
                .listRowBackground(Color.clear)
            }
            Section {
                SecureField(L("picker.pin.placeholder"), text: $pinText)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .textContentType(.oneTimeCode)
                    .onSubmit { onSubmit() }
            } header: {
                Text(L("picker.pin.title"))
            } footer: {
                SheetError(text: pinError)
            }
        }
    }
}

private struct AdminLoginSheet: View {
    @Binding var username: String
    @Binding var password: String
    @Binding var error: String?
    let onSubmit: () -> Void
    let onCancel: () -> Void

    var body: some View {
        StepSheet(title: L("picker.admin.title"),
                  cancel: (L("picker.admin.cancel"), onCancel),
                  confirm: L("picker.admin.submit"),
                  canConfirm: !username.isEmpty && !password.isEmpty,
                  onConfirm: onSubmit) {
            Section {
                TextField(L("picker.admin.username"), text: $username)
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .autocorrectionDisabled()
                    .textContentType(.username)
                SecureField(L("picker.admin.password"), text: $password)
                    .textContentType(.password)
                    .onSubmit { onSubmit() }
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("picker.admin.subtitle"))
                    SheetError(text: error)
                }
            }
        }
    }
}

/// The member colours on offer — the hat palettes' grounds. A newcomer picks
/// one on joining; the admin's member sheet offers the same.
enum MemberColors {
    static let all = ["#2c5aa0", "#7a4f6e", "#b97a1e", "#3d6b4f", "#a6452e", "#e3a7c2", "#44504f", "#9c6b4a"]
}

private struct InviteEnrollSheet: View {
    @Binding var code: String
    @Binding var error: String?
    /// Second step of an open invitation: the newcomer names themselves.
    let needsProfile: Bool
    @Binding var name: String
    @Binding var color: String
    let busy: Bool
    let onSubmit: () -> Void
    let onCancel: () -> Void

    static let colors = MemberColors.all

    var body: some View {
        StepSheet(title: L(needsProfile ? "enroll.profile.title" : "invite.code"),
                  cancel: (L("picker.admin.cancel"), onCancel),
                  confirm: L("enroll.submit"),
                  canConfirm: !(needsProfile ? name : code).trimmingCharacters(in: .whitespaces).isEmpty,
                  busy: busy,
                  onConfirm: onSubmit) {
            if needsProfile {
                Section {
                    TextField(L("enroll.profile.name"), text: $name)
                        #if os(iOS)
                        .textInputAutocapitalization(.words)
                        #endif
                        .textContentType(.givenName)
                        .onSubmit { onSubmit() }
                    HStack(spacing: 10) {
                        ForEach(Self.colors, id: \.self) { hex in
                            Button { color = hex } label: {
                                Circle()
                                    .fill(Color(hex: hex))
                                    .frame(width: 26, height: 26)
                                    .overlay(Circle().strokeBorder(.primary, lineWidth: color == hex ? 2 : 0).padding(-4))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 6)
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L("enroll.profile.subtitle"))
                        SheetError(text: error)
                    }
                }
            } else {
                Section {
                    TextField(L("enroll.placeholder"), text: $code)
                        .font(.body.monospaced())
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                        .autocorrectionDisabled()
                        .onSubmit { onSubmit() }
                } header: {
                    Text(L("enroll.title"))
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L("enroll.subtitle"))
                        SheetError(text: error)
                    }
                }
            }
        }
    }
}

/// Required for members after enrolling: no Cancel, and the sheet cannot be
/// swiped away.
private struct PinSetupSheet: View {
    @Binding var pin: String
    @Binding var confirm: String
    @Binding var error: String?
    let onSubmit: () -> Void

    var body: some View {
        StepSheet(title: L("pinsetup.title"),
                  confirm: L("pinsetup.submit"),
                  canConfirm: !pin.isEmpty && !confirm.isEmpty,
                  onConfirm: onSubmit) {
            Section {
                SecureField(L("pinsetup.placeholder"), text: $pin)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .textContentType(.newPassword)
                SecureField(L("pinsetup.confirm"), text: $confirm)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .textContentType(.newPassword)
                    .onSubmit { onSubmit() }
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("pinsetup.subtitle"))
                    SheetError(text: error)
                }
            }
        }
    }
}
