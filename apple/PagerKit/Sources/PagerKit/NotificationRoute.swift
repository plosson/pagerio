import Foundation
import UserNotifications

public enum NotificationRoute {
    public static let openLinkAction = "OPEN_LINK"
    public static let pageWithLinkCategory = "PAGE_WITH_LINK"

    /// Where a notification interaction should take the user, or nil to just open the app.
    public static func url(for userInfo: [AnyHashable: Any], actionIdentifier: String) -> URL? {
        let page = webURL(userInfo["view_url"])
        if actionIdentifier == openLinkAction { return webURL(userInfo["url"]) ?? page }
        return page
    }

    public static func categories() -> Set<UNNotificationCategory> {
        let openLink = UNNotificationAction(identifier: openLinkAction, title: "Open link", options: [.foreground])
        return [UNNotificationCategory(identifier: pageWithLinkCategory, actions: [openLink], intentIdentifiers: [], options: [])]
    }

    static func webURL(_ value: Any?) -> URL? {
        guard let text = value as? String,
              let url = URL(string: text),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              url.host() != nil
        else { return nil }
        return url
    }
}
