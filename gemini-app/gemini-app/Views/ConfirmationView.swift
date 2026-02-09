import SwiftUI

struct ConfirmationView: View {
    let details: ConfirmationDetails
    let isTrustedFolder: Bool
    let onConfirm: (ConfirmOutcome) -> Void

    @State private var isExpanded = false

    private var confirmationType: ConfirmationType {
        if details.command != nil {
            return .command
        } else if details.fileDiff != nil {
            return .fileEdit
        } else {
            return .generic
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: Spacing.sm) {
                // Icon
                ZStack {
                    Circle()
                        .fill(Color.accentColor.opacity(0.15))
                        .frame(width: 32, height: 32)

                    Image(systemName: confirmationType.icon)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(confirmationType.title)
                        .font(.subheadline.weight(.semibold))

                    if let subtitle = details.fileName ?? details.toolDisplayName {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                // Expand/collapse for diff
                if details.fileDiff != nil {
                    Button {
                        withAnimation(AppAnimation.quick) {
                            isExpanded.toggle()
                        }
                    } label: {
                        Image(systemName: "chevron.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isExpanded ? 180 : 0))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.md)

            // Command preview (inline)
            if let command = details.command {
                HStack(spacing: Spacing.sm) {
                    Text("$")
                        .font(.system(.caption, design: .monospaced).weight(.bold))
                        .foregroundStyle(.tertiary)

                    Text(command)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(isExpanded ? nil : 2)
                        .foregroundStyle(.primary)
                }
                .padding(.horizontal, Spacing.md)
                .padding(.vertical, Spacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.surfaceTertiary.opacity(0.5))
            }

            // File diff (expandable)
            if let fileDiff = details.fileDiff, isExpanded {
                ScrollView(.horizontal, showsIndicators: false) {
                    ScrollView(.vertical, showsIndicators: true) {
                        DiffView(diff: fileDiff)
                            .padding(Spacing.sm)
                    }
                    .frame(maxHeight: 200)
                }
                .background(Color.surfaceTertiary.opacity(0.5))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            // Action buttons
            HStack(spacing: Spacing.sm) {
                // Cancel
                Button {
                    onConfirm(.cancel)
                } label: {
                    Text("Deny")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Spacing.sm)
                        .background(Color.surfaceSecondary)
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.small, style: .continuous))
                }
                .buttonStyle(.plain)

                // Proceed
                Button {
                    onConfirm(.proceed_once)
                } label: {
                    Text("Allow")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Spacing.sm)
                        .background(Color.accentColor)
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.small, style: .continuous))
                }
                .buttonStyle(.plain)

                // Always (session-wide)
                Button {
                    onConfirm(.proceed_always)
                } label: {
                    Text("Always")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.statusConnected)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Spacing.sm)
                        .background(Color.statusConnected.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.small, style: .continuous))
                }
                .buttonStyle(.plain)
            }
            .padding(Spacing.md)
        }
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.medium, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: CornerRadius.medium, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
    }
}

// MARK: - Confirmation Type

private enum ConfirmationType {
    case command
    case fileEdit
    case generic

    var icon: String {
        switch self {
        case .command: return "terminal"
        case .fileEdit: return "doc.badge.plus"
        case .generic: return "questionmark.circle"
        }
    }

    var title: String {
        switch self {
        case .command: return "Run Command"
        case .fileEdit: return "Edit File"
        case .generic: return "Confirmation Required"
        }
    }
}

// MARK: - Diff View

struct DiffView: View {
    let diff: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                DiffLineView(line: line)
            }
        }
    }
}

struct DiffLineView: View {
    let line: String

    private var lineType: DiffLineType {
        if line.hasPrefix("+") && !line.hasPrefix("+++") {
            return .addition
        } else if line.hasPrefix("-") && !line.hasPrefix("---") {
            return .deletion
        } else {
            return .context
        }
    }

    var body: some View {
        Text(line)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(lineType.textColor)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Spacing.xs)
            .background(lineType.backgroundColor)
    }
}

private enum DiffLineType {
    case addition
    case deletion
    case context

    var textColor: Color {
        switch self {
        case .addition: return .green
        case .deletion: return .red
        case .context: return .primary
        }
    }

    var backgroundColor: Color {
        switch self {
        case .addition: return .green.opacity(0.1)
        case .deletion: return .red.opacity(0.1)
        case .context: return .clear
        }
    }
}

#Preview("Command Confirmation") {
    VStack(spacing: Spacing.lg) {
        ConfirmationView(
            details: ConfirmationDetails(
                type: "exec",
                title: nil,
                command: "npm install @types/node --save-dev",
                rootCommand: nil,
                prompt: nil,
                toolDisplayName: "Bash",
                toolName: "bash",
                fileName: nil,
                filePath: nil,
                fileDiff: nil
            ),
            isTrustedFolder: false,
            onConfirm: { _ in }
        )
    }
    .padding()
    .background(Color.surfaceSecondary)
}

#Preview("File Edit Confirmation") {
    VStack(spacing: Spacing.lg) {
        ConfirmationView(
            details: ConfirmationDetails(
                type: "edit",
                title: nil,
                command: nil,
                rootCommand: nil,
                prompt: nil,
                toolDisplayName: "Edit",
                toolName: "edit",
                fileName: "main.swift",
                filePath: "/src/main.swift",
                fileDiff: """
                + import Foundation
                - import UIKit

                  func main() {
                +     print("Hello")
                  }
                """
            ),
            isTrustedFolder: true,
            onConfirm: { _ in }
        )
    }
    .padding()
    .background(Color.surfaceSecondary)
}
