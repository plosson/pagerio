#if DEBUG
import Foundation
import OSLog
import PagerKit
import UserNotifications

/// Opt-in installation check; never includes session tokens or notification contents in logs.
@MainActor enum NotificationDiagnostics {
    static func runIfRequested(services: AppServices) async {
        guard ProcessInfo.processInfo.arguments.contains("--notification-diagnostics") else { return }
        let logger = Logger(subsystem: "com.chuut.pagerio", category: "NotificationDiagnostics")
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        logger.notice("Settings: authorization=\(settings.authorizationStatus.rawValue) alerts=\(settings.alertSetting.rawValue) style=\(settings.alertStyle.rawValue) sound=\(settings.soundSetting.rawValue); signedIn=\(services.session.isSignedIn)")
        let content = UNMutableNotificationContent()
        content.title = "Pocket Pager — local check"
        content.body = "This checks this device's banner, icon and sound. A server push check follows."
        content.sound = UNNotificationSound(named: UNNotificationSoundName("pager.caf"))
        content.interruptionLevel = .timeSensitive
        do {
            try await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content,
                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 3, repeats: false)))
            logger.notice("Local notification scheduled")
        } catch {
            logger.error("Local notification failed: \(error.localizedDescription, privacy: .public)")
        }
        for _ in 0..<15 where !services.registrar.isRegistered {
            try? await Task.sleep(for: .seconds(1))
        }
        guard services.session.isSignedIn, services.registrar.isRegistered else {
            logger.error("Push check skipped: device registration not ready")
            return
        }
        do {
            try await services.api.sendTest()
            logger.notice("Server accepted push check")
        } catch {
            logger.error("Push check failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
#endif
