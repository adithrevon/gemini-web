import SwiftUI

struct ToolGroupView: View {
    let tools: [ToolCall]
    let isTrustedFolder: Bool
    let onConfirm: (String, ConfirmOutcome, String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            ForEach(tools) { tool in
                ToolCallView(
                    tool: tool,
                    isTrustedFolder: isTrustedFolder,
                    onConfirm: onConfirm
                )
            }
        }
        .padding(Spacing.md)
        .cardStyle()
    }
}

struct ToolCallView: View {
    let tool: ToolCall
    let isTrustedFolder: Bool
    let onConfirm: (String, ConfirmOutcome, String?) -> Void

    @State private var isExpanded = false

    private var hasContent: Bool {
        tool.description != nil || tool.renderedResult != nil || tool.confirmationDetails?.fileDiff != nil || tool.confirmationDetails?.command != nil
    }

    private var statusName: String {
        (tool.status ?? "pending").lowercased()
    }

    private var statusColor: Color {
        switch statusName {
        case "pending": return .toolPending
        case "executing": return .toolExecuting
        case "success": return .toolSuccess
        case "error": return .toolError
        case "confirming": return .toolConfirming
        default: return .toolPending
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            // Header
            HStack(spacing: Spacing.sm) {
                // Expand button
                if hasContent {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .animation(AppAnimation.quick, value: isExpanded)
                } else {
                    Spacer()
                        .frame(width: 12)
                }

                // Tool icon
                Image(systemName: toolIcon)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                // Tool name
                Text(tool.name)
                    .font(.subheadline.weight(.medium))

                Spacer()

                // Status badge
                Text(tool.status ?? "pending")
                    .statusBadgeStyle(color: statusColor)
            }
            .contentShape(Rectangle())
            .onTapGesture {
                if hasContent {
                    withAnimation(AppAnimation.spring) {
                        isExpanded.toggle()
                    }
                }
            }

            // Expanded content
            if isExpanded && hasContent {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    // File path
                    if let filePath = tool.confirmationDetails?.filePath {
                        Text(filePath)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    // File diff (from confirmationDetails — available in both confirm and bypass modes)
                    if statusName != "confirming", let fileDiff = tool.confirmationDetails?.fileDiff {
                        ScrollView(.horizontal, showsIndicators: false) {
                            ScrollView(.vertical, showsIndicators: true) {
                                DiffView(diff: fileDiff)
                                    .padding(Spacing.sm)
                            }
                            .frame(maxHeight: 200)
                        }
                        .background(Color.surfaceTertiary.opacity(0.5))
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.small, style: .continuous))
                    }

                    // Command preview
                    if statusName != "confirming", let command = tool.confirmationDetails?.command {
                        HStack(spacing: Spacing.sm) {
                            Text("$")
                                .font(.system(.caption, design: .monospaced).weight(.bold))
                                .foregroundStyle(.tertiary)
                            Text(command)
                                .font(.system(.caption, design: .monospaced))
                                .lineLimit(3)
                                .foregroundStyle(.primary)
                        }
                        .padding(Spacing.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.surfaceTertiary.opacity(0.5))
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.small, style: .continuous))
                    }

                    // Tool result (fallback for tools without diff/command)
                    if tool.confirmationDetails?.fileDiff == nil && tool.confirmationDetails?.command == nil,
                       let resultText = tool.renderedResult {
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(resultText)
                                .font(.codeBlock)
                                .foregroundStyle(.primary)
                        }
                        .frame(maxHeight: 200)
                        .padding(Spacing.sm)
                        .background(Color.surfaceTertiary)
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.small, style: .continuous))
                    }
                }
                .padding(.leading, Spacing.xl)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            // Confirmation actions
            if statusName == "confirming", let details = tool.confirmationDetails {
                ConfirmationView(
                    details: details,
                    isTrustedFolder: isTrustedFolder
                ) { outcome in
                    onConfirm(tool.callId, outcome, tool.correlationId)
                }
                .padding(.leading, Spacing.xl)
            }
        }
    }

    private var toolIcon: String {
        switch tool.name.lowercased() {
        case let n where n.contains("read"): return "doc.text"
        case let n where n.contains("write"), let n where n.contains("edit"): return "pencil"
        case let n where n.contains("bash"), let n where n.contains("command"): return "terminal"
        case let n where n.contains("search"), let n where n.contains("grep"): return "magnifyingglass"
        case let n where n.contains("list"), let n where n.contains("glob"): return "folder"
        default: return "gearshape"
        }
    }
}

#Preview {
    VStack {
        ToolGroupView(
            tools: [
                ToolCall(
                    callId: "1",
                    name: "read_file",
                    description: "Reading src/main.swift",
                    status: "success",
                    resultDisplay: .text("File contents here..."),
                    confirmationDetails: nil,
                    correlationId: nil
                ),
                ToolCall(
                    callId: "2",
                    name: "write_file",
                    description: nil,
                    status: "confirming",
                    resultDisplay: nil,
                    confirmationDetails: ConfirmationDetails(
                        type: "edit",
                        title: "Edit file",
                        command: nil,
                        rootCommand: nil,
                        prompt: nil,
                        toolDisplayName: nil,
                        toolName: nil,
                        fileName: "main.swift",
                        filePath: "/src/main.swift",
                        fileDiff: "+ new line\n- old line"
                    ),
                    correlationId: nil
                )
            ],
            isTrustedFolder: false,
            onConfirm: { _, _, _ in }
        )
        .padding()

        Spacer()
    }
}
