public enum ApnsEnvironment: String, Sendable, Codable {
    case sandbox
    case production
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
