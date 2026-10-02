import Foundation

@MainActor
public final class DeviceRegistrar {
    private let api: APIClient
    private let environment: ApnsEnvironment
    private let isSignedIn: @MainActor () -> Bool
    public private(set) var latestToken: Data?
    public private(set) var lastError: String?

    public init(api: APIClient, environment: ApnsEnvironment, isSignedIn: @escaping @MainActor () -> Bool) {
        self.api = api
        self.environment = environment
        self.isSignedIn = isSignedIn
    }

    /// Called on every launch (APNs hands the token back each time) and whenever it changes.
    public func didReceive(token: Data) async {
        latestToken = token
        await registerIfPossible()
    }

    public func registerIfPossible() async {
        guard isSignedIn(), let token = latestToken else { return }
        let registration = DeviceRegistration(
            apnsToken: DeviceToken.hex(token),
            platform: DevicePlatform.current.rawValue,
            model: DeviceModel.current,
            apnsEnv: environment.rawValue
        )
        do {
            try await api.registerDevice(registration)
            lastError = nil
        } catch {
            lastError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}
