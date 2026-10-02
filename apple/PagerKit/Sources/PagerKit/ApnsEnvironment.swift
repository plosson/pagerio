public enum ApnsEnvironment: String, Sendable, Codable {
    case sandbox
    case production

    /// Maps the `aps-environment` value the app was built with: only "production" is production.
    public static func fromApsEnvironment(_ value: String?) -> ApnsEnvironment {
        value == "production" ? .production : .sandbox
    }
}

public enum DevicePlatform: String, Sendable, Codable {
    case ios
    case macos

    public static var current: DevicePlatform {
        #if os(macOS)
        .macos
        #else
        .ios
        #endif
    }
}
