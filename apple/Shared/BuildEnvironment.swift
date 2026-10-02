import Foundation
import PagerKit

extension ApnsEnvironment {
    /// Comes from APS_ENVIRONMENT in Base.xcconfig, the same setting the aps-environment entitlement uses,
    /// so the environment reported to the server always matches how the app is signed.
    static var current: ApnsEnvironment {
        .fromApsEnvironment(Bundle.main.object(forInfoDictionaryKey: "PagerioApsEnvironment") as? String)
    }
}
