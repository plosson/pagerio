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

    @Test func soundAndBannerSwitchesAreReportedSeparately() {
        #expect(NotificationPermission.limits(sound: .enabled, alertStyle: .banner).isEmpty)
        #expect(NotificationPermission.limits(sound: .enabled, alertStyle: .alert).isEmpty)
        #expect(NotificationPermission.limits(sound: .disabled, alertStyle: .banner) == [.soundOff])
        #expect(NotificationPermission.limits(sound: .enabled, alertStyle: .none) == [.bannersOff])
        #expect(NotificationPermission.limits(sound: .disabled, alertStyle: .none) == [.soundOff, .bannersOff])
        // "Not supported" (no sound setting on this device) is not a problem the user can fix.
        #expect(NotificationPermission.limits(sound: .notSupported, alertStyle: .banner).isEmpty)
    }

    @Test func askingAgainOnlyPromptsWhenTheSystemStillAllowsIt() {
        #expect(NotificationPermission.askAgainResult(for: .notDetermined) == .prompted)
        // Once decided, the system never shows the prompt again: Settings is the only way back.
        for decided: UNAuthorizationStatus in [.denied, .authorized, .provisional] {
            #expect(NotificationPermission.askAgainResult(for: decided) == .openSettings)
        }
    }
}
