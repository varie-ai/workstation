// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "whisperkit-recognizer",
    platforms: [
        .macOS(.v14)
    ],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/WhisperKit.git", from: "0.15.0"),
    ],
    targets: [
        .executableTarget(
            name: "whisperkit-recognizer",
            dependencies: [
                .product(name: "WhisperKit", package: "WhisperKit"),
            ],
            path: "Sources"
        ),
    ]
)
