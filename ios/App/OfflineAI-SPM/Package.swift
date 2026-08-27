// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OfflineAI-SPM",
    platforms: [.iOS(.v16)],
    products: [.library(name: "OfflineAIKit", targets: ["OfflineAIKit"])],
    targets: [
        .binaryTarget(
            name: "llama",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b10644/llama-b10644-xcframework.zip",
            checksum: "8531b4591ce782f6be921036d6205939b42e1763894416ae7b0552ab0e53ccb4"
        ),
        .target(name: "OfflineAIKit", dependencies: ["llama"]),
    ]
)
