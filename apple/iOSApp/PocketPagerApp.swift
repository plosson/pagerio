import SwiftUI

@main
struct PocketPagerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            PushTokenView(model: appDelegate.push)
        }
    }
}
