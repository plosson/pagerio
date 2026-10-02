import GoogleSignIn
import PagerKit
import SwiftUI

struct HomeView: View {
    let services: AppServices
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                Section {
                    StatusLine(status: services.permission.status) {
                        openURL(URL(string: UIApplication.openSettingsURLString)!)
                    }
                    TestButton(pages: services.pages)
                }
                Section("Recent pages") {
                    if services.pages.pages.isEmpty {
                        Text("Your pager is ready.").foregroundStyle(.secondary)
                    }
                    ForEach(services.pages.pages) { page in
                        Button {
                            openURL(page.viewURL)
                        } label: {
                            PageRow(page: page)
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let error = services.pages.lastError {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Pocket Pager")
            .refreshable { await services.pages.refresh() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let email = services.session.email { Text(email) }
                        Button("Open dashboard") { openURL(services.dashboardURL) }
                        Button("Sign out", role: .destructive) {
                            Task {
                                GIDSignIn.sharedInstance.signOut()
                                await services.signOut()
                            }
                        }
                        Text("Pocket Pager \(AppVersion.display)")
                    } label: {
                        Image(systemName: "ellipsis.circle").accessibilityLabel("More")
                    }
                }
            }
        }
    }
}
