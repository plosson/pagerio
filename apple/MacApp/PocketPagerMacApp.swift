import HoulahopUpdater
import PagerKit
import SwiftUI

@main
struct PocketPagerMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuPanel(services: appDelegate.services, updater: appDelegate.updater)
        } label: {
            // Template image (22 pt canvas): macOS tints it for light/dark menu bars.
            Image("PagerMenu")
                .renderingMode(.template)
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
