import SwiftUI
import StoreKit

/// Settings → Abonnement: the admin of a hosted household, and no one else
/// (StoreStore has no account for anyone else). Where the subscription stands,
/// the two plans and the top-ups at the App Store's own prices, managing and
/// restoring, and the terms the App Store asks to be linked (3.1.2).
///
/// A subscription billed elsewhere is shown as running, and nothing more: no
/// plan to buy, and not a word of where or for how much it was bought.
struct SubscriptionPane: View {
    @Environment(SessionStore.self) private var session
    @Environment(StoreStore.self) private var store
    @Environment(BudgetStore.self) private var budget
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.openURL) private var openURL
    let accent: Color

    @State private var showManage = false

    static let eula = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!
    private static let macSubscriptions = URL(string: "https://apps.apple.com/account/subscriptions")!

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            SetCard {
                VStack(alignment: .leading, spacing: 6) {
                    if store.state == nil {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(statusText)
                            .font(.system(size: 14.5, weight: .medium)).foregroundStyle(theme.ink)
                        if store.state?.via == "apple", store.state?.isSubscribed == true {
                            Text(session.localized("store.via_app_store"))
                                .font(.system(size: 12.5)).foregroundStyle(theme.inkSoft)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.vertical, 14)
            }

            if store.offersSubscriptions {
                SetGroup(session.localized("store.plans.group")) {
                    SetCard {
                        ForEach(Array(store.subscriptionProducts.enumerated()), id: \.element.id) { i, product in
                            if i > 0 { SetDivider() }
                            planRow(product)
                        }
                    }
                    SetCaption(session.localized("store.plans.caption"))
                }
            }

            if store.state?.via == "apple" {
                SetCard {
                    IndexRow(icon: "creditcard", label: session.localized("store.manage"), accent: accent) {
                        #if os(iOS)
                        showManage = true
                        #else
                        openURL(Self.macSubscriptions)
                        #endif
                    }
                }
            }

            if !store.topUpProducts.isEmpty {
                SetGroup(session.localized("store.topup.group")) {
                    SetCard {
                        ForEach(Array(store.topUpProducts.enumerated()), id: \.element.id) { i, product in
                            if i > 0 { SetDivider() }
                            buyRow(label: session.localized("store.topup.label"), price: product.displayPrice,
                                   current: false, busy: store.busy == product.id) {
                                Task { await store.purchase(product, session: session, budget: budget) }
                            }
                        }
                    }
                    SetCaption(session.localized("store.topup.caption"))
                }
            }

            if store.pending {
                Label(session.localized("store.pending"), systemImage: "hourglass")
                    .font(.system(size: 13)).foregroundStyle(theme.inkSoft)
            }
            if let error = store.error {
                Text(error).font(.system(size: 13)).foregroundStyle(.red)
            }

            SetCard {
                IndexRow(icon: "arrow.clockwise", label: session.localized("store.restore"), accent: accent,
                         trailing: store.busy == "restore" ? AnyView(ProgressView().controlSize(.small)) : nil) {
                    Task { await store.restore(session: session) }
                }
            }

            HStack(spacing: 14) {
                Link(session.localized("store.terms"), destination: Self.eula)
                Link(session.localized("store.privacy"), destination: SafetyLinks.privacy)
            }
            .font(.system(size: 12))
            .tint(accent.legible(onDark: theme.isDark))
        }
        #if os(iOS)
        .manageSubscriptionsSheet(isPresented: $showManage)
        .onChange(of: showManage) { _, shown in
            if !shown { Task { await store.refresh(session) } }
        }
        #endif
    }

    private var statusText: String {
        guard let s = store.state else { return "" }
        if s.isSubscribed, let until = s.paidThrough {
            return session.localized(s.plan == "yearly" ? "store.status.yearly" : "store.status.monthly", day(until))
        }
        if s.isInTrial, let until = s.trialEndsAt {
            return session.localized("store.status.trial", day(until))
        }
        return session.localized("store.status.none")
    }

    private func day(_ date: Date) -> String {
        date.formatted(Date.FormatStyle(date: .long, time: .omitted, locale: session.resolvedLocale))
    }

    /// A plan: its name, its period and the App Store's price for it — or a
    /// check when it is the one running.
    @ViewBuilder private func planRow(_ product: Product) -> some View {
        let yearly = product.id == StoreStore.yearly
        let current = store.state?.via == "apple" && store.state?.isSubscribed == true
            && store.state?.plan == (yearly ? "yearly" : "monthly")
        buyRow(label: session.localized(yearly ? "store.plan.yearly" : "store.plan.monthly"),
               price: session.localized(yearly ? "store.price.year" : "store.price.month", product.displayPrice),
               current: current, busy: store.busy == product.id) {
            Task { await store.purchase(product, session: session) }
        }
    }

    private func buyRow(label: String, price: String, current: Bool, busy: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Text(label).font(.system(size: 13.5)).foregroundStyle(theme.ink)
                Spacer(minLength: 8)
                if busy {
                    ProgressView().controlSize(.small)
                } else if current {
                    Label(session.localized("store.plan.current"), systemImage: "checkmark")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(accent.legible(onDark: theme.isDark))
                } else {
                    Text(price)
                        .font(.system(size: 12.5, weight: .medium)).monospacedDigit()
                        .foregroundStyle(accent.legible(onDark: theme.isDark))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .overlay(Capsule().strokeBorder(accent.opacity(0.5), lineWidth: 0.8))
                }
            }
            .padding(.horizontal, 13).frame(minHeight: 46).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(current || store.busy != nil)
    }
}
