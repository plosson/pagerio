import GoogleSignIn
import PagerKit
import SwiftUI

struct HomeView: View {
    let services: AppServices
    @Environment(\.openURL) private var openURL
    /// The page that arrived while the app was open; its row pulses once.
    @State private var pulseID: String?

    private var store: PagesStore { services.pages }

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                content(now: context.date)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Pocket Pager")
            .refreshable { await services.refreshAll() }
            .onChange(of: store.pages.first?.id) { old, new in
                if old != nil, new != old { pulseID = new }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let email = services.session.email { Text(email) }
                        Button("Open dashboard") { openURL(services.dashboardURL) }
                        Button("Notification settings…") {
                            Task {
                                if await services.permission.askAgain() == .openSettings {
                                    openURL(NotificationSettingsLink.url)
                                }
                            }
                        }
                        Button("Sign out", role: .destructive) {
                            Task {
                                GIDSignIn.sharedInstance.signOut()
                                await services.signOut()
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle").accessibilityLabel("More")
                    }
                }
            }
        }
    }

    private func content(now: Date) -> some View {
        let groups = PageList.groupBursts(store.pages)
        return List {
            Section {
                top(groups: groups, now: now)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                    .listRowBackground(Color.clear)
            }
            Section {
                if groups.isEmpty {
                    Text("Your pages will appear here.").foregroundStyle(.secondary)
                }
                rows(groups, now: now)
                if store.hasMore {
                    Button(store.isLoadingMore ? "Loading…" : "Load more") {
                        Task { await store.loadMore() }
                    }
                    .disabled(store.isLoadingMore)
                    .listRowBackground(Theme.card)
                }
            } header: {
                Text("Recent pages")
            } footer: {
                if let total = store.total, total > store.pages.count {
                    Text("Showing \(store.pages.count) of \(total) pages. Pages are kept for 30 days.")
                }
            }
            Section {
                Text("Pocket Pager \(AppVersion.full)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
            }
        }
    }

    @ViewBuilder
    private func rows(_ groups: [PageGroup], now: Date) -> some View {
        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
            Button {
                openURL(group.page.viewURL)
            } label: {
                PageRow(
                    group: group,
                    isNew: index == 0 && PageList.isNew(group.page, now: now),
                    pulse: group.id == pulseID,
                    now: now
                )
            }
            .buttonStyle(.plain)
            .listRowBackground(Theme.card)
        }
    }

    /// Status, any problem in words, the last page, then the one orange action.
    @ViewBuilder
    private func top(groups: [PageGroup], now: Date) -> some View {
        let notificationsProblem = NotificationProblem.hasProblem(services.permission)
        VStack(alignment: .leading, spacing: 12) {
            if notificationsProblem {
                NotificationProblem(permission: services.permission, device: "iPhone") { openURL(NotificationSettingsLink.url) }
            } else if services.registrar.isRegistered {
                StatusLine(status: services.permission.status, devices: store.devices)
            }
            PushRegistrationProblem(services: services)
            if store.isOffline {
                Notice(symbol: "bolt.horizontal", title: "Can't reach Pocket Pager", text: offlineText)
            } else if let error = store.lastError {
                Notice(symbol: "exclamationmark.circle", title: error)
            } else if let last = groups.first, last.delivery.failed > 0 {
                Notice(
                    symbol: "exclamationmark.circle",
                    title: last.delivery.failed == 1 ? "1 device didn't get the last page" : "\(last.delivery.failed) devices didn't get the last page",
                    text: "Open Pocket Pager on that device to register it again.",
                    tint: Theme.bad.opacity(0.18)
                )
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
            TestButton(pages: store, prominent: !notificationsProblem)
        }
    }

    private var offlineText: String {
        guard let loadedAt = store.loadedAt else { return "Pull to retry." }
        return "Showing pages from \(loadedAt.formatted(date: .omitted, time: .shortened)). Pull to retry."
    }
}
