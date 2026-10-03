import PagerKit
import UIKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    let services = AppServices(
        baseURL: AppServices.baseURL(),
        environment: .current,
        store: KeychainStore(service: "com.chuut.pagerio"),
        requestRemoteNotifications: { UIApplication.shared.registerForRemoteNotifications() }
    )

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(NotificationRoute.categories())
        application.registerForRemoteNotifications()
        #if DEBUG
        Task { await NotificationDiagnostics.runIfRequested(services: services) }
        #endif
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        application.registerForRemoteNotifications()
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await services.registrar.didReceive(token: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        services.registrar.didFailToReceiveToken(error)
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
            await UIApplication.shared.open(url)
        }
    }
}
