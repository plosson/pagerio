// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PagerKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "PagerKit", targets: ["PagerKit"])],
    targets: [
        .target(name: "PagerKit"),
        .testTarget(name: "PagerKitTests", dependencies: ["PagerKit"]),
    ]
)
