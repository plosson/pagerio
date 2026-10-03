import AppKit
import GoogleSignIn
import PagerKit
import SwiftUI

struct MenuPanel: View {
    let services: AppServices
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openURL) private var openURL
    @State private var loginItemRefresh = 0
    /// The page that arrived while the panel was open; its row pulses once.
    @State private var pulseID: String?

    /// The panel always shows this many rows, never a scroll view (which collapses to zero height in a menu-bar panel).
    static let visibleRows = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if services.session.isSignedIn {
                signedIn
            } else {
                Text("You're signed out.").foregroundStyle(.secondary)
                Button("Sign in…") {
                    openWindow(id: SignInWindow.id)
                    NSApp.activate()
                }
                .buttonStyle(PrimaryButtonStyle())
            }
            Divider()
            footer
        }
        .padding(14)
        .frame(width: 340)
        .fixedSize(horizontal: false, vertical: true) // never squeeze the rows; the panel grows to fit them
        .background(Theme.background)
        .task {
            loginItemRefresh += 1 // re-read the system's login item state each time the panel opens
            await services.refreshAll()
        }
        .onChange(of: services.pages.pages.first?.id) { old, new in
            if old != nil, new != old { pulseID = new }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image("Logo")
                .resizable()
                .frame(width: 26, height: 26)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .accessibilityHidden(true)
            Text("Pocket Pager").font(.headline)
            Spacer()
            if services.session.isSignedIn { status }
        }
    }

    @ViewBuilder
    private var status: some View {
        switch services.permission.status {
        case .ready where !services.permission.limits.isEmpty:
            Label(services.permission.limits.contains(.soundOff) ? "Sound off" : "Banners off", systemImage: "exclamationmark.circle")
                .font(.subheadline.weight(.semibold))
        case .ready where !services.registrar.isRegistered:
            Label(services.registrar.lastError == nil ? "Connecting…" : "Connection failed", systemImage: "exclamationmark.circle")
                .font(.subheadline.weight(.semibold))
        case .ready:
            let devices = services.pages.devices.map { $0 == 1 ? " · 1 device" : " · \($0) devices" } ?? ""
            Label("Ready\(devices)", systemImage: "checkmark")
                .foregroundStyle(Theme.ok)
                .font(.subheadline.weight(.semibold))
        case .off:
            Label("Notifications off", systemImage: "bell.slash")
                .font(.subheadline.weight(.semibold))
        case .unknown:
            Label("Checking…", systemImage: "bell").foregroundStyle(.secondary).font(.subheadline)
        }
    }

    @ViewBuilder
    private var signedIn: some View {
        let store = services.pages
        let groups = PageList.groupBursts(store.pages)
        let shown = Array(groups.prefix(Self.visibleRows))
        let now = Date()
        PushRegistrationProblem(services: services)
        NotificationProblem(permission: services.permission, device: "Mac") { openURL(NotificationSettingsLink.url) }
        if store.isOffline {
            Notice(symbol: "bolt.horizontal", title: "Can't reach Pocket Pager", text: offlineText)
        } else if let error = store.lastError {
            Notice(symbol: "exclamationmark.circle", title: error)
        }
        if let last = groups.first {
            PagerDisplay(
                label: "Last page",
                trailing: PageList.relativeTime(last.page.createdAt, now: now),
                title: last.page.headline,
                message: last.page.title == nil ? nil : last.page.message,
                badge: last.count
            )
        } else {
            PagerDisplay(label: "Last page", title: "Your pager is ready.", message: "Nothing yet. Send a test, or call your URL from a script.")
        }
        HStack(spacing: 10) {
            TestButton(pages: store, prominent: !NotificationProblem.hasProblem(services.permission))
            Button("Open dashboard") { openURL(services.dashboardURL) }
                .buttonStyle(SecondaryButtonStyle())
        }
        if !shown.isEmpty {
            Text("RECENT PAGES")
                .font(.caption.weight(.semibold))
                .tracking(1)
                .foregroundStyle(.secondary)
            VStack(spacing: 0) {
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, group in
                    if index > 0 { Divider().padding(.leading, 30) }
                    Button {
                        openURL(group.page.viewURL)
                    } label: {
                        PageRow(group: group, isNew: index == 0 && PageList.isNew(group.page, now: now), pulse: group.id == pulseID, now: now)
                            .padding(.vertical, 7)
                            .padding(.horizontal, 6)
                            .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                }
            }
            let remaining = (store.total ?? store.pages.count) - shown.reduce(0) { $0 + $1.count }
            if remaining > 0 {
                HStack {
                    Text(remaining == 1 ? "1 more page" : "\(remaining) more pages").foregroundStyle(.secondary)
                    Spacer()
                    Button("Open dashboard →") { openURL(services.dashboardURL) }
                        .buttonStyle(.plain)
                        .foregroundStyle(.tint)
                        .fontWeight(.semibold)
                }
                .font(.subheadline)
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                if services.session.isSignedIn {
                    Toggle("Launch at login", isOn: Binding(
                        get: { LoginItem.isEnabled },
                        set: { LoginItem.set($0); loginItemRefresh += 1 }
                    ))
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .id(loginItemRefresh)
                }
                Spacer()
                if services.session.isSignedIn {
                    Button("Sign out") {
                        Task {
                            GIDSignIn.sharedInstance.signOut()
                            await services.signOut()
                        }
                    }
                    .buttonStyle(.plain)
                }
                Button("Quit") { NSApp.terminate(nil) }
                    .buttonStyle(.plain)
                    .padding(.leading, 8)
            }
            HStack {
                Text("Version \(AppVersion.full)")
                Spacer()
                Button("Notification settings…") {
                    Task {
                        if await services.permission.askAgain() == .openSettings { openURL(NotificationSettingsLink.url) }
                    }
                }
                .buttonStyle(.plain)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private var offlineText: String {
        guard let loadedAt = services.pages.loadedAt else { return "Open the panel again to retry." }
        return "Showing pages from \(loadedAt.formatted(date: .omitted, time: .shortened))."
    }
}
