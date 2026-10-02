import GoogleSignIn
import PagerKit
import SwiftUI

@main
struct PocketPagerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView(services: appDelegate.services)
                .onOpenURL { GIDSignIn.sharedInstance.handle($0) }
        }
    }
}

struct RootView: View {
    let services: AppServices
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if services.session.isSignedIn {
                HomeView(services: services)
            } else {
                SignInView(services: services)
            }
        }
        .task(id: scenePhase) {
            if scenePhase == .active { await services.refreshAll() }
        }
    }
}
