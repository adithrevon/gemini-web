import Foundation
import FluidAudio
import CoreML

/// Manages CoreML model storage in a shared App Group container.
/// Allows multiple apps to share the same downloaded model files.
public final class ModelManager: Sendable {
    public let appGroupIdentifier: String
    public let sharedContainerURL: URL?

    public init(appGroupIdentifier: String) {
        self.appGroupIdentifier = appGroupIdentifier
        self.sharedContainerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        )
    }

    /// URL for the Models directory in the shared container.
    public var modelsDirectoryURL: URL? {
        sharedContainerURL?.appendingPathComponent("Models")
    }

    /// URL for a specific model version in the shared container.
    public func modelURL(version: String) -> URL? {
        modelsDirectoryURL?.appendingPathComponent("parakeet-\(version).mlmodelc")
    }

    /// Read the currently installed model version from the shared container.
    public func currentModelVersion() -> String? {
        guard let url = modelsDirectoryURL?.appendingPathComponent("current-version.txt"),
              let version = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return version.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Write the current model version marker.
    public func setCurrentModelVersion(_ version: String) throws {
        guard let dir = modelsDirectoryURL else { return }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("current-version.txt")
        try version.write(to: url, atomically: true, encoding: .utf8)
    }

    /// Check whether a model exists in the shared container.
    public func modelExists(version: String) -> Bool {
        guard let url = modelURL(version: version) else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    /// Directory URL for FluidAudio to download/cache models into.
    /// Falls back to the app's caches directory if App Group is unavailable.
    public var downloadDirectoryURL: URL {
        if let dir = modelsDirectoryURL {
            return dir
        }
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SpeechRecognitionKit/Models")
    }
}
