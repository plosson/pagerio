import PagerKit
import SwiftUI

struct PageRow: View {
    let group: PageGroup
    let isNew: Bool
    /// Set once when this page arrived while the app was open.
    var pulse = false
    var now = Date()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            dot
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(group.page.headline)
                        .font(.headline)
                        .lineLimit(2)
                    if group.count > 1 { CountBadge(count: group.count) }
                }
                .naturalDirection(of: group.page.headline)
                if group.page.title != nil {
                    Text(group.page.message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .naturalDirection(of: group.page.message)
                }
                meta
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .onAppear { if pulse { runPulse() } }
        .onChange(of: pulse) { _, now in if now { runPulse() } }
    }

    private var dot: some View {
        Circle()
            .fill(isNew ? Theme.orange : Theme.oldDot)
            .frame(width: 10, height: 10)
            .background(Circle().fill(Theme.orange.opacity(isNew ? 0.25 : 0)).frame(width: 18, height: 18))
            .scaleEffect(pulsing ? 1.6 : 1)
            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            .accessibilityLabel(isNew ? "New" : "")
    }

    private var meta: some View {
        let status = DeliveryStatus(group.delivery)
        return HStack(spacing: 10) {
            Text(PageList.relativeTime(group.page.createdAt, now: now))
            switch status {
            case .failed:
                Label(status.text, systemImage: status.symbol).foregroundStyle(Theme.bad).fontWeight(.semibold)
            case .sending:
                Label(status.text, systemImage: status.symbol)
            case .sent, .none:
                EmptyView()
            }
            if group.page.url != nil {
                Label("link", systemImage: "arrow.up.right")
            }
        }
        .labelStyle(CompactLabelStyle())
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    /// One short orange pulse, under 600 ms. With Reduce Motion the dot simply stays orange.
    private func runPulse() {
        guard !reduceMotion else { return }
        withAnimation(.easeOut(duration: 0.25)) { pulsing = true }
        withAnimation(.easeIn(duration: 0.3).delay(0.25)) { pulsing = false }
    }
}

struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}
