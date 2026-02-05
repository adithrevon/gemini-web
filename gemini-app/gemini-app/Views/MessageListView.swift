import SwiftUI

struct MessageListView: View {
    let history: [Message]
    let pending: [Message]
    let streamingState: StreamingState
    let isTrustedFolder: Bool
    let onConfirm: (String, ConfirmOutcome, String?) -> Void
    
    private var allMessages: [Message] {
        history + pending
    }
    
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(allMessages.enumerated()), id: \.offset) { index, message in
                        MessageRowView(
                            message: message,
                            isTrustedFolder: isTrustedFolder,
                            onConfirm: onConfirm
                        )
                        .id(index)
                    }
                    
                    // Typing indicator
                    if streamingState == .responding {
                        TypingIndicatorView()
                            .id("typing")
                    }
                    
                    // Bottom anchor for scrolling
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding()
            }
            .onChange(of: allMessages.count) { _, _ in
                withAnimation {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .onChange(of: streamingState) { _, _ in
                withAnimation {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
    }
}

// MARK: - Message Row

struct MessageRowView: View {
    let message: Message
    let isTrustedFolder: Bool
    let onConfirm: (String, ConfirmOutcome, String?) -> Void
    
    var body: some View {
        switch message {
        case .user(let text):
            UserMessageView(text: text)
        case .gemini(let text), .geminiContent(let text):
            GeminiMessageView(text: text)
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
            Spacer(minLength: 60)
            
            Text(text)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(Color.blue)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 18))
        }
    }
}

// MARK: - Gemini Message

struct GeminiMessageView: View {
    let text: String
    
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Gemini")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(.secondary)
                
                Text(text)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color.secondary.opacity(0.15))
            .clipShape(RoundedRectangle(cornerRadius: 18))
            
            Spacer(minLength: 60)
        }
    }
}

// MARK: - Typing Indicator

struct TypingIndicatorView: View {
    @State private var phase = 0.0
    
    var body: some View {
        HStack {
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Color.secondary)
                        .frame(width: 8, height: 8)
                        .scaleEffect(dotScale(for: index))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(Color.secondary.opacity(0.15))
            .clipShape(RoundedRectangle(cornerRadius: 18))
            
            Spacer()
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.6).repeatForever()) {
                phase = 1
            }
        }
    }
    
    private func dotScale(for index: Int) -> CGFloat {
        let offset = Double(index) * 0.3
        let value = sin((phase + offset) * .pi)
        return 0.6 + 0.4 * value
    }
}

#Preview("Message List") {
    MessageListView(
        history: [
            .user("Hello, can you help me with this project?"),
            .gemini("Of course! I'd be happy to help. What would you like to accomplish?"),
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
