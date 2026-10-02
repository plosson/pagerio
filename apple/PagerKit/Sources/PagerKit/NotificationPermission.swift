import Observation
import UserNotifications

@MainActor @Observable
public final class NotificationPermission {
    public enum Status: Equatable, Sendable {
        case unknown
        case ready
        case off
    }

    public private(set) var status: Status = .unknown

    public init() {}

    public func refresh() async {
        let authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        status = Self.status(for: authorization)
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
