import PagerKit
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// The palette from the app icon, shared by both apps so they can't drift apart (and match the web's style.css).
enum Theme {
    static let orange = Color(hex: 0xF86018)
    static let ink = Color(hex: 0x1A1D1F)
    static let charcoal = Color(hex: 0x283030)
    static let cream = Color(hex: 0xF8F0E0)
    static let lcd = Color(hex: 0xB8F28A)
    static let lcdLabel = Color(hex: 0x7FA862)

    /// Cream in light mode; true black on iPhone (OLED) and night on Mac in dark mode.
    #if os(iOS)
    static let background = Color(light: 0xF3EADB, dark: 0x000000)
    #else
    static let background = Color(light: 0xF3EADB, dark: 0x181820)
    #endif
    static let card = Color(light: 0xFFFDF8, dark: 0x1C1C22)
    static let display = Color(light: 0x283030, dark: 0x101615)
    static let line = Color(light: 0xE4DAC6, dark: 0x34363F)
    static let oldDot = Color(light: 0xE4DAC6, dark: 0x3A3C46)
    static let ok = Color(light: 0x1E7A34, dark: 0x5BD07A)
    static let bad = Color(light: 0xB42318, dark: 0xFF6B5E)
    static let warning = Color(light: 0xF6DFB2, dark: 0x4A3A1C)
    static let notice = Color(light: 0xEAE1D0, dark: 0x2C2D36)
    static let secondaryFill = Color(light: 0xE4DCCB, dark: 0x2C2D36)
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    init(light: UInt32, dark: UInt32) {
        #if os(iOS)
        self.init(uiColor: UIColor { traits in
            UIColor(Color(hex: traits.userInterfaceStyle == .dark ? dark : light))
        })
        #else
        self.init(nsColor: NSColor(name: nil) { appearance in
            NSColor(Color(hex: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light))
        })
        #endif
    }
}

extension View {
    /// Sender text follows its own language direction (Arabic and Hebrew align right), like dir="auto" on the web.
    func naturalDirection(of text: String) -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.layoutDirection, PageList.isRightToLeft(text) ? .rightToLeft : .leftToRight)
    }
}

/// The one orange action on a screen. Ink text on orange (5.4:1); dimmed, never hidden, when disabled.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(Theme.ink)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Theme.orange.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.45), in: RoundedRectangle(cornerRadius: 12))
            .contentShape(RoundedRectangle(cornerRadius: 12))
    }
}

/// A quiet action next to the primary one, or the charcoal sign-in button with `strong`.
struct SecondaryButtonStyle: ButtonStyle {
    var strong = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(strong ? Theme.cream : Color.primary)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background((strong ? Theme.charcoal : Theme.secondaryFill).opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 12))
            .contentShape(RoundedRectangle(cornerRadius: 12))
    }
}

/// The charcoal "display": the only reference to a physical pager. SF Mono only in here.
struct PagerDisplay: View {
    let label: String
    var trailing: String?
    let title: String
    var message: String?
    var badge: Int = 1

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(label.uppercased())
                Spacer(minLength: 8)
                if let trailing { Text(trailing.uppercased()) }
            }
            .font(.system(.caption, design: .monospaced).weight(.bold))
            .tracking(1.5)
            .foregroundStyle(Theme.lcdLabel)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.system(.title3, design: .monospaced).weight(.bold))
                    .lineLimit(2)
                if badge > 1 { CountBadge(count: badge) }
            }
            .naturalDirection(of: title)
            if let message {
                Text(message)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(3)
                    .naturalDirection(of: message)
            }
        }
        .foregroundStyle(Theme.lcd)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Theme.display, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.black.opacity(0.4), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

struct CountBadge: View {
    let count: Int

    var body: some View {
        Text("×\(count)")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(.secondary.opacity(0.2), in: Capsule())
            .accessibilityLabel("\(count) identical pages")
    }
}
