import Foundation
import Observation

/// Everything an app target needs, wired once. Both apps create one at launch.
@MainActor @Observable
public final class AppServices {
    public let api: APIClient
    public let session: SessionController
    public let pages: PagesStore
    public let permission: NotificationPermission
    public let registrar: DeviceRegistrar
    public let dashboardURL: URL
    private let requestRemoteNotifications: @MainActor () -> Void

    public init(baseURL: URL, environment: ApnsEnvironment, store: any SecretStore, urlSession: URLSession = .shared, requestRemoteNotifications: @escaping @MainActor () -> Void = {}) {
        self.requestRemoteNotifications = requestRemoteNotifications
        let session = SessionController(store: store)
        let relay = UnauthorizedRelay()
        let api = APIClient(
            baseURL: baseURL,
            session: urlSession,
            tokenProvider: { store.read(SessionController.tokenKey) },
            onUnauthorized: {
                Task { @MainActor in
                    relay.pages?.reset()
                    relay.session?.clear()
                }
            }
        )
        self.api = api
        self.session = session
        let pages = PagesStore(api: api)
        relay.session = session
        relay.pages = pages
        self.pages = pages
        self.permission = NotificationPermission()
        self.registrar = DeviceRegistrar(api: api, environment: environment, isSignedIn: { [weak session] in session?.isSignedIn ?? false })
        self.dashboardURL = baseURL
    }

    public func signIn(idToken: String) async throws {
        try await session.completeSignIn(idToken: idToken, api: api)
        await registrar.registerIfPossible()
        await pages.refresh()
    }

    public func signOut() async {
        pages.reset()
        await session.signOut(api: api)
    }

    /// On launch, on foreground, on wake and when the menu-bar panel opens.
    public func refreshAll() async {
        if registrar.latestToken == nil || registrar.lastError != nil { requestRemoteNotifications() }
        await permission.refresh()
        if session.isSignedIn {
            if permission.status == .unknown { await permission.request() }
            await registrar.registerIfPossible()
            await pages.refresh()
        }
    }

    public nonisolated static func baseURL(bundle: Bundle = .main) -> URL {
        if let text = bundle.object(forInfoDictionaryKey: "PagerioAPIBaseURL") as? String, let url = URL(string: text), url.host() != nil {
            return url
        }
        return URL(string: "https://pagerio.chuut.com")!
    }
}

/// Lets the API client's 401 handler reach the session and pages store, which are created after it.
@MainActor private final class UnauthorizedRelay {
    weak var session: SessionController?
    weak var pages: PagesStore?
}
