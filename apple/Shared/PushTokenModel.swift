import Observation

/// Phase 1 only: holds the APNs token so it can be copied into `bun run send-push`.
@MainActor @Observable
final class PushTokenModel {
    var hex: String?
    var error: String?
}
