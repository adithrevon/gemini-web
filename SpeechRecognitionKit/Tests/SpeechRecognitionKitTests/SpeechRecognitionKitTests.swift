import Testing
@testable import SpeechRecognitionKit

@Suite struct ModelManagerTests {
    @Test func sharedContainerURLIsNilWithoutEntitlement() {
        // Without a real App Group entitlement, the container URL will be nil
        let manager = ModelManager(appGroupIdentifier: "group.com.test.nonexistent")
        #expect(manager.sharedContainerURL == nil)
    }

    @Test func fallbackDownloadDirectory() {
        let manager = ModelManager(appGroupIdentifier: "group.com.test.nonexistent")
        let url = manager.downloadDirectoryURL
        #expect(url.path.contains("SpeechRecognitionKit/Models"))
    }

    @Test func modelExistsReturnsFalseForMissing() {
        let manager = ModelManager(appGroupIdentifier: "group.com.test.nonexistent")
        #expect(manager.modelExists(version: "v2.0") == false)
    }

    @Test func currentModelVersionReturnsNilWhenEmpty() {
        let manager = ModelManager(appGroupIdentifier: "group.com.test.nonexistent")
        #expect(manager.currentModelVersion() == nil)
    }
}
