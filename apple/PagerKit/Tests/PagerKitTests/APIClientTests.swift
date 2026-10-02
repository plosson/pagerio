import Foundation
import Testing
@testable import PagerKit

extension Network {
    @Suite struct APIClientTests {
        func client(token: String? = "tok", onUnauthorized: @escaping @Sendable () -> Void = {}) -> APIClient {
            APIClient(baseURL: testBaseURL, session: StubURLProtocol.session(), tokenProvider: { token }, onUnauthorized: onUnauthorized)
        }

        @Test func signInPostsTheIdTokenWithoutAuthorization() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"session_token":"s1","email":"a@example.com"}"#) }
            let auth = try await client(token: nil).exchangeGoogleToken("google-id")
            #expect(auth == AuthResponse(sessionToken: "s1", email: "a@example.com"))
            let request = try #require(StubURLProtocol.requests.first)
            #expect(request.httpMethod == "POST")
            #expect(request.url?.path == "/api/auth/google")
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
            #expect(try jsonBody(request) == ["id_token": "google-id"])
        }

        @Test func pagesSendsBearerAndCursorAndDecodesServerDates() async throws {
            StubURLProtocol.reset { _ in
                StubURLProtocol.json(200, #"""
                {"pages":[{"id":"pg_1","title":null,"message":"hi","url":"https://e.com/1","view_url":"https://pager.test/v/abc","source":"trigger","created_at":"2026-10-02T12:00:00.123Z"}],"next_before":"pg_1"}
                """#)
            }
            let response = try await client().pages(before: "pg_0", limit: 10)
            let request = try #require(StubURLProtocol.requests.first)
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
            let items = Set(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? [])
            #expect(items == [URLQueryItem(name: "limit", value: "10"), URLQueryItem(name: "before", value: "pg_0")])
            let page = try #require(response.pages.first)
            #expect(page.headline == "hi")
            #expect(page.viewURL == URL(string: "https://pager.test/v/abc"))
            #expect(abs(page.createdAt.timeIntervalSince1970 - 1_790_942_400.123) < 0.001)
            #expect(response.nextBefore == "pg_1")
        }

        @Test func aMalformedLinkDoesNotBreakTheWholeList() async throws {
            StubURLProtocol.reset { _ in
                StubURLProtocol.json(200, #"{"pages":[{"id":"pg_1","title":"T","message":"m","url":"http://[bad","view_url":"https://pager.test/v/x","source":"test","created_at":"2026-10-02T12:00:00Z"}],"next_before":null}"#)
            }
            let response = try await client().pages()
            #expect(response.pages.first?.url == nil)
            #expect(response.pages.first?.headline == "T")
        }

        @Test func unauthorizedSignsOutOnceAndSurfacesTheServerMessage() async throws {
            let counter = Counter()
            StubURLProtocol.reset { _ in StubURLProtocol.json(401, #"{"error":{"code":"unauthorized","message":"Sign in again."}}"#) }
            let error = await #expect(throws: APIError.self) { try await client(onUnauthorized: { counter.hit() }).pages() }
            #expect(error == APIError(status: 401, code: "unauthorized", message: "Sign in again."))
            #expect(counter.value == 1)
        }

        @Test func aRejectedGoogleSignInDoesNotTriggerSignOut() async throws {
            let counter = Counter()
            StubURLProtocol.reset { _ in StubURLProtocol.json(401, #"{"error":{"code":"unauthorized","message":"nope"}}"#) }
            await #expect(throws: APIError.self) { try await client(token: nil, onUnauthorized: { counter.hit() }).exchangeGoogleToken("x") }
            #expect(counter.value == 0)
        }

        @Test func nonJSONErrorsBecomeReadableErrors() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(502, "<html>Bad Gateway</html>") }
            let error = await #expect(throws: APIError.self) { try await client().sendTest() }
            #expect(error?.status == 502)
            #expect(error?.code == "http_502")
        }

        @Test func callsWithoutASessionFailWithoutTouchingTheNetwork() async throws {
            let counter = Counter()
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, "{}") }
            await #expect(throws: APIError.self) { try await client(token: nil, onUnauthorized: { counter.hit() }).pages() }
            #expect(StubURLProtocol.requests.isEmpty)
            #expect(counter.value == 0)
        }

        @Test func garbageOnSuccessIsADecodingError() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, "{") }
            await #expect(throws: DecodingError.self) { try await client().pages() }
        }

        @Test func registerDeviceSendsTheSnakeCaseContract() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"dev_1"}"#) }
            try await client().registerDevice(DeviceRegistration(apnsToken: "ab", platform: "ios", model: "iPhone17,1", apnsEnv: "sandbox"))
            let request = try #require(StubURLProtocol.requests.first)
            #expect(request.httpMethod == "PUT")
            #expect(request.url?.path == "/api/devices/current")
            #expect(try jsonBody(request) == ["apns_token": "ab", "platform": "ios", "model": "iPhone17,1", "apns_env": "sandbox"])
        }

        @Test func logoutAccepts204WithAnEmptyBody() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(204, "") }
            try await client().logout()
            #expect(StubURLProtocol.requests.first?.httpMethod == "POST")
        }
    }
}
