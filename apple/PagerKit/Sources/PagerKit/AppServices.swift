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

    public init(baseURL: URL, environment: ApnsEnvironment, store: any SecretStore, urlSession: URLSession = .shared) {
        let session = SessionController(store: store)
        let api = APIClient(
            baseURL: baseURL,
            session: urlSession,
            tokenProvider: { store.read(SessionController.tokenKey) },
            onUnauthorized: { [weak session] in
                Task { @MainActor in session?.clear() }
            }
        )
        self.api = api
        self.session = session
        self.pages = PagesStore(api: api)
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
        await session.signOut(api: api)
        pages.reset()
    }

    /// On launch, on foreground, on wake and when the menu-bar panel opens.
    public func refreshAll() async {
        await permission.refresh()
        if session.isSignedIn { await pages.refresh() }
    }

    public nonisolated static func baseURL(bundle: Bundle = .main) -> URL {
        if let text = bundle.object(forInfoDictionaryKey: "PagerioAPIBaseURL") as? String, let url = URL(string: text), url.host() != nil {
            return url
        }
        return URL(string: "https://pagerio.chuut.com")!
    }
}
