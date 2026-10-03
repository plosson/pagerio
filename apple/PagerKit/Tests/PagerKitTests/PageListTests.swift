import Foundation
import Testing
@testable import PagerKit

let t0 = Date(timeIntervalSince1970: 1_790_000_000)

func pageJSON(_ id: String, title: String? = "Deploy failed", message: String = "rollout stopped", at: Date = t0, delivery: String? = nil) -> String {
    let titleJSON = title.map { "\"\($0)\"" } ?? "null"
    let deliveryJSON = delivery.map { #","delivery":\#($0)"# } ?? ""
    let date = at.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    return #"{"id":"\#(id)","title":\#(titleJSON),"message":"\#(message)","url":null,"view_url":"https://pager.test/v/\#(id)","source":"trigger","created_at":"\#(date)"\#(deliveryJSON)}"#
}

func makePage(_ id: String, title: String? = "Deploy failed", message: String = "rollout stopped", at: Date = t0, delivery: String? = nil) throws -> PageSummary {
    try makeDecoder().decode(PageSummary.self, from: Data(pageJSON(id, title: title, message: message, at: at, delivery: delivery).utf8))
}

@Suite struct PageListTests {
    @Test func relativeTimeNeverGoesNegative() {
        #expect(PageList.relativeTime(t0.addingTimeInterval(300), now: t0) == "just now")
        #expect(PageList.relativeTime(t0.addingTimeInterval(86400 * 365), now: t0) == "just now")
    }

    @Test func relativeTimeBoundaries() {
        let cases: [(TimeInterval, String)] = [
            (59.999, "just now"), (60, "1 min ago"), (3599.9, "59 min ago"), (3600, "1 h ago"),
            (86399, "23 h ago"), (86400, "1 d ago"), (86400 * 30, "30 d ago"),
        ]
        for (age, text) in cases { #expect(PageList.relativeTime(t0.addingTimeInterval(-age), now: t0) == text) }
    }

    @Test func aLoopingScriptsBurstCollapsesIntoOneRow() throws {
        let burst = try (0..<37).map { try makePage("p\($0)", at: t0.addingTimeInterval(-Double($0) * 8)) }
        let groups = PageList.groupBursts(burst)
        #expect(groups.count == 1)
        #expect(groups[0].count == 37)
        #expect(groups[0].page.id == "p0")
    }

    @Test func oneFailureInsideABurstIsNeverHidden() throws {
        let pages = [
            try makePage("a", delivery: #"{"sent":2,"sending":0,"failed":0}"#),
            try makePage("b", at: t0.addingTimeInterval(-60), delivery: #"{"sent":1,"sending":0,"failed":1}"#),
            try makePage("c", at: t0.addingTimeInterval(-120), delivery: #"{"sent":2,"sending":0,"failed":0}"#),
        ]
        let group = try #require(PageList.groupBursts(pages).first)
        #expect(group.delivery == Delivery(sent: 5, sending: 0, failed: 1))
        #expect(DeliveryStatus(group.delivery) == .failed(1))
        #expect(DeliveryStatus(group.delivery).text == "1 failed")
    }

    @Test func anEndlessLoopStillSplitsBecauseTheWindowStartsAtTheNewestPage() throws {
        let pages = try (0..<30).map { try makePage("p\($0)", at: t0.addingTimeInterval(-Double($0) * 60)) }
        #expect(PageList.groupBursts(pages).map(\.count) == [11, 11, 8])
    }

    @Test func aDifferentPageOrAMissingTitleBreaksTheRun() throws {
        let pages = [
            try makePage("a"),
            try makePage("b", title: "Other", at: t0.addingTimeInterval(-60)),
            try makePage("c", at: t0.addingTimeInterval(-120)),
            try makePage("d", title: nil, at: t0.addingTimeInterval(-130)),
        ]
        #expect(PageList.groupBursts(pages).map(\.count) == [1, 1, 1, 1])
        #expect(PageList.groupBursts([]).isEmpty)
    }

    @Test func statusWordsNeverSayDelivered() {
        let all: [DeliveryStatus] = [.none, .sending, .sent(1), .sent(2), .failed(3)]
        #expect(all.map(\.text) == ["No devices", "Sending…", "Sent to 1 device", "Sent to 2 devices", "3 failed"])
        for status in all { #expect(!status.text.lowercased().contains("deliver")) }
        #expect(DeliveryStatus(Delivery(sent: 2, sending: 1, failed: 0)) == .sending)
    }

    @Test func anOldServerOrAMalformedDeliveryStillDecodesThePage() throws {
        #expect(try makePage("a").delivery == .none)
        #expect(try makePage("b", delivery: #""lots""#).delivery == .none)
        #expect(try makePage("c", delivery: #"{"sent":-1}"#).delivery == .none)
    }

    @Test func onlyARecentPageIsNew() throws {
        let page = try makePage("a")
        #expect(PageList.isNew(page, now: t0.addingTimeInterval(14 * 60)))
        #expect(!PageList.isNew(page, now: t0.addingTimeInterval(15 * 60)))
    }

    @Test func directionFollowsTheFirstStrongCharacter() {
        #expect(PageList.isRightToLeft("فشل النشر في بيئة الإنتاج"))
        #expect(PageList.isRightToLeft("שלום world"))
        #expect(PageList.isRightToLeft("🚨 123: فشل"))
        #expect(!PageList.isRightToLeft("Deploy فشل"))
        #expect(!PageList.isRightToLeft("构建失败"))
        #expect(!PageList.isRightToLeft(""))
        #expect(!PageList.isRightToLeft("123 !!! 🔥"))
        #expect(!PageList.isRightToLeft("Z\u{0301}\u{0302}algo"))
    }
}
