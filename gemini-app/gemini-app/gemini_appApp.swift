import SwiftUI
import os.log

private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "gemini-app", category: "gemini_appApp")

// Notification names for app lifecycle
let appMovedToBackgroundNotificationName = NSNotification.Name("app.movedToBackground")
let appMovedToForegroundNotificationName = NSNotification.Name("app.movedToForeground")

@main
struct gemini_appApp: App {
    @State private var notificationService = NotificationService.shared

    init() {
        // Register background task handler on app launch (iOS only)
        #if os(iOS)
        BackgroundTaskManager.shared.registerBackgroundTaskHandler()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            AppContent()
                .environmentObject(notificationService)
        }
        #if os(macOS)
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1200, height: 800)
        #endif

        #if os(macOS)
        Settings {
            SettingsView()
        }
        #endif
    }
}

// MARK: - App Content with Scene Phase Handling

struct AppContent: View {
    @Environment(\.scenePhase) var scenePhase

    var body: some View {
        ContentView()
            .onChange(of: scenePhase) { oldPhase, newPhase in
                handleScenePhaseChange(from: oldPhase, to: newPhase)
            }
    }

    private func handleScenePhaseChange(from oldPhase: ScenePhase, to newPhase: ScenePhase) {
        switch (oldPhase, newPhase) {
        case (_, .background):
            handleAppMovedToBackground()
        case (.background, .active):
            handleAppMovedToForeground()
        default:
            break
        }
    }

    private func handleAppMovedToBackground() {
        logger.info("App moved to background")
        NotificationCenter.default.post(
            Notification(name: appMovedToBackgroundNotificationName, object: nil)
        )
        #if os(iOS)
        // Schedule background processing task to monitor SSE during suspension
        BackgroundTaskManager.shared.scheduleBackgroundTask()
        #endif
    }

    private func handleAppMovedToForeground() {
        logger.info("App moved to foreground")
        NotificationCenter.default.post(
            Notification(name: appMovedToForegroundNotificationName, object: nil)
        )
        #if os(iOS)
        // Cancel the background task now that app is active
        BackgroundTaskManager.shared.cancelBackgroundTask()
        #endif
    }
}
