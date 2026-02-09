import Foundation
import SwiftUI
import os.log

private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "gemini-app", category: "InAppNotification")

// MARK: - In-App Notification Model

struct InAppNotificationItem: Identifiable {
    let id: String
    let instanceId: String
    let title: String
    let message: String
    let action: String?
    let timestamp: Date

    var projectName: String {
        title
    }
}

// MARK: - In-App Notification Manager

@Observable
final class InAppNotificationManager {
    var notifications: [InAppNotificationItem] = []
    var isExpanded = false

    func show(
        instanceId: String,
        projectName: String,
        title: String = "Conversation Complete"
    ) {
        let item = InAppNotificationItem(
            id: UUID().uuidString,
            instanceId: instanceId,
            title: projectName,
            message: title,
            action: "tap_to_view",
            timestamp: Date()
        )

        // Add notification to list (no auto-dismiss, persistent)
        notifications.insert(item, at: 0)
        logger.info("Notification shown: \(projectName)")
    }

    func dismiss(notificationId: String) {
        notifications.removeAll { $0.id == notificationId }

        // Close expanded view if no more notifications
        if notifications.isEmpty {
            isExpanded = false
        }
        logger.info("Notification dismissed")
    }

    func dismissAll() {
        notifications.removeAll()
        isExpanded = false
    }

    func toggleExpanded() {
        isExpanded.toggle()
    }
}

// MARK: - Notification Badge View (Dynamic Island style)

struct NotificationBadge: View {
    let manager: InAppNotificationManager
    let onNotificationTap: (String) -> Void

    var isSingleNotification: Bool {
        manager.notifications.count == 1
    }

    @State private var swipeOffset: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()

                VStack(spacing: 12) {
                    // Expanded picker for multiple notifications
                    if manager.isExpanded && !isSingleNotification {
                        NotificationPickerView(
                            notifications: manager.notifications,
                            onNotificationTap: { instanceId in
                                logger.info("Notification tapped: \(instanceId)")
                                manager.isExpanded = false
                                onNotificationTap(instanceId)
                            },
                            onDismiss: { notificationId in
                                manager.dismiss(notificationId: notificationId)
                            }
                        )
                        .transition(.asymmetric(
                            insertion: .move(edge: .top).combined(with: .opacity),
                            removal: .move(edge: .top).combined(with: .opacity)
                        ))
                    }

                    // Dynamic Island style badge
                    ZStack(alignment: .trailing) {
                        // Dismiss background (red) for swipe
                        HStack {
                            Spacer()
                            Image(systemName: "trash.fill")
                                .font(.caption2)
                                .foregroundStyle(.white)
                                .padding(.trailing, 12)
                        }
                        .background(Color.red)
                        .cornerRadius(18)
                        .opacity(swipeOffset < -20 ? 1 : 0)

                        // Badge button - styled like Dynamic Island
                        Button(action: {
                            if isSingleNotification {
                                // Single notification: navigate directly
                                if let notification = manager.notifications.first {
                                    logger.info("Single notification tapped, navigating to: \(notification.instanceId)")
                                    onNotificationTap(notification.instanceId)
                                }
                            } else {
                                // Multiple notifications: toggle expanded
                                manager.toggleExpanded()
                            }
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "bell.fill")
                                    .font(.system(size: 12, weight: .semibold))

                                VStack(alignment: .leading, spacing: 2) {
                                    if isSingleNotification {
                                        if let notification = manager.notifications.first {
                                            Text(notification.title)
                                                .font(.caption.weight(.semibold))
                                                .lineLimit(1)
                                        }
                                    } else {
                                        Text("Notifications")
                                            .font(.caption.weight(.semibold))

                                        Text("\(manager.notifications.count) pending")
                                            .font(.caption2)
                                            .foregroundStyle(.white.opacity(0.8))
                                    }
                                }

                                if !isSingleNotification {
                                    Spacer()
                                    Image(systemName: "chevron.down")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.white.opacity(0.6))
                                        .padding(.trailing, 4)
                                }
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(Color.black.opacity(0.8))
                            .cornerRadius(18)
                        }
                        .offset(x: swipeOffset)
                        .gesture(
                            DragGesture()
                                .onChanged { value in
                                    let newOffset = value.translation.width
                                    if newOffset < 0 {
                                        swipeOffset = min(newOffset, 0)
                                    }
                                }
                                .onEnded { _ in
                                    if swipeOffset < -40 {
                                        // Swipe to dismiss
                                        withAnimation(.easeInOut(duration: 0.3)) {
                                            swipeOffset = -100
                                        }
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                                            manager.dismissAll()
                                            swipeOffset = 0
                                        }
                                    } else {
                                        // Reset
                                        withAnimation(.easeInOut(duration: 0.2)) {
                                            swipeOffset = 0
                                        }
                                    }
                                }
                        )
                    }
                }
                .padding(.horizontal, Spacing.lg)
                .padding(.top, Spacing.md)

                Spacer()
            }

            Spacer()
        }
        .opacity(manager.notifications.isEmpty ? 0 : 1)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: manager.isExpanded)
        .animation(.easeInOut(duration: 0.2), value: manager.notifications.count)
    }
}

// MARK: - Notification Picker View

struct NotificationPickerView: View {
    let notifications: [InAppNotificationItem]
    let onNotificationTap: (String) -> Void
    let onDismiss: (String) -> Void

    var body: some View {
        VStack(spacing: Spacing.sm) {
            Text("Notifications")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Spacing.md)
                .padding(.top, Spacing.md)

            VStack(spacing: Spacing.xs) {
                ForEach(notifications) { notification in
                    NotificationPickerItem(
                        notification: notification,
                        onTap: {
                            onNotificationTap(notification.instanceId)
                        },
                        onDismiss: {
                            onDismiss(notification.id)
                        }
                    )
                }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.bottom, Spacing.md)
        }
        .cardStyle()
        .shadow(radius: 8, y: 4)
    }
}

// MARK: - Notification Picker Item

struct NotificationPickerItem: View {
    let notification: InAppNotificationItem
    let onTap: () -> Void
    let onDismiss: () -> Void

    @State private var offset: CGFloat = 0

    var body: some View {
        ZStack(alignment: .trailing) {
            // Dismiss background
            HStack {
                Spacer()
                Image(systemName: "trash.fill")
                    .font(.caption)
                    .foregroundStyle(.white)
                    .padding(.trailing, Spacing.md)
            }
            .background(Color.red)
            .cornerRadius(CornerRadius.small)

            // Content
            HStack(spacing: Spacing.md) {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(notification.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)

                    Text(notification.message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(Spacing.md)
            .cardStyle()
            .contentShape(Rectangle())
            .onTapGesture {
                if abs(offset) < 20 {
                    onTap()
                }
            }
            .offset(x: offset)
            .gesture(
                DragGesture()
                    .onChanged { value in
                        let newOffset = value.translation.width
                        if newOffset < 0 {
                            offset = min(newOffset, 0)
                        }
                    }
                    .onEnded { _ in
                        if offset < -60 {
                            // Swipe to dismiss
                            withAnimation(.easeInOut(duration: 0.3)) {
                                offset = -200
                            }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                                onDismiss()
                            }
                        } else {
                            // Reset
                            withAnimation(.easeInOut(duration: 0.2)) {
                                offset = 0
                            }
                        }
                    }
            )
        }
        .frame(height: 60)
    }
}

// MARK: - Preview

#Preview {
    ZStack {
        Color.surfaceSecondary.ignoresSafeArea()

        VStack {
            Text("Preview")
            Spacer()
        }
        .padding()

        NotificationBadge(
            manager: {
                let manager = InAppNotificationManager()
                manager.show(instanceId: "1", projectName: "My Project", title: "Conversation Complete")
                manager.show(instanceId: "2", projectName: "Another Project", title: "Action Required")
                return manager
            }(),
            onNotificationTap: { _ in }
        )
    }
}
