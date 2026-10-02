import SwiftUI

@main
struct PocketPagerMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("Pocket Pager", systemImage: "dot.radiowaves.left.and.right") {
            PushTokenView(model: appDelegate.push)
                .frame(width: 340)
        }
        .menuBarExtraStyle(.window)
    }
}
