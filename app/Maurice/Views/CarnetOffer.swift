import SwiftUI
#if os(iOS)
import StoreKit
import UIKit
#endif

// Carnet, offered to someone whose Maurice is still empty. Not at install,
// where the boxes already pile up: after a first reply from Maurice, as a
// toast, while Carnet is not on the device. "Don't offer it again" is kept on
// the device; closed without an answer, it comes back at most once a day,
// three times in all. iPhone and iPad only: there is no Carnet for the Mac.

/// Whether to offer Carnet, and what was answered — per device, as the
/// detection is.
@MainActor @Observable
final class CarnetOffer {
    /// The toast is up.
    var visible = false

    /// Carnet's page on the App Store (eu.chezmaurice.carnet.app).
    static let appStoreId = 6822163598
    private static let neverKey = "carnetOffer.never"
    private static let shownKey = "carnetOffer.shown"
    private static let lastKey = "carnetOffer.last"
    private static let maxShown = 3

    private let defaults = UserDefaults.standard

    /// Carnet answers `carnet://` (declared in LSApplicationQueriesSchemes).
    var installed: Bool {
        #if os(iOS)
        #if DEBUG
        // To see the toast on a device that has Carnet: launch with
        // `-carnetOffer.pretendAbsent YES`.
        if defaults.bool(forKey: "carnetOffer.pretendAbsent") { return false }
        #endif
        guard let url = URL(string: "carnet://") else { return false }
        return UIApplication.shared.canOpenURL(url)
        #else
        return false
        #endif
    }

    /// A turn has ended with a reply from Maurice: the moment to offer it.
    func turnEnded(replied: Bool) {
        #if os(iOS)
        guard replied, !visible, !defaults.bool(forKey: Self.neverKey) else { return }
        let shown = defaults.integer(forKey: Self.shownKey)
        guard shown < Self.maxShown else { return }
        if let last = defaults.object(forKey: Self.lastKey) as? Date, Calendar.current.isDateInToday(last) { return }
        guard !installed else { return }
        defaults.set(shown + 1, forKey: Self.shownKey)
        defaults.set(Date(), forKey: Self.lastKey)
        visible = true
        #endif
    }

    /// Closed without an answer, or the next message is on its way: later.
    func later() { visible = false }

    /// "Don't offer it again."
    func never() {
        defaults.set(true, forKey: Self.neverKey)
        visible = false
    }

    /// Back in the app, or back from the App Store page: installed, it goes.
    func recheck() {
        if visible, installed { visible = false }
    }

    /// Carnet's App Store page, as a sheet over the conversation: the app is
    /// got without leaving Maurice. The page failing to load (no network, a
    /// simulator) falls back on the App Store itself.
    func install() {
        #if os(iOS)
        visible = false
        CarnetStorePage.shared.present { [weak self] in self?.recheck() }
        #endif
    }
}

#if os(iOS)
/// StoreKit's product page for Carnet, presented from the top of the window:
/// SKStoreProductViewController is to be presented, not embedded in a SwiftUI
/// sheet.
@MainActor
private final class CarnetStorePage: NSObject, SKStoreProductViewControllerDelegate {
    static let shared = CarnetStorePage()
    private var onClose: (() -> Void)?

    func present(onClose: @escaping () -> Void) {
        self.onClose = onClose
        guard let top = Self.topController() else { return openStore() }
        let page = SKStoreProductViewController()
        page.delegate = self
        page.loadProduct(withParameters: [SKStoreProductParameterITunesItemIdentifier: NSNumber(value: CarnetOffer.appStoreId)]) { [weak self] loaded, _ in
            Task { @MainActor in
                guard !loaded else { return }
                page.dismiss(animated: true)
                self?.openStore()
            }
        }
        top.present(page, animated: true)
    }

    nonisolated func productViewControllerDidFinish(_ viewController: SKStoreProductViewController) {
        Task { @MainActor in
            viewController.dismiss(animated: true)
            self.onClose?()
            self.onClose = nil
        }
    }

    private func openStore() {
        guard let url = URL(string: "https://apps.apple.com/app/id\(CarnetOffer.appStoreId)") else { return }
        UIApplication.shared.open(url)
    }

    private static func topController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var top = scene?.keyWindow?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}
#endif

/// The toast: what Carnet is, in a line, and two answers. The cross is
/// "later".
struct CarnetOfferToast: View {
    @Environment(\.mauriceTheme) private var theme
    let offer: CarnetOffer

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image("CarnetPipe")
                    .resizable().aspectRatio(contentMode: .fit)
                    .frame(width: 26).foregroundStyle(theme.ink)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("carnet_offer.title"))
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.ink)
                    Text(L("carnet_offer.body"))
                        .font(.system(size: 13)).foregroundStyle(theme.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Button { offer.later() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.inkMute)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("carnet_offer.later"))
            }
            HStack(spacing: 14) {
                Button { offer.install() } label: {
                    Text(L("carnet_offer.install"))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(theme.isDark ? Color.black : Color.white)
                        .padding(.horizontal, 14).padding(.vertical, 7)
                        .background(theme.ink, in: Capsule())
                }
                .buttonStyle(.plain)
                Button { offer.never() } label: {
                    Text(L("carnet_offer.never"))
                        .font(.system(size: 13)).foregroundStyle(theme.inkSoft)
                        .padding(.vertical, 7).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, 14).padding(.trailing, 8).padding(.vertical, 12)
        .frame(maxWidth: 440, alignment: .leading)
        .glassControl(theme, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
    }
}
