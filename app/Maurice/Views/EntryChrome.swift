import SwiftUI

/// The ground of the entry screens (welcome, "Who's here?"): the icon's
/// background, repeated, never stretched — one tile is 320 pt, eight blocks of
/// 40. Carnet uses its own dark tile the same way; the household's /join page
/// too (2 November 2026, agreed with Carnet and Android).
struct EntryBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Image("MauriceTile")
            .resizable(resizingMode: .tile)
            .overlay {
                // The light tile at night would glare: the dark ground over it.
                if colorScheme == .dark { Color.platformBackground.opacity(0.55) }
            }
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }
}

extension View {
    /// The one card that carries an entry screen's content, so no text sits on
    /// the tile: at most 420 wide, 28 round, 24 in, glass on 26.
    func entryCard() -> some View {
        modifier(EntryCard())
    }
}

private struct EntryCard: ViewModifier {
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 28, style: .continuous)
        // Buttons in ink, as on Carnet and Android: dark on the light card,
        // light on the dark one — not the system blue.
        let padded = content
            .tint(.primary)
            .padding(24)
            .frame(maxWidth: 420)
        if #available(iOS 26.0, macOS 26.0, *) {
            padded
                .background(.regularMaterial, in: shape)
                .glassEffect(.regular, in: shape)
        } else {
            padded
                .background(.regularMaterial, in: shape)
        }
    }
}
