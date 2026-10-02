import AppKit
import GoogleSignIn
import PagerKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    let services = AppServices(
        baseURL: AppServices.baseURL(),
        environment: .current,
        store: KeychainStore(service: "com.chuut.pagerio.mac")
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(NotificationRoute.categories())
        NSApplication.shared.registerForRemoteNotifications()
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [services] _ in
            Task { @MainActor in await services.refreshAll() }
        }
        Task { await services.refreshAll() }
    }

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await services.registrar.didReceive(token: deviceToken) }
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        print("APNs registration failed: \(error.localizedDescription)")
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { GIDSignIn.sharedInstance.handle(url) }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        if services.session.isSignedIn {
            Task { await services.pages.refresh() }
        }
        return [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        if let url = NotificationRoute.url(for: userInfo, actionIdentifier: response.actionIdentifier) {
            NSWorkspace.shared.open(url)
        }
    }
}
