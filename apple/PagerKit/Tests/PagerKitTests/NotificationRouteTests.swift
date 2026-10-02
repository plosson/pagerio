import Foundation
import Testing
import UserNotifications
@testable import PagerKit

@Suite struct NotificationRouteTests {
    let tap = UNNotificationDefaultActionIdentifier
    let open = NotificationRoute.openLinkAction

    @Test func tappingOpensThePublicPage() {
        let info: [AnyHashable: Any] = ["view_url": "https://pager.test/v/a", "url": "https://e.com"]
        #expect(NotificationRoute.url(for: info, actionIdentifier: tap) == URL(string: "https://pager.test/v/a"))
    }

    @Test func openLinkOpensTheSendersLink() {
        let info: [AnyHashable: Any] = ["view_url": "https://pager.test/v/a", "url": "https://e.com/x"]
        #expect(NotificationRoute.url(for: info, actionIdentifier: open) == URL(string: "https://e.com/x"))
    }

    @Test func openLinkFallsBackToThePageWhenTheLinkIsMissingOrUnsafe() {
        for link in [nil, "javascript:alert(1)", "file:///etc/passwd", "https:", "not a url"] as [String?] {
            var info: [AnyHashable: Any] = ["view_url": "https://pager.test/v/a"]
            if let link { info["url"] = link }
            #expect(NotificationRoute.url(for: info, actionIdentifier: open) == URL(string: "https://pager.test/v/a"))
        }
    }

    @Test func malformedPayloadsOpenNothing() {
        let payloads: [[AnyHashable: Any]] = [[:], ["view_url": 42], ["view_url": ""], ["view_url": "javascript:alert(1)"]]
        for info in payloads {
            #expect(NotificationRoute.url(for: info, actionIdentifier: tap) == nil)
        }
    }

    @Test func theLinkCategoryCarriesTheOpenLinkAction() throws {
        let category = try #require(NotificationRoute.categories().first { $0.identifier == "PAGE_WITH_LINK" })
        #expect(category.actions.map(\.identifier) == ["OPEN_LINK"])
        #expect(category.actions.first?.title == "Open link")
    }

    @Test func permissionStatusMapping() {
        #expect(NotificationPermission.status(for: .authorized) == .ready)
        #expect(NotificationPermission.status(for: .provisional) == .ready)
        #expect(NotificationPermission.status(for: .denied) == .off)
        #expect(NotificationPermission.status(for: .notDetermined) == .unknown)
    }
}
