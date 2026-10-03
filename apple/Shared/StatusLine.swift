import PagerKit
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// "✓ Ready · 2 devices ring · Notifications on". An icon and words, never colour alone.
struct StatusLine: View {
    let status: NotificationPermission.Status
    let devices: Int?

    var body: some View {
        switch status {
        case .ready:
            (Text(Image(systemName: "checkmark")).foregroundStyle(Theme.ok)
                + Text(" Ready").foregroundStyle(Theme.ok).fontWeight(.semibold)
                + Text(details).foregroundStyle(.secondary))
                .font(.subheadline)
        case .off:
            Label("Notifications are off", systemImage: "bell.slash")
                .font(.subheadline.weight(.semibold))
        case .unknown:
            Label("Checking notifications…", systemImage: "bell")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var details: String {
        guard let devices else { return " · Notifications on" }
        return " · \(devices == 1 ? "1 device rings" : "\(devices) devices ring") · Notifications on"
    }
}

/// A designed state: what happened in one sentence, and the next action.
struct Notice: View {
    let symbol: String
    let title: String
    var text: String?
    var tint: Color = Theme.notice
    var action: (label: String, run: () -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.semibold))
                    if let text { Text(text).font(.subheadline) }
                }
            } icon: {
                Image(systemName: symbol)
            }
            if let action {
                Button(action.label, action: action.run).buttonStyle(PrimaryButtonStyle())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(tint, in: RoundedRectangle(cornerRadius: 12))
    }
}

/// Opens Pocket Pager's own page in notification settings, not the top of Settings.
enum NotificationSettingsLink {
    static var url: URL {
        #if os(iOS)
        URL(string: UIApplication.openNotificationSettingsURLString)!
        #else
        URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(Bundle.main.bundleIdentifier ?? "")")!
        #endif
    }
}

/// The notice for notifications that are off, silent or bannerless; nil when everything a pager needs is on.
struct NotificationProblem: View {
    let permission: NotificationPermission
    /// "iPhone" or "Mac".
    let device: String
    let open: () -> Void

    static func hasProblem(_ permission: NotificationPermission) -> Bool {
        permission.status == .off || !permission.limits.isEmpty
    }

    var body: some View {
        if let (symbol, title, text) = message {
            Notice(symbol: symbol, title: title, text: text, tint: Theme.warning, action: ("Open notification settings", open))
        }
    }

    private var message: (String, String, String)? {
        if permission.status == .off {
            return ("bell.slash", "Notifications are off", "Pages arrive in the list, but this \(device) won't ring.")
        }
        let limits = permission.limits
        switch (limits.contains(.soundOff), limits.contains(.bannersOff)) {
        case (true, true):
            return ("speaker.slash", "Sounds and banners are off", "Pages arrive silently and only appear in Notification Center.")
        case (true, false):
            return ("speaker.slash", "Sounds are off", "Pages arrive silently: this \(device) won't ring.")
        case (false, true):
            return ("rectangle.slash", "Banners are off", "Pages only appear in Notification Center.")
        case (false, false):
            return nil
        }
    }
}

/// Notification permission does not mean this device is registered with the server.
struct PushRegistrationProblem: View {
    let services: AppServices

    var body: some View {
        if let error = services.registrar.lastError {
            Notice(symbol: "wifi.exclamationmark", title: "This device isn't connected to notifications", text: error,
                   action: ("Retry connection", { Task { await services.refreshAll() } }))
        } else if !services.registrar.isRegistered {
            Label("Connecting to notifications…", systemImage: "antenna.radiowaves.left.and.right")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }
}
