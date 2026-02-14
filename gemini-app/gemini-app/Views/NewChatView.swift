import SwiftUI

struct NewChatView: View {
    let recentProjects: [String]
    let initialProject: String?
    let composerDisabled: Bool
    let connected: Bool
    let status: InstanceStatus?
    let onProjectSelected: (String, Bool, String) -> Void  // path, yolo, model
    let onSubmitMessage: (String) -> Void
    let onCancel: (() -> Void)?
    let onOpenSettings: () -> Void
    let sessionStore: SessionStore

    @State private var selectedProject: String = ""
    @State private var didSendMessage = false
    @State private var showBrowser = false
    @State private var sudoMode: Bool = false
    @State private var selectedModel: String = ""
    @State private var hasInitialized = false
    @State private var isSudoTransitioning = false
    #if os(iOS)
    @State private var keyboardIsVisible = false
    #endif

    private var isConnecting: Bool {
        status == .connecting
    }

    var body: some View {
        VStack(spacing: 0) {
            // Hero section - scrollable content with keyboard-aware animations
            ScrollView {
                VStack(spacing: keyboardIsVisible ? Spacing.sm : Spacing.lg) {
                    Spacer()
                        .frame(minHeight: keyboardIsVisible ? 10 : 40)

                    // Animated icon (or offline icon) - moves up with keyboard
                    ZStack {
                        if !connected {
                            Image(systemName: "wifi.exclamationmark")
                                .font(.system(size: keyboardIsVisible ? 36 : 48))
                                .foregroundStyle(Color.statusError.gradient)
                        } else if isConnecting {
                            ConnectionAnimationView()
                        } else {
                            Image(systemName: "brain.head.profile")
                                .font(.system(size: keyboardIsVisible ? 36 : 48))
                                .foregroundStyle(Color.accentColor.gradient)
                        }
                    }
                    .frame(height: keyboardIsVisible ? 50 : 80)

                    Text(!connected ? "Server Offline" : (isConnecting ? "Connecting..." : "Let's build"))
                        .font(keyboardIsVisible ? .title2 : .heroTitle)
                        .animation(.easeInOut, value: isConnecting)
                        .animation(.easeInOut, value: connected)

                    if !connected {
                        // Offline message with Settings button
                        VStack(spacing: Spacing.sm) {
                            Text("Cannot connect to backend server")
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                                .multilineTextAlignment(.center)

                            Button(action: onOpenSettings) {
                                HStack(spacing: 6) {
                                    Image(systemName: "gear")
                                        .font(.caption.weight(.medium))
                                    Text("Open Settings")
                                        .font(.caption.weight(.medium))
                                }
                                .padding(.horizontal, Spacing.md)
                                .padding(.vertical, 6)
                                .background(Color.accentColor)
                                .foregroundColor(.white)
                                .cornerRadius(CornerRadius.small)
                            }
                            .buttonStyle(.plain)
                        }
                        .frame(maxWidth: 260)
                    } else {
                        ProjectSelectorView(
                            selectedProject: $selectedProject,
                            recentProjects: recentProjects,
                            disabled: isConnecting || !connected,
                            onSelect: { path in
                                onProjectSelected(path, sudoMode, selectedModel)
                            },
                            onBrowse: {
                                showBrowser = true
                            }
                        )
                        .frame(maxWidth: 400)
                    }

                    Spacer()
                        .frame(minHeight: keyboardIsVisible ? 10 : 40)
                }
                .padding(.horizontal, Spacing.lg)
                .padding(.bottom, keyboardIsVisible ? Spacing.sm : Spacing.lg)
                .animation(.spring(response: 0.3, dampingFraction: 0.8), value: keyboardIsVisible)
            }
            .layoutPriority(1)

            ComposerView(
                disabled: composerDisabled || selectedProject.isEmpty,
                streamingState: .idle,
                maxLines: 6,
                modelSelector: ModelSelectorConfig(
                    currentModel: selectedModel,
                    availableModels: [],
                    disabled: composerDisabled || isConnecting,
                    onSelect: { model in
                        selectedModel = model
                    }
                ),
                planModeActive: false,
                onTogglePlanMode: nil,
                sudoToggle: SudoToggleConfig(
                    isOn: $sudoMode,
                    disabled: !connected || isConnecting,
                    isTransitioning: $isSudoTransitioning,
                    onChange: { _ in
                        // Re-spawn with new sudo mode if project is selected
                        if !selectedProject.isEmpty {
                            onProjectSelected(selectedProject, sudoMode, selectedModel)
                        }
                    }
                ),
                alwaysExpanded: true,
                onSubmit: { text in
                    didSendMessage = true
                    onSubmitMessage(text)
                },
                onInterrupt: nil
            )
        }
        #if os(iOS)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                keyboardIsVisible = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                keyboardIsVisible = false
            }
        }
        #endif
        .onAppear {
            guard !hasInitialized else { return }
            hasInitialized = true
            selectedModel = ""  // Will be populated by backend
            if let initial = initialProject {
                selectedProject = initial
            }
        }
        .onChange(of: initialProject) { _, newValue in
            if let newValue = newValue {
                selectedProject = newValue
            }
        }
        .onDisappear {
            // Terminate instance if navigating away without sending a message
            if !didSendMessage {
                onCancel?()
            }
        }
        .sheet(isPresented: $showBrowser) {
            DirectoryBrowserView(
                isPresented: $showBrowser,
                onSelect: { path in
                    selectedProject = path
                    onProjectSelected(path, sudoMode, selectedModel)
                },
                sessionStore: sessionStore
            )
        }
    }
}

// MARK: - Connection Animation

struct ConnectionAnimationView: View {
    @State private var isAnimating = false
    @State private var rotation: Double = 0

    var body: some View {
        ZStack {
            // Outer pulsing ring
            Circle()
                .stroke(Color.accentColor.opacity(0.3), lineWidth: 2)
                .frame(width: 70, height: 70)
                .scaleEffect(isAnimating ? 1.2 : 0.9)
                .opacity(isAnimating ? 0 : 0.8)

            // Middle rotating ring
            Circle()
                .trim(from: 0, to: 0.7)
                .stroke(
                    AngularGradient(
                        colors: [Color.accentColor, Color.accentColor.opacity(0.3)],
                        center: .center
                    ),
                    style: StrokeStyle(lineWidth: 3, lineCap: .round)
                )
                .frame(width: 55, height: 55)
                .rotationEffect(.degrees(rotation))

            // Inner sparkle icon
            Image(systemName: "sparkles")
                .font(.system(size: 24, weight: .medium))
                .foregroundStyle(Color.accentColor)
                .scaleEffect(isAnimating ? 1.1 : 0.95)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                isAnimating = true
            }
            withAnimation(.linear(duration: 1.5).repeatForever(autoreverses: false)) {
                rotation = 360
            }
        }
    }
}

#Preview {
    @Previewable @State var store = SessionStore()
    NewChatView(
        recentProjects: [
            "/Users/test/my-project",
            "/Users/test/another-project"
        ],
        initialProject: nil,
        composerDisabled: false,
        connected: false,
        status: .connecting,
        onProjectSelected: { _, _, _ in },
        onSubmitMessage: { _ in },
        onCancel: nil,
        onOpenSettings: { },
        sessionStore: store
    )
}
