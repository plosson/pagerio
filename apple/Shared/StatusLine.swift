import PagerKit
import SwiftUI

struct StatusLine: View {
    let status: NotificationPermission.Status
    let openSettings: () -> Void

    var body: some View {
        switch status {
        case .ready:
            Label("Ready", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .off:
            VStack(alignment: .leading, spacing: 6) {
                Label("Notifications are off", systemImage: "bell.slash.fill")
                    .foregroundStyle(.orange)
                Text("Pages can't reach you until you turn them on.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Open Settings", action: openSettings)
            }
        case .unknown:
            Label("Checking notifications…", systemImage: "bell")
                .foregroundStyle(.secondary)
        }
    }
}
