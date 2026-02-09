import BackgroundTasks
import os.log

private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "gemini-app", category: "BackgroundTaskManager")

/// Manages background task execution for SSE monitoring during backgrounding
/// Only active on iOS; no-op on macOS
@MainActor
final class BackgroundTaskManager {
    static let shared = BackgroundTaskManager()

    // MARK: - Constants

    private static let processingTaskIdentifier = "com.prem.gemini-app.sse-monitor"

    // MARK: - Background Task Scheduling

    /// Schedule a background processing task to monitor SSE during app suspension
    /// This extends the app's execution time by ~30 seconds when backgrounded (iOS only)
    func scheduleBackgroundTask() {
        #if os(iOS)
        let request = BGProcessingTaskRequest(identifier: Self.processingTaskIdentifier)
        request.requiresNetworkConnectivity = true

        do {
            try BGTaskScheduler.shared.submit(request)
            logger.info("Background processing task scheduled")
        } catch {
            logger.error("Failed to schedule background task: \(error.localizedDescription)")
        }
        #endif
    }

    /// Register background task handler (call from app launch)
    /// Only active on iOS; no-op on macOS
    func registerBackgroundTaskHandler() {
        #if os(iOS)
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.processingTaskIdentifier,
            using: nil
        ) { [weak self] task in
            self?.handleBackgroundTask(task)
        }
        logger.info("Background task handler registered")
        #endif
    }

    /// Handle the background processing task
    #if os(iOS)
    private func handleBackgroundTask(_ task: BGTask) {
        logger.info("Background task executing")

        // Schedule the next task before this one expires
        scheduleBackgroundTask()

        // Perform work - the SSE connection maintained by SessionService will
        // continue streaming events during this ~30 second window
        // This keeps the app from being fully suspended while conversations complete
        Task {
            try? await Task.sleep(nanoseconds: 500_000_000) // 0.5 seconds
            task.setTaskCompleted(success: true)
        }
    }
    #endif

    /// Cancel the scheduled background task
    func cancelBackgroundTask() {
        #if os(iOS)
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.processingTaskIdentifier)
        logger.info("Background task cancelled")
        #endif
    }
}
