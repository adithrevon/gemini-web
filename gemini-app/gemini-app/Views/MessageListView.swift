import SwiftUI
import Combine

struct MessageListView: View {
    let history: [Message]
    let pending: [Message]
    let streamingState: StreamingState
    let isTrustedFolder: Bool
    let onConfirm: (String, ConfirmOutcome, String?) -> Void

    private var allMessages: [Message] {
        history + pending
    }

    // Combine consecutive gemini messages into groups
    private var groupedMessages: [(id: Int, content: GroupedMessage)] {
        var result: [(id: Int, content: GroupedMessage)] = []
        var currentGeminiTexts: [String] = []
        var groupId = 0

        for message in allMessages {
            switch message {
            case .gemini(let text), .geminiContent(let text):
                currentGeminiTexts.append(text)
            case .user(let text):
                if !currentGeminiTexts.isEmpty {
                    result.append((groupId, .geminiGroup(currentGeminiTexts)))
                    groupId += 1
                    currentGeminiTexts = []
                }
                result.append((groupId, .user(text)))
                groupId += 1
            case .toolGroup(let tools):
                if !currentGeminiTexts.isEmpty {
                    result.append((groupId, .geminiGroup(currentGeminiTexts)))
                    groupId += 1
                    currentGeminiTexts = []
                }
                result.append((groupId, .toolGroup(tools)))
                groupId += 1
            }
        }

        // Don't forget remaining gemini messages
        if !currentGeminiTexts.isEmpty {
            result.append((groupId, .geminiGroup(currentGeminiTexts)))
        }

        return result
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Spacing.md) {
                    ForEach(groupedMessages, id: \.id) { item in
                        GroupedMessageRowView(
                            message: item.content,
                            isTrustedFolder: isTrustedFolder,
                            onConfirm: onConfirm
                        )
                        .id(item.id)
                        .transition(.asymmetric(
                            insertion: .opacity.combined(with: .move(edge: .bottom)),
                            removal: .opacity
                        ))
                    }

                    // Typing indicator
                    if streamingState == .responding {
                        TypingIndicatorView()
                            .id("typing")
                            .transition(.opacity.combined(with: .scale(scale: 0.8)))
                    }

                    // Bottom anchor for scrolling
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding(.horizontal, Spacing.md)
                .padding(.vertical, Spacing.sm)
            }
            .contentShape(Rectangle())
            .onTapGesture {
                dismissKeyboard()
            }
            .onChange(of: allMessages.count) { _, _ in
                withAnimation(AppAnimation.spring) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .onChange(of: streamingState) { _, _ in
                withAnimation(AppAnimation.spring) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
    }

    private func dismissKeyboard() {
        #if os(iOS)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        #endif
    }
}

// MARK: - Grouped Message Types

enum GroupedMessage {
    case user(String)
    case geminiGroup([String])
    case toolGroup([ToolCall])
}

// MARK: - Grouped Message Row

struct GroupedMessageRowView: View {
    let message: GroupedMessage
    let isTrustedFolder: Bool
    let onConfirm: (String, ConfirmOutcome, String?) -> Void

    var body: some View {
        switch message {
        case .user(let text):
            UserMessageView(text: text)
        case .geminiGroup(let texts):
            GeminiMessageView(texts: texts)
        case .toolGroup(let tools):
            ToolGroupView(
                tools: tools,
                isTrustedFolder: isTrustedFolder,
                onConfirm: onConfirm
            )
        }
    }
}

// MARK: - User Message

struct UserMessageView: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 48)

            Text(text)
                .messageBubbleStyle(isUser: true)
        }
    }
}

// MARK: - Gemini Message

struct GeminiMessageView: View {
    let texts: [String]

    private var combinedText: String {
        texts.joined(separator: "\n\n")
    }

    var body: some View {
        HStack(alignment: .top) {
            MarkdownTextView(text: combinedText)
                .textSelection(.enabled)
                .padding(.horizontal, Spacing.lg)
                .padding(.vertical, Spacing.md)
                .background(Color.assistantBubble)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.large, style: .continuous))

            Spacer(minLength: 48)
        }
        .contextMenu {
            Button {
                UIPasteboard.general.string = combinedText
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
    }
}

// MARK: - Markdown Text View

struct MarkdownTextView: View {
    let text: String

    private var blocks: [MarkdownBlock] {
        parseMarkdown(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let level, let content):
                    headingView(level: level, content: content)
                case .bullet(let content):
                    bulletView(content: content)
                case .code(let content):
                    codeBlockView(content: content)
                case .paragraph(let content):
                    paragraphView(content: content)
                }
            }
        }
    }

    @ViewBuilder
    private func headingView(level: Int, content: String) -> some View {
        let font: Font = switch level {
        case 1: .title2.bold()
        case 2: .title3.bold()
        case 3: .headline
        default: .subheadline.bold()
        }
        Text(inlineMarkdown(content))
            .font(font)
    }

    @ViewBuilder
    private func bulletView(content: String) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Text("•")
                .foregroundStyle(.secondary)
            Text(inlineMarkdown(content))
        }
    }

    @ViewBuilder
    private func codeBlockView(content: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(content)
                .font(.system(.caption, design: .monospaced))
                .padding(Spacing.sm)
        }
        .background(Color.surfaceTertiary)
        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.small, style: .continuous))
    }

    @ViewBuilder
    private func paragraphView(content: String) -> some View {
        if !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text(inlineMarkdown(content))
        }
    }

    private func inlineMarkdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }

    private func parseMarkdown(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        let lines = text.components(separatedBy: "\n")
        var i = 0
        var paragraphBuffer: [String] = []

        func flushParagraph() {
            if !paragraphBuffer.isEmpty {
                let content = paragraphBuffer.joined(separator: " ")
                if !content.trimmingCharacters(in: .whitespaces).isEmpty {
                    blocks.append(.paragraph(content))
                }
                paragraphBuffer = []
            }
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Empty line - flush paragraph
            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            // Code block
            if trimmed.hasPrefix("```") {
                flushParagraph()
                var codeLines: [String] = []
                i += 1
                while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(lines[i])
                    i += 1
                }
                if !codeLines.isEmpty {
                    blocks.append(.code(codeLines.joined(separator: "\n")))
                }
                i += 1
                continue
            }

            // Heading
            if let match = trimmed.firstMatch(of: /^(#{1,4})\s+(.+)$/) {
                flushParagraph()
                let level = match.1.count
                let content = String(match.2)
                blocks.append(.heading(level, content))
                i += 1
                continue
            }

            // Bullet point
            if let match = trimmed.firstMatch(of: /^[\*\-]\s+(.+)$/) {
                flushParagraph()
                blocks.append(.bullet(String(match.1)))
                i += 1
                continue
            }

            // Regular text - add to paragraph buffer
            paragraphBuffer.append(trimmed)
            i += 1
        }

        flushParagraph()
        return blocks
    }
}

private enum MarkdownBlock {
    case heading(Int, String)
    case bullet(String)
    case code(String)
    case paragraph(String)
}

// MARK: - Typing Indicator

struct TypingIndicatorView: View {
    @State private var animatingIndex = 0
    private let timer = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(alignment: .top) {
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Color.secondary)
                        .frame(width: 6, height: 6)
                        .opacity(animatingIndex == index ? 1 : 0.3)
                        .scaleEffect(animatingIndex == index ? 1.2 : 1.0)
                }
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.md)
            .background(Color.assistantBubble)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.large, style: .continuous))

            Spacer()
        }
        .onReceive(timer) { _ in
            withAnimation(AppAnimation.quick) {
                animatingIndex = (animatingIndex + 1) % 3
            }
        }
    }
}

#Preview("Message List") {
    MessageListView(
        history: [
            .user("Hello, can you help me with this project?"),
            .gemini("""
            Of course! I'd be happy to help.

            ### What I Can Do

            * **Read** and analyze files
            * *Write* new code
            * Run `commands`

            Here's some code:

            ```swift
            func hello() {
                print("Hello!")
            }
            ```
            """),
            .user("I need to create a new feature"),
            .toolGroup([
                ToolCall(
                    callId: "1",
                    name: "read_file",
                    description: "Reading src/main.swift",
                    status: "success",
                    resultDisplay: nil,
                    confirmationDetails: nil,
                    correlationId: nil
                )
            ])
        ],
        pending: [],
        streamingState: .responding,
        isTrustedFolder: false,
        onConfirm: { _, _, _ in }
    )
}
