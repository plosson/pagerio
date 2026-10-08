import Foundation
import PagerKit
#if os(macOS)
import Security
#endif

extension ApnsEnvironment {
    /// The environment reported to the server must match the one the app is signed for, or APNs refuses the token.
    static var current: ApnsEnvironment {
        #if os(macOS)
        // Read the signed entitlement itself: a Developer ID export re-signs it, so the build setting can be wrong.
        guard let task = SecTaskCreateFromSelf(nil) else { return .sandbox }
        let value = SecTaskCopyValueForEntitlement(task, "com.apple.developer.aps-environment" as CFString, nil)
        return .fromApsEnvironment(value as? String)
        #else
        // Comes from APS_ENVIRONMENT in Base.xcconfig, the same setting the aps-environment entitlement uses.
        return .fromApsEnvironment(Bundle.main.object(forInfoDictionaryKey: "PagerioApsEnvironment") as? String)
        #endif
    }
}
