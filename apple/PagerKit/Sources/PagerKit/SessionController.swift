import Observation

@MainActor @Observable
public final class SessionController {
    public nonisolated static let tokenKey = "session_token"
    public nonisolated static let emailKey = "email"

    public private(set) var isSignedIn: Bool
    public private(set) var email: String?
    private let store: any SecretStore

    public init(store: any SecretStore) {
        self.store = store
        isSignedIn = store.read(Self.tokenKey) != nil
        email = store.read(Self.emailKey)
    }

    public func completeSignIn(idToken: String, api: APIClient) async throws {
        let auth = try await api.exchangeGoogleToken(idToken)
        do {
            try store.write(Self.tokenKey, auth.sessionToken)
            try store.write(Self.emailKey, auth.email)
        } catch {
            try? store.write(Self.tokenKey, nil)
            try? store.write(Self.emailKey, nil)
            throw error
        }
        email = auth.email
        isSignedIn = true
    }

    /// Best effort on the server; always signs out locally.
    public func signOut(api: APIClient) async {
        try? await api.logout()
        clear()
    }

    public func clear() {
        try? store.write(Self.tokenKey, nil)
        try? store.write(Self.emailKey, nil)
        email = nil
        isSignedIn = false
    }
}
