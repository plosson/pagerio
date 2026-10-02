import Foundation
import Testing
@testable import PagerKit

extension Network {
    @Suite @MainActor struct SessionControllerTests {
        let api = APIClient(baseURL: testBaseURL, session: StubURLProtocol.session(), tokenProvider: { "tok" })

        @Test func startsSignedInWhenATokenIsStored() {
            let session = SessionController(store: InMemorySecretStore(["session_token": "s", "email": "a@example.com"]))
            #expect(session.isSignedIn)
            #expect(session.email == "a@example.com")
        }

        @Test func completeSignInStoresTheSession() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"session_token":"s1","email":"a@example.com"}"#) }
            let store = InMemorySecretStore()
            let session = SessionController(store: store)
            try await session.completeSignIn(idToken: "g", api: api)
            #expect(session.isSignedIn)
            #expect(store.read(SessionController.tokenKey) == "s1")
            #expect(session.email == "a@example.com")
        }

        @Test func aFailedSignInLeavesYouSignedOut() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(401, #"{"error":{"code":"unauthorized","message":"no"}}"#) }
            let store = InMemorySecretStore()
            let session = SessionController(store: store)
            await #expect(throws: APIError.self) { try await session.completeSignIn(idToken: "g", api: api) }
            #expect(!session.isSignedIn)
            #expect(store.read(SessionController.tokenKey) == nil)
        }

        @Test func signOutClearsLocallyEvenWhenTheServerIsDown() async {
            StubURLProtocol.reset { _ in StubURLProtocol.offline }
            let store = InMemorySecretStore(["session_token": "s", "email": "e"])
            let session = SessionController(store: store)
            await session.signOut(api: api)
            #expect(!session.isSignedIn)
            #expect(session.email == nil)
            #expect(store.read(SessionController.tokenKey) == nil)
        }

        @Test func aKeychainWriteFailureLeavesYouSignedOut() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"session_token":"s1","email":"a@example.com"}"#) }
            let session = SessionController(store: FailingSecretStore())
            await #expect(throws: SecretStoreError.self) { try await session.completeSignIn(idToken: "g", api: api) }
            #expect(!session.isSignedIn)
            #expect(session.email == nil)
        }
    }
}

struct FailingSecretStore: SecretStore {
    func read(_ key: String) -> String? { nil }
    func write(_ key: String, _ value: String?) throws { throw SecretStoreError(status: -34018) }
}
