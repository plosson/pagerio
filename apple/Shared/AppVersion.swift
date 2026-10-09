import Foundation

enum AppVersion {
    /// MARKETING_VERSION from project.yml, bumped together with the server by scripts/release.sh.
    static var display: String {
        "v" + marketing
    }

    /// "0.1.0 (1)": the version and the build, for the footer. Mac releases use the version as the build (Sparkle
    /// compares builds), so it shows once: "0.1.0".
    static var full: String {
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return build == marketing ? marketing : "\(marketing) (\(build))"
    }

    private static var marketing: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    }
}
