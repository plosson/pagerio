import Observation
import UserNotifications

@MainActor @Observable
public final class NotificationPermission {
    public enum Status: Equatable, Sendable {
        case unknown
        case ready
        case off
    }

    /// Allowed, but a part a pager needs is switched off in Settings.
    public enum Limit: Equatable, Sendable {
        /// Pages arrive silently.
        case soundOff
        /// No banner: pages only appear in Notification Center.
        case bannersOff
    }

    public private(set) var status: Status = .unknown
    /// Only filled while `status` is `.ready`; empty means everything a pager needs is on.
    public private(set) var limits: [Limit] = []

    public init() {}

    public func refresh() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        status = Self.status(for: settings.authorizationStatus)
        limits = status == .ready ? Self.limits(sound: settings.soundSetting, alertStyle: settings.alertStyle) : []
    }

    public nonisolated static func limits(sound: UNNotificationSetting, alertStyle: UNAlertStyle) -> [Limit] {
        var limits: [Limit] = []
        if sound == .disabled { limits.append(.soundOff) }
        if alertStyle == .none { limits.append(.bannersOff) }
        return limits
    }

    public enum AskAgainResult: Equatable, Sendable {
        /// The system prompt was shown (the user had never decided).
        case prompted
        /// The user already decided; the system never prompts again, so open the app's notification settings.
        case openSettings
    }

    /// "Notification settings…": prompts if the system still allows it, otherwise sends the user to Settings.
    public func askAgain() async -> AskAgainResult {
        let authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        let result = Self.askAgainResult(for: authorization)
        if result == .prompted { await request() } else { await refresh() }
        return result
    }

    public nonisolated static func askAgainResult(for authorization: UNAuthorizationStatus) -> AskAgainResult {
        authorization == .notDetermined ? .prompted : .openSettings
    }

    public func request() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        await refresh()
    }

    public nonisolated static func status(for authorization: UNAuthorizationStatus) -> Status {
        switch authorization {
        case .authorized, .provisional: .ready
        case .denied: .off
        case .notDetermined: .unknown
        #if os(iOS)
        case .ephemeral: .ready
        #endif
        @unknown default: .unknown
        }
    }
}
