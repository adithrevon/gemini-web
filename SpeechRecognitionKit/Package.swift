// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SpeechRecognitionKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "SpeechRecognitionKit",
            targets: ["SpeechRecognitionKit"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.7.9"),
    ],
    targets: [
        .target(
            name: "SpeechRecognitionKit",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            resources: [
                .process("Resources"),
            ]
        ),
        .testTarget(
            name: "SpeechRecognitionKitTests",
            dependencies: ["SpeechRecognitionKit"]
        ),
    ]
)
