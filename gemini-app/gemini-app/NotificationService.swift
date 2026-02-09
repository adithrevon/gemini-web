import UserNotifications
import SwiftUI
import Combine
import os.log

private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "gemini-app", category: "NotificationService")

/// Central notification manager for handling local and push notifications
@MainActor
final class NotificationService: NSObject, ObservableObject {
    static let shared = NotificationService()

    // MARK: - Published Properties

    @Published var notificationPermissionGranted = false

    // MARK: - Initialization

    override init() {
        super.init()
        checkNotificationPermission()
        // Request permission on init - this is non-blocking
        // User will see system prompt the first time
        requestPermissionIfNeeded()
    }

    /// Request permission if not already granted
    private func requestPermissionIfNeeded() {
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .notDetermined {
                // Only request if not yet determined
                self.requestPermission()
            }
        }
    }

    // MARK: - Permission Management

    /// Check the current notification permission status
    private func checkNotificationPermission() {
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            await MainActor.run {
                self.notificationPermissionGranted = settings.authorizationStatus == .authorized
            }
        }
    }

    /// Request notification permission from the user
    func requestPermission() {
        Task {
            do {
                let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
                self.notificationPermissionGranted = granted
                if granted {
                    logger.info("Notification permission granted")
                } else {
                    logger.warning("Notification permission denied by user")
                }
            } catch {
                logger.error("Failed to request notification permission: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Local Notifications

    /// Schedule a notification for conversation completion
    func scheduleConversationCompleteNotification(
        instanceId: String,
        projectPath: String
    ) {
        guard notificationPermissionGranted else {
            logger.warning("Cannot schedule notification: permission not granted")
            return
        }

        let projectName = projectPath.split(separator: "/").last.map(String.init) ?? projectPath

        let content = UNMutableNotificationContent()
        content.title = "Gemini Chat Complete"
        content.body = "Your conversation in \(projectName) is ready"
        content.sound = .default
        content.badge = NSNumber(value: 1)

        // Deep link URL for notification tap
        // Format: gemini-app://notification?id=<instanceId>&action=conversation_complete
        content.userInfo = [
            "deepLink": "gemini-app://notification?id=\(instanceId)&action=conversation_complete"
        ]

        // Schedule for immediate delivery
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        let request = UNNotificationRequest(
            identifier: "conversation-complete-\(instanceId)",
            content: content,
            trigger: trigger
        )

        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                logger.error("Failed to schedule notification: \(error.localizedDescription)")
            } else {
                logger.info("Scheduled notification for instance: \(instanceId)")
            }
        }
    }

    /// Schedule a notification for tool confirmation needed
    func scheduleConfirmationNeededNotification(
        instanceId: String,
        toolName: String,
        projectPath: String
    ) {
        guard notificationPermissionGranted else {
            logger.warning("Cannot schedule notification: permission not granted")
            return
        }

        let projectName = projectPath.split(separator: "/").last.map(String.init) ?? projectPath

        let content = UNMutableNotificationContent()
        content.title = "Action Required"
        content.body = "Approve tool: \(toolName) in \(projectName)"
        content.sound = .default
        content.badge = NSNumber(value: 1)

        // Deep link URL for notification tap
        // Format: gemini-app://notification?id=<instanceId>&action=confirmation_needed
        content.userInfo = [
            "deepLink": "gemini-app://notification?id=\(instanceId)&action=confirmation_needed"
        ]

        // Schedule for immediate delivery
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        let request = UNNotificationRequest(
            identifier: "confirmation-needed-\(instanceId)",
            content: content,
            trigger: trigger
        )

        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                logger.error("Failed to schedule confirmation notification: \(error.localizedDescription)")
            } else {
                logger.info("Scheduled confirmation notification for instance: \(instanceId)")
            }
        }
    }

    /// Cancel all notifications for a specific instance
    func cancelNotifications(for instanceId: String) {
        let identifiersToCancel = [
            "conversation-complete-\(instanceId)",
            "confirmation-needed-\(instanceId)"
        ]
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: identifiersToCancel)
        logger.info("Cancelled notifications for instance: \(instanceId)")
    }

    /// Cancel all notifications
    func cancelAllNotifications() {
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        logger.info("Cancelled all notifications")
    }
}
