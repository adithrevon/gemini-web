import SwiftUI

struct NewChatView: View {
    let recentProjects: [String]
    let initialProject: String?
    let initialProvider: Provider
    let composerDisabled: Bool
    let status: InstanceStatus?
    let onProjectSelected: (String, Provider, Bool, String) -> Void  // path, provider, yolo, model
    let onSubmitMessage: (String) -> Void
    let onCancel: (() -> Void)?
    let sessionStore: SessionStore

    @State private var selectedProject: String = ""
    @State private var didSendMessage = false
    @State private var showBrowser = false
    @State private var selectedProvider: Provider = .gemini
    @State private var sudoMode: Bool = false
    @State private var selectedModel: String = Provider.gemini.defaultModel
    @State private var hasInitialized = false

    private var isConnecting: Bool {
        status == .connecting
    }

    var body: some View {
        VStack(spacing: 0) {
            // Hero section - centered in available space
            VStack(spacing: Spacing.lg) {
                Spacer()

                // Animated icon
                ZStack {
                    if isConnecting {
                        ConnectionAnimationView()
                    } else {
                        Image(systemName: selectedProvider.icon)
                            .font(.system(size: 48))
                            .foregroundStyle(Color.accentColor.gradient)
                    }
                }
                .frame(height: 80)

                Text(isConnecting ? "Connecting..." : "Let's build")
                    .font(.heroTitle)
                    .animation(.easeInOut, value: isConnecting)

                // Provider picker
                Picker("Provider", selection: $selectedProvider) {
                    ForEach(Provider.allCases, id: \.self) { provider in
                        Label(provider.displayName, systemImage: provider.icon)
                            .tag(provider)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 260)
                .onChange(of: selectedProvider) { _, newProvider in
                    // Update model to provider default
                    selectedModel = newProvider.defaultModel
                    // When provider changes and a project is already selected,
                    // re-spawn with the new provider
                    if !selectedProject.isEmpty {
                        onProjectSelected(selectedProject, newProvider, sudoMode, selectedModel)
                    }
                }

                Toggle(isOn: $sudoMode) {
                    Label("Sudo", systemImage: "bolt.shield")
                        .font(.subheadline)
                }
                .toggleStyle(.switch)
                .frame(maxWidth: 260)

                ModelSelectorView(
                    currentModel: selectedModel,
                    availableModels: selectedProvider.defaultModels,
                    disabled: isConnecting,
                    onSelect: { model in
                        selectedModel = model
                    }
                )

                ProjectSelectorView(
                    selectedProject: $selectedProject,
                    recentProjects: recentProjects,
                    disabled: isConnecting,
                    onSelect: { path in
                        onProjectSelected(path, selectedProvider, sudoMode, selectedModel)
                    },
                    onBrowse: {
                        showBrowser = true
                    }
                )
                .frame(maxWidth: 400)

                Spacer()
            }
            .padding(.horizontal, Spacing.lg)

            // ComposerView at bottom - same as existing conversation
            ComposerView(
                disabled: composerDisabled || selectedProject.isEmpty,
                streamingState: .idle,
                onSubmit: { text in
                    didSendMessage = true
                    onSubmitMessage(text)
                },
                onInterrupt: nil
            )
        }
        .onAppear {
            guard !hasInitialized else { return }
            hasInitialized = true
            selectedProvider = initialProvider
            selectedModel = initialProvider.defaultModel
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
                    onProjectSelected(path, selectedProvider, sudoMode, selectedModel)
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
        initialProvider: .gemini,
        composerDisabled: false,
        status: .connecting,
        onProjectSelected: { _, _, _, _ in },
        onSubmitMessage: { _ in },
        onCancel: nil,
        sessionStore: store
    )
}
