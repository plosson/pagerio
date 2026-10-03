import Foundation
import Testing
@testable import PagerKit

extension Network {
    @Suite @MainActor struct DeviceRegistrarTests {
        let api = APIClient(baseURL: testBaseURL, session: StubURLProtocol.session(), tokenProvider: { "tok" })

        @Test func doesNothingWhileSignedOut() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"d"}"#) }
            let registrar = DeviceRegistrar(api: api, environment: .sandbox, isSignedIn: { false })
            await registrar.didReceive(token: Data([0xab, 0xcd]))
            #expect(StubURLProtocol.requests.isEmpty)
            #expect(registrar.latestToken == Data([0xab, 0xcd]))
        }

        @Test func registersTheHexTokenPlatformModelAndEnvironment() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"d"}"#) }
            let registrar = DeviceRegistrar(api: api, environment: .production, isSignedIn: { true })
            await registrar.didReceive(token: Data([0x00, 0xff]))
            let body = try jsonBody(try #require(StubURLProtocol.requests.first))
            #expect(body["apns_token"] == "00ff")
            #expect(body["platform"] == "macos")
            #expect(body["apns_env"] == "production")
            #expect(body["model"]?.isEmpty == false)
        }

        @Test func aChangedTokenIsRegisteredAgain() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"d"}"#) }
            let registrar = DeviceRegistrar(api: api, environment: .sandbox, isSignedIn: { true })
            await registrar.didReceive(token: Data([0x01]))
            await registrar.didReceive(token: Data([0x02]))
            #expect(try StubURLProtocol.requests.map { try jsonBody($0)["apns_token"] } == ["01", "02"])
        }

        @Test func aTokenChangeDuringRegistrationFinishesWithTheLatestToken() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"d"}"#) }
            let registrar = DeviceRegistrar(api: api, environment: .sandbox, isSignedIn: { true })
            let first = Task { await registrar.didReceive(token: Data([0x01])) }
            // Wait until the first request is in flight before delivering the changed token.
            while StubURLProtocol.requests.isEmpty { await Task.yield() }
            await registrar.didReceive(token: Data([0x02]))
            await first.value
            #expect(try jsonBody(#require(StubURLProtocol.requests.last))["apns_token"] == "02")
            #expect(registrar.isRegistered)
        }

        @Test func appleRegistrationFailureIsVisibleAndRecoversWithANewToken() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"d"}"#) }
            let registrar = DeviceRegistrar(api: api, environment: .sandbox, isSignedIn: { true })
            #expect(!registrar.isRegistered)
            registrar.didFailToReceiveToken(URLError(.notConnectedToInternet))
            #expect(registrar.lastError != nil)
            #expect(!registrar.isRegistered)
            await registrar.didReceive(token: Data([0x01]))
            #expect(registrar.isRegistered)
            #expect(registrar.lastError == nil)
        }

        @Test func aFailureIsRecordedAndARetrySucceeds() async {
            StubURLProtocol.reset { _ in StubURLProtocol.offline }
            let registrar = DeviceRegistrar(api: api, environment: .sandbox, isSignedIn: { true })
            await registrar.didReceive(token: Data([0x01]))
            #expect(registrar.lastError != nil)
            #expect(!registrar.isRegistered)
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"d"}"#) }
            await registrar.registerIfPossible()
            #expect(registrar.lastError == nil)
            #expect(registrar.isRegistered)
        }
    }
}
