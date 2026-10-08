import Foundation
import Observation
import OSLog

@MainActor @Observable
public final class DeviceRegistrar {
    private let api: APIClient
    private let environment: ApnsEnvironment
    private let isSignedIn: @MainActor () -> Bool
    public private(set) var latestToken: Data?
    public private(set) var lastError: String?
    public private(set) var isRegistered = false
    private var isRegistering = false
    private var registrationPending = false
    private let logger = Logger(subsystem: "com.houlahop.pagerio", category: "PushRegistration")

    public func didFailToReceiveToken(_ error: any Error) {
        isRegistered = false
        lastError = "Couldn't connect to Apple notifications. \(error.localizedDescription)"
        logger.error("APNs registration failed: \(error.localizedDescription, privacy: .public)")
    }

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
        guard isSignedIn(), latestToken != nil else { return }
        if isRegistering {
            registrationPending = true
            return
        }
        isRegistering = true
        defer { isRegistering = false }
        repeat {
            registrationPending = false
            guard isSignedIn(), let token = latestToken else { return }
            await register(token)
        } while registrationPending
    }

    private func register(_ token: Data) async {
        let registration = DeviceRegistration(
            apnsToken: DeviceToken.hex(token),
            platform: DevicePlatform.current.rawValue,
            model: DeviceModel.current,
            apnsEnv: environment.rawValue
        )
        do {
            try await api.registerDevice(registration)
            isRegistered = true
            lastError = nil
            logger.notice("Device registered for \(self.environment.rawValue, privacy: .public) push notifications")
        } catch {
            isRegistered = false
            lastError = (error as? APIError)?.message ?? error.localizedDescription
            logger.error("Device registration failed: \(self.lastError ?? "unknown", privacy: .public)")
        }
    }
}
