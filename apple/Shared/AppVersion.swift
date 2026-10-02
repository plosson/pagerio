import Foundation

enum AppVersion {
    /// MARKETING_VERSION from project.yml, bumped together with the server by scripts/release.sh.
    static var display: String {
        "v" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?")
    }
}
