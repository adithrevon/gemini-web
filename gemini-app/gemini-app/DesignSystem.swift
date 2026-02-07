import SwiftUI

// MARK: - App Constants

enum AppConstants {
    static let defaultServerURL = "http://127.0.0.1:7337"
    static let defaultModel = "auto-gemini-2.5"
    static let maxRecentProjects = 10
}

// MARK: - Spacing

enum Spacing {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
}

// MARK: - Corner Radius

enum CornerRadius {
    static let small: CGFloat = 8
    static let medium: CGFloat = 12
    static let large: CGFloat = 16
    static let pill: CGFloat = 24
}

// MARK: - Semantic Colors

extension Color {
    // Status colors
    static let statusConnected = Color.green
    static let statusConnecting = Color.orange
    static let statusError = Color.red

    // Message bubbles
    static let userBubble = Color.accentColor
    #if os(iOS)
    static let assistantBubble = Color(uiColor: .systemGray6)
    static let surfaceSecondary = Color(uiColor: .systemGray6)
    static let surfaceTertiary = Color(uiColor: .systemGray5)
    #else
    static let assistantBubble = Color(nsColor: .controlBackgroundColor)
    static let surfaceSecondary = Color(nsColor: .controlBackgroundColor)
    static let surfaceTertiary = Color(nsColor: .windowBackgroundColor)
    #endif

    // Tool status
    static let toolPending = Color.secondary
    static let toolExecuting = Color.accentColor
    static let toolSuccess = Color.green
    static let toolError = Color.red
    static let toolConfirming = Color.orange
}

// MARK: - Typography

extension Font {
    static let heroTitle = Font.largeTitle.weight(.bold)
    static let sectionHeader = Font.subheadline.weight(.semibold)
    static let messageBody = Font.body
    static let messageSender = Font.caption.weight(.medium)
    static let statusBadge = Font.caption2.weight(.medium)
    static let codeBlock = Font.system(.caption, design: .monospaced)
}

// MARK: - Animation

enum AppAnimation {
    static let spring = Animation.spring(response: 0.35, dampingFraction: 0.7)
    static let quick = Animation.easeOut(duration: 0.2)
    static let standard = Animation.easeInOut(duration: 0.25)
}

// MARK: - View Modifiers

struct MessageBubbleStyle: ViewModifier {
    let isUser: Bool

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.md)
            .background(isUser ? Color.userBubble : Color.assistantBubble)
            .foregroundStyle(isUser ? .white : .primary)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.large, style: .continuous))
    }
}

struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Color.surfaceSecondary)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.medium, style: .continuous))
    }
}

struct StatusBadgeStyle: ViewModifier {
    let color: Color

    func body(content: Content) -> some View {
        content
            .font(.statusBadge)
            .foregroundStyle(.white)
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, Spacing.xs)
            .background(color)
            .clipShape(Capsule())
    }
}

struct InputFieldStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.md)
            .background(Color.surfaceSecondary)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.pill, style: .continuous))
    }
}

// MARK: - View Extensions

extension View {
    func messageBubbleStyle(isUser: Bool) -> some View {
        modifier(MessageBubbleStyle(isUser: isUser))
    }

    func cardStyle() -> some View {
        modifier(CardStyle())
    }

    func statusBadgeStyle(color: Color) -> some View {
        modifier(StatusBadgeStyle(color: color))
    }

    func inputFieldStyle() -> some View {
        modifier(InputFieldStyle())
    }
}

