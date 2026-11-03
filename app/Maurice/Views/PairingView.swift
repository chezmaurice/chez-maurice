import SwiftUI
import CoreImage.CIFilterBuiltins
#if os(iOS)
import AVFoundation
#endif

/// The welcome screen: the app's emblem and name, what it promises, and the
/// ways in. The invitation is the main one — scanned on a phone, pasted on a
/// Mac; a code or an address typed by hand is the other. Also shown as a sheet
/// to add another household (`onPaired` then dismisses it).
struct PairingView: View {
    @Environment(SessionStore.self) private var session
    /// When set (presented as a sheet to add another household), called after a
    /// successful pair so the caller can dismiss. Nil when used as the root.
    var onPaired: (() -> Void)? = nil
    @State private var error: String?
    @State private var showScanner = false
    @State private var showEntry = false
    /// Handed to the entry sheet: a pasted text that was not an invitation.
    @State private var entryPrefill = ""
    /// « Créer mon Maurice »: the sign-up, or the wait for one under way.
    @State private var showSignup = false
    @State private var signupPending = SignupPoll.saved != nil

    var body: some View {
        ZStack {
            EntryBackground()
            GeometryReader { geo in
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 14) {
                        Image("BowlerEmblem")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 84)
                            .foregroundStyle(.primary)
                            .accessibilityHidden(true)
                        VStack(spacing: 4) {
                            Text("Maurice")
                                .font(.wordmark(40))
                            Text("Chez Maurice")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Text(session.localized("welcome.promise.maurice"))
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    VStack(spacing: 12) {
                        Text(session.localized("pairing.instructions"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.bottom, 4)

                        GlassGroup {
                            VStack(spacing: 12) {
                                primaryAction
                                Button { entryPrefill = ""; showEntry = true } label: {
                                    Text(session.localized("welcome.enter_code"))
                                        .frame(maxWidth: .infinity)
                                }
                                .controlSize(.large)
                                .glassBorderedButton()
                            }
                        }

                        // No Maurice yet: make one. A sign-up under way is
                        // picked up again here, even after quitting the app.
                        Button { error = nil; showSignup = true } label: {
                            Text(session.localized(signupPending ? "signup.resume" : "signup.open"))
                                .font(.callout.weight(.medium))
                        }
                        .buttonStyle(.borderless)
                        .padding(.top, 4)

                        if let error {
                            Text(error)
                                .font(.footnote)
                                .foregroundStyle(.red)
                                .multilineTextAlignment(.center)
                        }
                    }
                }
                .entryCard()
                .padding(20)
                // Centred when it fits, scrolling when it does not.
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
            }
        }
        .sheet(isPresented: $showSignup, onDismiss: { signupPending = SignupPoll.saved != nil }) {
            SignupSheet(onJoined: { showSignup = false; onPaired?() })
                .environment(session)
        }
        // Back after quitting mid-sign-up: straight to the wait.
        // (A beat later: a sheet asked for while the root is still settling is dropped.)
        .task {
            guard onPaired == nil, signupPending else { return }
            try? await Task.sleep(for: .milliseconds(500))
            showSignup = true
        }
        .sheet(isPresented: $showEntry) {
            EntrySheet(prefill: entryPrefill, onDone: { showEntry = false; onPaired?() })
                .environment(session)
        }
        #if os(iOS)
        .sheet(isPresented: $showScanner) {
            ScannerSheet { text in
                showScanner = false
                if let invitation = Invitation(text) {
                    accept(invitation)
                } else {
                    error = session.localized("invite.scan.not_invitation")
                }
            }
            .environment(session)
        }
        #endif
    }

    /// Scan on a phone with a camera; paste the link on a Mac (or a phone
    /// without one).
    @ViewBuilder private var primaryAction: some View {
        #if os(iOS)
        if QRScannerView.isAvailable {
            Button { error = nil; showScanner = true } label: {
                Label(session.localized("invite.scan"), systemImage: "qrcode.viewfinder")
                    .foregroundStyle(Color.platformBackground)
                    .frame(maxWidth: .infinity)
            }
            .controlSize(.large)
            .glassProminentButton()
        } else {
            pasteButton
        }
        #else
        pasteButton
        #endif
    }

    private var pasteButton: some View {
        Button { pasteInvitation() } label: {
            Label(session.localized("welcome.paste_link"), systemImage: "doc.on.clipboard")
                .foregroundStyle(Color.platformBackground)
                .frame(maxWidth: .infinity)
        }
        .controlSize(.large)
        .glassProminentButton()
    }

    /// The clipboard holds the invitation: use it. Anything else opens the
    /// entry sheet with it, where an address or a code can still be used.
    private func pasteInvitation() {
        error = nil
        #if os(iOS)
        let text = UIPasteboard.general.string ?? ""
        #else
        let text = NSPasteboard.general.string(forType: .string) ?? ""
        #endif
        if let invitation = Invitation(text) {
            accept(invitation)
        } else {
            entryPrefill = text.trimmingCharacters(in: .whitespacesAndNewlines)
            showEntry = true
        }
    }

    /// An invitation, scanned or pasted: the household comes with it.
    private func accept(_ invitation: Invitation) {
        session.receive(invitation)
        onPaired?()
    }

    /// Normalize a typed address: default the scheme to https, trim whitespace,
    /// strip a trailing slash, and reject anything without a host. Returns nil
    /// when the input can't be made into a valid URL.
    static func normalizedURL(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        let lower = s.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            s = "https://" + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        guard let u = URL(string: s), let host = u.host, !host.isEmpty else { return nil }
        return s
    }

    /// A human error that never renders "(null)": prefer a concrete reason, fall
    /// back to a generic one, and nudge toward https when a plain-http address
    /// (the usual cause) was used.
    static func friendlyConnectError(_ error: Error, url: String, session: SessionStore) -> String {
        var reason = (error as? LocalizedError)?.errorDescription ?? ""
        if reason.isEmpty { reason = (error as NSError).localizedDescription }
        if reason.isEmpty { reason = session.localized("pairing.error.unreachable") }

        // session.localized already does the String(format:) — pass the arg in,
        // don't wrap it again (that double-format is what printed "(null)").
        var msg = session.localized("pairing.error.connect", reason)
        if url.lowercased().hasPrefix("http://") {
            msg += "\n" + session.localized("pairing.error.https_hint")
        }
        return msg
    }
}

extension Color {
    /// The system's own window background, so the welcome screen sits on the
    /// same ground as the sheets it opens.
    static var platformBackground: Color {
        #if os(iOS)
        Color(uiColor: .systemBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }
}

/// "Enter a code or an address": one field that takes an invitation link, an
/// address, or a code alone. A code says nothing of where it belongs, so it
/// asks for the household address in a second field before going on.
private struct EntrySheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let prefill: String
    let onDone: () -> Void
    @State private var text = ""
    @State private var address = ""
    /// Set once the field holds a bare code: the address is then needed.
    @State private var pendingCode: String?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(session.localized("pairing.url_placeholder"), text: $text)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                        .submitLabel(.go)
                        .onSubmit { Task { await go() } }
                        .onChange(of: text) { pendingCode = nil; error = nil }
                } footer: {
                    Text(session.localized("pairing.instructions"))
                }
                if pendingCode != nil {
                    Section(session.localized("welcome.address_needed")) {
                        TextField("monfoyer.chezmaurice.eu", text: $address)
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                            #endif
                            .submitLabel(.go)
                            .onSubmit { Task { await go() } }
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(session.localized("welcome.enter_code"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(session.localized("common.cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView().controlSize(.small)
                    } else {
                        Button(session.localized("pairing.connect")) { Task { await go() } }
                            .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty
                                      || (pendingCode != nil && address.trimmingCharacters(in: .whitespaces).isEmpty))
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 300)
        #endif
        .onAppear { if text.isEmpty { text = prefill } }
    }

    /// Eight letters and digits, dashes and spaces aside: an invitation or
    /// device code. Addresses always carry a dot or a colon.
    static func bareCode(_ raw: String) -> String? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.contains("."), !t.contains(":"), !t.contains("/") else { return nil }
        let code = t.uppercased().filter { $0.isLetter || $0.isNumber }
        return code.count == 8 ? code : nil
    }

    private func go() async {
        guard !busy else { return }
        error = nil
        if let invitation = Invitation(text) {
            session.receive(invitation)
            onDone()
            return
        }
        if pendingCode == nil, let code = Self.bareCode(text) {
            pendingCode = code
            return
        }
        let raw = pendingCode != nil ? address : text
        guard let url = PairingView.normalizedURL(raw) else {
            error = session.localized("pairing.error.invalid_url")
            return
        }
        busy = true
        defer { busy = false }
        do {
            let health: HealthResponse = try await APIClient(baseURL: url).get("/api/health")
            guard health.status == "ok" else {
                error = session.localized("pairing.error.status")
                return
            }
            if let code = pendingCode {
                session.receive(Invitation(server: url, code: code))
            } else {
                session.pair(serverURL: url, name: health.household,
                             color: health.household_color, icon: health.household_icon)
            }
            onDone()
        } catch {
            self.error = PairingView.friendlyConnectError(error, url: url, session: session)
        }
    }
}

#if os(iOS)
/// The camera with a frame to aim at, what to aim at, and a way out. Before the
/// first use, one sentence says what the camera is for, then the system asks.
private struct ScannerSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let onFound: (String) -> Void
    @State private var status = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        NavigationStack {
            Group {
                switch status {
                case .authorized:
                    ZStack {
                        QRScannerView(onFound: onFound).ignoresSafeArea()
                        VStack(spacing: 20) {
                            Spacer()
                            RoundedRectangle(cornerRadius: 28, style: .continuous)
                                .strokeBorder(.white, lineWidth: 3)
                                .frame(width: 250, height: 250)
                            Text(session.localized("scanner.hint"))
                                .font(.callout.weight(.medium))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 16).padding(.vertical, 10)
                                .background(.ultraThinMaterial, in: Capsule())
                            Spacer()
                        }
                    }
                case .notDetermined:
                    VStack(spacing: 18) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 56, weight: .light))
                            .foregroundStyle(.secondary)
                        Text(session.localized("scanner.camera_reason"))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                        Button(session.localized("enroll.submit")) {
                            AVCaptureDevice.requestAccess(for: .video) { _ in
                                Task { @MainActor in status = AVCaptureDevice.authorizationStatus(for: .video) }
                            }
                        }
                        .controlSize(.large)
                        .glassProminentButton()
                    }
                default:
                    VStack(spacing: 14) {
                        Image(systemName: "video.slash")
                            .font(.system(size: 44, weight: .light))
                            .foregroundStyle(.secondary)
                        Text(session.localized("scanner.camera_reason"))
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 32)
                        if let settings = URL(string: UIApplication.openSettingsURLString) {
                            Link(session.localized("settings.title"), destination: settings)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(session.localized("invite.scan"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(session.localized("common.close")) { dismiss() }
                }
            }
        }
    }
}
#endif

// MARK: - QR codes

/// A QR code for a string, drawn crisp at any size (CoreImage builds it one
/// module per pixel; nearest-neighbour scaling keeps the edges hard).
struct QRCodeImage: View {
    let text: String

    var body: some View {
        if let image = Self.cgImage(for: text) {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .aspectRatio(1, contentMode: .fit)
                .accessibilityLabel(text)
        }
    }

    static func cgImage(for text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }
}

#if os(iOS)
/// The camera, reading the first QR code it sees. Hands back the raw text;
/// the caller decides whether it is an invitation.
struct QRScannerView: UIViewControllerRepresentable {
    let onFound: (String) -> Void

    static var isAvailable: Bool {
        AVCaptureDevice.default(for: .video) != nil
    }

    func makeUIViewController(context: Context) -> Controller {
        let controller = Controller()
        controller.onFound = onFound
        return controller
    }

    func updateUIViewController(_ controller: Controller, context: Context) {}

    final class Controller: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onFound: ((String) -> Void)?
        private let captureSession = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var found = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  captureSession.canAddInput(input) else { return }
            captureSession.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard captureSession.canAddOutput(output) else { return }
            captureSession.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: captureSession)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            // startRunning blocks until the camera is up; keep it off the main thread.
            let session = captureSession
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let session = captureSession
            DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput objects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            guard !found,
                  let code = objects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
                  let text = code.stringValue else { return }
            found = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onFound?(text)
        }
    }
}
#endif
