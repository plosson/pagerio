import Foundation

enum AppVersion {
    /// MARKETING_VERSION from project.yml, bumped together with the server by scripts/release.sh.
    static var display: String {
        "v" + marketing
    }

    /// "0.1.0 (1)": the version and the build, for the footer.
    static var full: String {
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(marketing) (\(build))"
    }

    private static var marketing: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    }
}
