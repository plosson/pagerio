import PagerKit

extension ApnsEnvironment {
    /// Debug builds run from Xcode use the APNs sandbox; archived (TestFlight) builds use production.
    static var current: ApnsEnvironment {
        #if DEBUG
        .sandbox
        #else
        .production
        #endif
    }
}
