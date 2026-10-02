import AppKit
import GoogleSignIn
import PagerKit
import SwiftUI

struct MenuPanel: View {
    let services: AppServices
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openURL) private var openURL
    @State private var loginItemRefresh = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if services.session.isSignedIn {
                StatusLine(status: services.permission.status) {
                    openURL(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
                }
                TestButton(pages: services.pages)
                Divider()
                if services.pages.pages.isEmpty {
                    Text("Your pager is ready.").foregroundStyle(.secondary)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(services.pages.pages.prefix(20)) { page in
                                Button {
                                    openURL(page.viewURL)
                                } label: {
                                    PageRow(page: page)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .frame(maxHeight: 320)
                }
                if let error = services.pages.lastError {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
                Divider()
                Toggle("Launch at login", isOn: Binding(
                    get: { LoginItem.isEnabled },
                    set: { LoginItem.set($0); loginItemRefresh += 1 }
                ))
                .id(loginItemRefresh)
                HStack {
                    Button("Open dashboard") { openURL(services.dashboardURL) }
                    Spacer()
                    Button("Sign out") {
                        Task {
                            GIDSignIn.sharedInstance.signOut()
                            await services.signOut()
                        }
                    }
                }
            } else {
                Text("You're signed out.").foregroundStyle(.secondary)
                Button("Sign in…") {
                    openWindow(id: SignInWindow.id)
                    NSApp.activate()
                }
            }
            Divider()
            Button("Quit Pocket Pager") { NSApp.terminate(nil) }
        }
        .padding(14)
        .frame(width: 340)
        .task {
            loginItemRefresh += 1 // re-read the system's login item state each time the panel opens
            await services.refreshAll()
        }
    }
}
