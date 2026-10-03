import Foundation
import Testing
@testable import PagerKit

private let emptyPages = #"{"pages":[],"next_before":null}"#
private let onePage = #"{"pages":[{"id":"pg_1","title":null,"message":"hi","url":null,"view_url":"https://pager.test/v/a","source":"test","created_at":"2026-10-02T12:00:00.000Z"}],"next_before":null}"#

extension Network {
    @Suite @MainActor struct PagesStoreTests {
        let api = APIClient(baseURL: testBaseURL, session: StubURLProtocol.session(), tokenProvider: { "tok" })

        @Test func refreshLoadsPages() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, onePage) }
            let store = PagesStore(api: api)
            await store.refresh()
            #expect(store.pages.map(\.id) == ["pg_1"])
            #expect(store.lastError == nil)
            #expect(!store.isLoading)
        }

        @Test func aServerErrorKeepsOldPagesAndShowsTheMessage() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, onePage) }
            let store = PagesStore(api: api)
            await store.refresh()
            StubURLProtocol.reset { _ in StubURLProtocol.json(500, #"{"error":{"code":"internal","message":"Something went wrong. Try again."}}"#) }
            await store.refresh()
            #expect(store.pages.count == 1)
            #expect(store.lastError == "Something went wrong. Try again.")
        }

        @Test func beingOfflineGivesAFriendlyMessage() async {
            StubURLProtocol.reset { _ in StubURLProtocol.offline }
            let store = PagesStore(api: api)
            await store.refresh()
            #expect(store.lastError == "Couldn't reach Pocket Pager. Check your connection.")
        }

        @Test func anUnreadableResponseGivesAnUnexpectedResponseMessage() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, "{") }
            let store = PagesStore(api: api)
            await store.refresh()
            #expect(store.lastError == "Pocket Pager sent an unexpected response. Try again later.")
        }

        @Test func sendTestPostsThenRefreshes() async {
            StubURLProtocol.reset { request in
                request.url?.path == "/api/test"
                    ? StubURLProtocol.json(202, #"{"id":"pg_1","status":"accepted","view_url":"https://pager.test/v/a"}"#)
                    : StubURLProtocol.json(200, onePage)
            }
            let store = PagesStore(api: api)
            await store.sendTest()
            #expect(StubURLProtocol.requests.map { "\($0.httpMethod!) \($0.url!.path)" } == ["POST /api/test", "GET /api/pages"])
            #expect(store.pages.count == 1)
        }

        @Test func aRateLimitedTestShowsTheServerMessage() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(429, #"{"error":{"code":"rate_limited","message":"Too many pages. Try again later."}}"#) }
            let store = PagesStore(api: api)
            await store.sendTest()
            #expect(store.lastError == "Too many pages. Try again later.")
        }

        /// Holds a stubbed response until released, so a test can interleave calls with an in-flight load.
        final class Gate: @unchecked Sendable {
            let semaphore = DispatchSemaphore(value: 0)
            func release() { semaphore.signal() }
        }

        func waitForRequests(_ count: Int) async {
            for _ in 0..<2000 where StubURLProtocol.requests.count < count { try? await Task.sleep(for: .milliseconds(1)) }
        }

        @Test func aRefreshFinishingAfterResetDoesNotBringOldPagesBack() async {
            let gate = Gate()
            StubURLProtocol.reset { _ in gate.semaphore.wait(); return StubURLProtocol.json(200, onePage) }
            let store = PagesStore(api: api)
            let inFlight = Task { await store.refresh() }
            await waitForRequests(1)
            store.reset()
            gate.release()
            await inFlight.value
            #expect(store.pages.isEmpty)
            #expect(store.lastError == nil)
        }

        @Test func aRefreshRequestedWhileLoadingRunsExactlyOneMoreTime() async {
            let gate = Gate()
            let calls = Counter()
            StubURLProtocol.reset { _ in
                calls.hit()
                if calls.value == 1 { gate.semaphore.wait(); return StubURLProtocol.json(200, emptyPages) }
                return StubURLProtocol.json(200, onePage)
            }
            let store = PagesStore(api: api)
            let first = Task { await store.refresh() }
            await waitForRequests(1)
            await store.refresh()
            await store.refresh()
            gate.release()
            await first.value
            #expect(StubURLProtocol.requests.count == 2)
            #expect(store.pages.map(\.id) == ["pg_1"])
            #expect(!store.isLoading)
        }
    
        // MARK: Load more, totals and offline

        nonisolated static func list(_ ids: [String], next: String?, total: Int? = nil, devices: Int? = nil) -> String {
            let pages = ids.enumerated().map { i, id in pageJSON(id, title: "T\(id)", at: t0.addingTimeInterval(-Double(i) * 3600)) }
            let extras = (total.map { #","total":\#($0)"# } ?? "") + (devices.map { #","devices":\#($0)"# } ?? "")
            return #"{"pages":[\#(pages.joined(separator: ","))],"next_before":\#(next.map { "\"\($0)\"" } ?? "null")\#(extras)}"#
        }

        @Test func loadMoreFollowsTheCursorAndStopsAtTheEnd() async {
            StubURLProtocol.reset { request in
                let before = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems?.first { $0.name == "before" }?.value
                return before == nil
                    ? StubURLProtocol.json(200, Self.list(["a", "b"], next: "b", total: 3, devices: 2))
                    : StubURLProtocol.json(200, Self.list(["c"], next: nil))
            }
            let store = PagesStore(api: api)
            await store.refresh()
            #expect(store.hasMore)
            #expect(store.total == 3)
            #expect(store.devices == 2)
            await store.loadMore()
            #expect(store.pages.map(\.id) == ["a", "b", "c"])
            #expect(!store.hasMore)
            await store.loadMore()
            #expect(StubURLProtocol.requests.count == 2)
        }

        @Test func loadMoreNeverDuplicatesAPageThatShiftedAcrossTheCursor() async {
            StubURLProtocol.reset { request in
                request.url!.query!.contains("before")
                    ? StubURLProtocol.json(200, Self.list(["b", "c"], next: nil))
                    : StubURLProtocol.json(200, Self.list(["a", "b"], next: "b"))
            }
            let store = PagesStore(api: api)
            await store.refresh()
            await store.loadMore()
            #expect(store.pages.map(\.id) == ["a", "b", "c"])
        }

        @Test func aRefreshKeepsPagesLoadedWithLoadMoreBelowTheNewOnes() {
            let old = ["b", "c", "d", "e"].map { try! makePage($0) }
            let fresh = ["a", "b"].map { try! makePage($0) }
            let (merged, next) = PagesStore.merge(fresh: fresh, freshNext: "b", old: old, oldNext: "e")
            #expect(merged.map(\.id) == ["a", "b", "c", "d", "e"])
            #expect(next == "e")
        }

        @Test func aRefreshThatNoLongerOverlapsOrFitsOnOnePageReplacesTheList() {
            let old = ["x", "y"].map { try! makePage($0) }
            let fresh = ["a", "b"].map { try! makePage($0) }
            #expect(PagesStore.merge(fresh: fresh, freshNext: "b", old: old, oldNext: "y").0.map(\.id) == ["a", "b"])
            #expect(PagesStore.merge(fresh: fresh, freshNext: nil, old: ["a", "b", "z"].map { try! makePage($0) }, oldNext: "z").0.map(\.id) == ["a", "b"])
            #expect(PagesStore.merge(fresh: [], freshNext: nil, old: old, oldNext: nil).0.isEmpty)
        }

        @Test func offlineKeepsCachedPagesAndWhenTheyWereLoaded() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, Self.list(["a"], next: nil)) }
            let store = PagesStore(api: api)
            await store.refresh()
            let loadedAt = try #require(store.loadedAt)
            StubURLProtocol.reset { _ in StubURLProtocol.offline }
            await store.refresh()
            #expect(store.isOffline)
            #expect(store.pages.map(\.id) == ["a"])
            #expect(store.loadedAt == loadedAt)
            StubURLProtocol.reset { _ in StubURLProtocol.json(500, "{}") }
            await store.refresh()
            #expect(!store.isOffline)
        }

        @Test func aLoadMoreFinishingAfterResetIsDropped() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, Self.list(["a"], next: "a")) }
            let store = PagesStore(api: api)
            await store.refresh()
            let gate = Gate()
            StubURLProtocol.reset { _ in gate.semaphore.wait(); return StubURLProtocol.json(200, Self.list(["old"], next: nil)) }
            let inFlight = Task { await store.loadMore() }
            await waitForRequests(1)
            store.reset()
            gate.release()
            await inFlight.value
            #expect(store.pages.isEmpty)
            #expect(store.total == nil)
            #expect(!store.hasMore)
        }

        @Test func anOlderServerWithoutTotalsStillWorks() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, onePage) }
            let store = PagesStore(api: api)
            await store.refresh()
            #expect(store.total == nil)
            #expect(store.devices == nil)
            #expect(store.pages.first?.delivery == Delivery.none)
        }
}
}
