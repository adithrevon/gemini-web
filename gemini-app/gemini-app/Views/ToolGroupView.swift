import SwiftUI

struct ToolGroupView: View {
    let tools: [ToolCall]
    let isTrustedFolder: Bool
    let onConfirm: (String, ConfirmOutcome, String?) -> Void
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(tools) { tool in
                ToolCallView(
                    tool: tool,
                    isTrustedFolder: isTrustedFolder,
                    onConfirm: onConfirm
                )
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.15))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct ToolCallView: View {
    let tool: ToolCall
    let isTrustedFolder: Bool
    let onConfirm: (String, ConfirmOutcome, String?) -> Void
    
    @State private var isExpanded = false
    
    private var hasContent: Bool {
        tool.description != nil || tool.renderedResult != nil
    }
    
    private var statusName: String {
        (tool.status ?? "pending").lowercased()
    }
    
    private var statusColor: Color {
        switch statusName {
        case "pending": return .secondary
        case "executing": return .blue
        case "success": return .green
        case "error": return .red
        case "confirming": return .orange
        default: return .secondary
        }
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Header
            HStack {
                // Expand button
                if hasContent {
                    Button {
                        withAnimation(.spring(response: 0.3)) {
                            isExpanded.toggle()
                        }
                    } label: {
                        Image(systemName: "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                    .buttonStyle(.plain)
                } else {
                    Spacer()
                        .frame(width: 16)
                }
                
                // Tool name
                Text(tool.name)
                    .font(.subheadline)
                    .fontWeight(.medium)
                
                Spacer()
                
                // Status badge
                Text(tool.status ?? "pending")
                    .font(.caption2)
                    .fontWeight(.medium)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(statusColor)
                    .clipShape(Capsule())
            }
            .contentShape(Rectangle())
            .onTapGesture {
                if hasContent {
                    withAnimation(.spring(response: 0.3)) {
                        isExpanded.toggle()
                    }
                }
            }
            
            // Expanded content
            if isExpanded && hasContent {
                VStack(alignment: .leading, spacing: 8) {
                    if let description = tool.description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    
                    if let resultText = tool.renderedResult {
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(resultText)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.primary)
                        }
                        .frame(maxHeight: 200)
                        .padding(8)
                        .background(Color.primary.opacity(0.05))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
                .padding(.leading, 24)
            }
            
            // Confirmation actions
            if statusName == "confirming", let details = tool.confirmationDetails {
                ConfirmationView(
                    details: details,
                    isTrustedFolder: isTrustedFolder
                ) { outcome in
                    onConfirm(tool.callId, outcome, tool.correlationId)
                }
                .padding(.leading, 24)
            }
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
