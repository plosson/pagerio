import PagerKit

extension ApnsEnvironment {
    /// Debug builds (what the install skill produces) use the APNs sandbox; any other configuration would report
    /// production. TestFlight is not used.
    static var current: ApnsEnvironment {
        #if DEBUG
        .sandbox
        #else
        .production
        #endif
    }
}
