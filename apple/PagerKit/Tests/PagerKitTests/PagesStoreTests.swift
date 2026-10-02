import Foundation
import Testing
@testable import PagerKit

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
    }
}
