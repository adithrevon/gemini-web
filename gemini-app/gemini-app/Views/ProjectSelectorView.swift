import SwiftUI

struct ProjectSelectorView: View {
    @Binding var selectedProject: String
    let recentProjects: [String]
    let disabled: Bool
    let onSelect: (String) -> Void
    let onBrowse: () -> Void

    @State private var isExpanded = false

    init(
        selectedProject: Binding<String>,
        recentProjects: [String],
        disabled: Bool,
        onSelect: @escaping (String) -> Void,
        onBrowse: @escaping () -> Void = {}
    ) {
        self._selectedProject = selectedProject
        self.recentProjects = recentProjects
        self.disabled = disabled
        self.onSelect = onSelect
        self.onBrowse = onBrowse
    }

    private var displayName: String {
        if selectedProject.isEmpty {
            return "Select a project..."
        }
        return selectedProject.split(separator: "/").last.map(String.init) ?? selectedProject
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            // Main selector button
            Button {
                withAnimation(AppAnimation.spring) {
                    isExpanded.toggle()
                }
            } label: {
                HStack {
                    Image(systemName: "folder.fill")
                        .foregroundStyle(selectedProject.isEmpty ? .secondary : Color.accentColor)

                    Text(displayName)
                        .foregroundStyle(selectedProject.isEmpty ? .secondary : .primary)

                    Spacer()

                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .padding(.horizontal, Spacing.lg)
                .padding(.vertical, Spacing.md)
                .background(Color.surfaceSecondary)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.medium, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(disabled)

            // Expanded menu
            if isExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    // Browse button
                    Button {
                        onBrowse()
                        withAnimation(AppAnimation.spring) {
                            isExpanded = false
                        }
                    } label: {
                        HStack(spacing: Spacing.sm) {
                            Image(systemName: "folder.badge.gearshape")
                                .font(.subheadline)
                                .foregroundStyle(Color.accentColor)

                            Text("Browse Folders...")
                                .fontWeight(.medium)
                                .foregroundStyle(Color.accentColor)

                            Spacer()

                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, Spacing.md)
                        .padding(.vertical, Spacing.md)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    // Recent projects
                    if !recentProjects.isEmpty {
                        Divider()
                            .padding(.vertical, Spacing.xs)

                        Text("Recent Projects")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, Spacing.md)
                            .padding(.bottom, Spacing.xs)

                        ForEach(recentProjects, id: \.self) { project in
                            Button {
                                selectProject(project)
                            } label: {
                                HStack(spacing: Spacing.sm) {
                                    Image(systemName: "clock.arrow.circlepath")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)

                                    Text(projectDisplayName(project))
                                        .lineLimit(1)

                                    Spacer()

                                    if project == selectedProject {
                                        Image(systemName: "checkmark")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(Color.accentColor)
                                    }
                                }
                                .padding(.horizontal, Spacing.md)
                                .padding(.vertical, Spacing.sm)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            if project != recentProjects.last {
                                Divider()
                                    .padding(.leading, 36)
                            }
                        }
                    }
                }
                .background(Color.surfaceSecondary)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.medium, style: .continuous))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func projectDisplayName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    private func selectProject(_ project: String) {
        selectedProject = project
        onSelect(project)
        withAnimation(AppAnimation.spring) {
            isExpanded = false
        }
    }
}

// MARK: - Directory Browser Sheet

struct DirectoryBrowserView: View {
    @Binding var isPresented: Bool
    let onSelect: (String) -> Void
    let sessionStore: SessionStore

    @State private var navigationPath: [DirectoryListing] = []
    @State private var rootListing: DirectoryListing?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var hasLoadedInitial = false

    private var currentListing: DirectoryListing? {
        navigationPath.last ?? rootListing
    }

    private var canGoBack: Bool {
        !navigationPath.isEmpty
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && currentListing == nil {
                    ProgressView("Loading...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = errorMessage, currentListing == nil {
                    ContentUnavailableView {
                        Label("Error", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") {
                            Task { await loadDirectory(nil, isRoot: true) }
                        }
                    }
                } else if let listing = currentListing {
                    directoryList(listing)
                } else {
                    ProgressView("Loading...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(currentListing?.name ?? "Select Project")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if canGoBack {
                        Button {
                            goBack()
                        } label: {
                            HStack(spacing: Spacing.xxs) {
                                Image(systemName: "chevron.left")
                                    .fontWeight(.semibold)
                                if let parentName = getParentName() {
                                    Text(parentName)
                                        .lineLimit(1)
                                }
                            }
                        }
                    } else {
                        Button("Cancel") {
                            isPresented = false
                        }
                    }
                }
                if isLoading {
                    ToolbarItem(placement: .primaryAction) {
                        ProgressView()
                    }
                }
            }
        }
        .onAppear {
            if !hasLoadedInitial {
                hasLoadedInitial = true
                Task { await loadDirectory(nil, isRoot: true) }
            }
        }
    }

    @ViewBuilder
    private func directoryList(_ listing: DirectoryListing) -> some View {
        List {
            // Current directory info with select button
            Section {
                HStack {
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(listing.name)
                            .font(.headline)
                        Text(listing.path)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }

                    Spacer()

                    Button("Select") {
                        onSelect(listing.path)
                        isPresented = false
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                }
            }

            // Subdirectories
            Section {
                ForEach(listing.directories) { dir in
                    Button {
                        navigateForward(to: dir.path)
                    } label: {
                        HStack(spacing: Spacing.sm) {
                            Image(systemName: "folder.fill")
                                .font(.body)
                                .foregroundStyle(Color.accentColor)
                                .frame(width: 24)

                            Text(dir.name)
                                .foregroundStyle(.primary)
                                .lineLimit(1)

                            Spacer()

                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isLoading)
                }

                if listing.directories.isEmpty {
                    Text("No subdirectories")
                        .foregroundStyle(.secondary)
                        .font(.subheadline)
                }
            } header: {
                Text("Folders")
            }
        }
        .listStyle(.insetGrouped)
    }

    private func getParentName() -> String? {
        if navigationPath.count >= 2 {
            return navigationPath[navigationPath.count - 2].name
        } else if navigationPath.count == 1 {
            return rootListing?.name
        }
        return nil
    }

    private func goBack() {
        guard !navigationPath.isEmpty else { return }
        withAnimation {
            _ = navigationPath.removeLast()
        }
    }

    private func navigateForward(to path: String) {
        Task {
            await loadDirectory(path, isRoot: false)
        }
    }

    private func loadDirectory(_ path: String?, isRoot: Bool) async {
        isLoading = true
        errorMessage = nil

        let result = await sessionStore.browseDirectory(path)

        if let listing = result {
            withAnimation {
                if isRoot {
                    rootListing = listing
                    navigationPath = []
                } else {
                    navigationPath.append(listing)
                }
            }
            errorMessage = nil
        } else {
            if currentListing == nil {
                errorMessage = "Failed to load directory"
            }
        }
        isLoading = false
    }
}

#Preview {
    VStack {
        ProjectSelectorView(
            selectedProject: .constant(""),
            recentProjects: [
                "/Users/test/my-project",
                "/Users/test/another-project",
                "/Users/test/third-project"
            ],
            disabled: false,
            onSelect: { _ in },
            onBrowse: {}
        )
        .padding()

        Spacer()
    }
}
