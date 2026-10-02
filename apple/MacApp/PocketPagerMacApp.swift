import PagerKit
import SwiftUI

@main
struct PocketPagerMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuPanel(services: appDelegate.services)
        } label: {
            Image(systemName: "dot.radiowaves.left.and.right")
                .accessibilityLabel("Pocket Pager")
        }
        .menuBarExtraStyle(.window)

        Window("Sign in to Pocket Pager", id: SignInWindow.id) {
            SignInWindow(services: appDelegate.services)
        }
        .windowResizability(.contentSize)
        .defaultLaunchBehavior(appDelegate.services.session.isSignedIn ? .suppressed : .presented)
    }
}
