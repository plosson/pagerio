import Foundation
import Testing
@testable import PagerKit

private let emptyPages = #"{"pages":[],"next_before":null}"#

extension Network {
    @Suite @MainActor struct AppServicesTests {
        func services(_ store: InMemorySecretStore = InMemorySecretStore()) -> AppServices {
            AppServices(baseURL: testBaseURL, environment: .sandbox, store: store, urlSession: StubURLProtocol.session())
        }

        nonisolated static func route(_ request: URLRequest) -> StubURLProtocol.Reply {
            switch request.url!.path {
            case "/api/auth/google": StubURLProtocol.json(200, #"{"session_token":"s1","email":"a@example.com"}"#)
            case "/api/devices/current": StubURLProtocol.json(200, #"{"id":"d"}"#)
            default: StubURLProtocol.json(200, emptyPages)
            }
        }

        @Test func signInRegistersAWaitingDeviceTokenThenLoadsPages() async throws {
            StubURLProtocol.reset(Self.route)
            let app = services()
            await app.registrar.didReceive(token: Data([0x0a])) // arrives before sign-in: no request
            try await app.signIn(idToken: "g")
            #expect(StubURLProtocol.requests.map(\.url!.path) == ["/api/auth/google", "/api/devices/current", "/api/pages"])
            #expect(StubURLProtocol.requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer s1")
            #expect(app.session.isSignedIn)
        }

        @Test func aRevokedSessionSignsTheAppOut() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(401, #"{"error":{"code":"unauthorized","message":"Sign in again."}}"#) }
            let app = services(InMemorySecretStore(["session_token": "old"]))
            #expect(app.session.isSignedIn)
            await app.pages.refresh()
            for _ in 0..<50 where app.session.isSignedIn { await Task.yield() }
            #expect(!app.session.isSignedIn)
        }

        @Test func signOutForgetsPagesAndSession() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(204, "") }
            let app = services(InMemorySecretStore(["session_token": "s"]))
            await app.signOut()
            #expect(!app.session.isSignedIn)
            #expect(app.pages.pages.isEmpty)
            #expect(StubURLProtocol.requests.first?.url?.path == "/api/auth/logout")
        }

        @Test func baseURLFallsBackToProduction() {
            #expect(AppServices.baseURL(bundle: Bundle(for: StubURLProtocol.self)) == URL(string: "https://pagerio.chuut.com"))
        }
    }
}
