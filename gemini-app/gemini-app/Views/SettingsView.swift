import SwiftUI

struct SettingsView: View {
    let onServerChanged: () -> Void

    @State private var serverURL: String = SessionService.defaultServerURL
    @State private var urlHistory: [String] = SessionService.serverURLHistory
    @State private var newURL = ""
    @State private var isAddingServer = false
    @State private var showCopied = false
    @State private var isValidating = false
    @State private var validationError: String?
    @State private var validatingURL: String?
    @State private var showDeleteConfirmation = false
    @State private var urlToDelete: String?
    @FocusState private var isURLFocused: Bool
    @Environment(\.dismiss) private var dismiss

    private var hasServerChanged: Bool {
        serverURL != SessionService.defaultServerURL
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // URL picker from history
                    ForEach(urlHistory, id: \.self) { url in
                        serverRow(for: url)
                    }
                    .onDelete { indexSet in
                        deleteServers(at: indexSet)
                    }

                    // Add new server - inline
                    if isAddingServer {
                        addServerInputRow
                    } else {
                        addServerButton
                    }
                } header: {
                    Text("Server")
                } footer: {
                    if let error = validationError {
                        Text(error)
                            .foregroundStyle(Color.statusError)
                    } else {
                        Text("Select a server or add a new one. Swipe or long-press to delete.")
                    }
                }

                Section {
                    Button("Reset to Default") {
                        serverURL = AppConstants.defaultServerURL
                        if !urlHistory.contains(serverURL) {
                            urlHistory.insert(serverURL, at: 0)
                            SessionService.serverURLHistory = urlHistory
                        }
                    }
                    .foregroundStyle(Color.accentColor)
                }
            }
            .navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saveAndDismiss()
                    }
                    .fontWeight(.semibold)
                    .disabled(isValidating)
                }
            }
            .confirmationDialog(
                "Delete Server",
                isPresented: $showDeleteConfirmation,
                presenting: urlToDelete
            ) { url in
                Button("Delete", role: .destructive) {
                    deleteServer(url)
                }
                Button("Cancel", role: .cancel) {
                    urlToDelete = nil
                }
            } message: { url in
                Text("Are you sure you want to remove \(URL(string: url)?.host ?? url)?")
            }
        }
        .onAppear {
            serverURL = SessionService.defaultServerURL
            urlHistory = SessionService.serverURLHistory
        }
    }

    // MARK: - Server Row

    @ViewBuilder
    private func serverRow(for url: String) -> some View {
        HStack {
            Button {
                selectServer(url)
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(URL(string: url)?.host ?? url)
                            .foregroundStyle(.primary)
                        if let port = URL(string: url)?.port {
                            Text("Port \(String(port))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()

                    if validatingURL == url && isValidating {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else if url == serverURL {
                        Image(systemName: "checkmark")
                            .foregroundStyle(Color.accentColor)
                            .fontWeight(.semibold)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(isValidating)

            // Copy button for selected URL
            if url == serverURL && !isValidating {
                Button {
                    copyURL(url)
                } label: {
                    Image(systemName: showCopied ? "checkmark" : "doc.on.doc")
                        .font(.caption)
                        .foregroundStyle(showCopied ? Color.statusConnected : .secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .contextMenu {
            Button(role: .destructive) {
                urlToDelete = url
                showDeleteConfirmation = true
            } label: {
                Label("Delete Server", systemImage: "trash")
            }

            Button {
                copyURL(url)
            } label: {
                Label("Copy URL", systemImage: "doc.on.doc")
            }
        }
    }

    // MARK: - Add Server Views

    @ViewBuilder
    private var addServerInputRow: some View {
        HStack(spacing: Spacing.sm) {
            TextField("http://host:7337", text: $newURL)
                .textFieldStyle(.plain)
                .textContentType(.URL)
                .autocorrectionDisabled()
                #if os(iOS)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                #endif
                .focused($isURLFocused)
                .onSubmit {
                    submitNewURL()
                }
                .disabled(isValidating)

            if isValidating && validatingURL == nil {
                ProgressView()
                    .scaleEffect(0.8)
            } else if !newURL.isEmpty {
                Button {
                    submitNewURL()
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)
                .disabled(isValidating)
            }

            Button {
                isAddingServer = false
                newURL = ""
                validationError = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var addServerButton: some View {
        Button {
            isAddingServer = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                isURLFocused = true
            }
        } label: {
            Label("Add Server", systemImage: "plus.circle.fill")
                .foregroundStyle(Color.accentColor)
        }
    }

    // MARK: - Actions

    private func selectServer(_ url: String) {
        guard url != serverURL else { return }

        validationError = nil
        validatingURL = url
        isValidating = true

        Task {
            let result = await SessionService.validateServer(url)

            await MainActor.run {
                isValidating = false
                validatingURL = nil

                switch result {
                case .success:
                    serverURL = url
                    validationError = nil
                case .failure(let error):
                    validationError = "Cannot connect to \(URL(string: url)?.host ?? url): \(error.localizedDescription)"
                }
            }
        }
    }

    private func submitNewURL() {
        let trimmed = newURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Ensure URL has scheme
        var urlToAdd = trimmed
        if !urlToAdd.hasPrefix("http://") && !urlToAdd.hasPrefix("https://") {
            urlToAdd = "http://" + urlToAdd
        }

        validationError = nil
        validatingURL = nil
        isValidating = true

        Task {
            let result = await SessionService.validateServer(urlToAdd)

            await MainActor.run {
                isValidating = false

                switch result {
                case .success:
                    SessionService.addToServerURLHistory(urlToAdd)
                    urlHistory = SessionService.serverURLHistory
                    serverURL = urlToAdd
                    newURL = ""
                    isAddingServer = false
                    validationError = nil
                case .failure(let error):
                    validationError = "Cannot connect: \(error.localizedDescription)"
                }
            }
        }
    }

    private func saveAndDismiss() {
        let serverChanged = hasServerChanged
        SessionService.defaultServerURL = serverURL
        dismiss()

        if serverChanged {
            onServerChanged()
        }
    }

    private func copyURL(_ url: String) {
        #if os(iOS)
        UIPasteboard.general.string = url
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url, forType: .string)
        #endif
        withAnimation {
            showCopied = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            withAnimation {
                showCopied = false
            }
        }
    }

    private func deleteServers(at indexSet: IndexSet) {
        urlHistory.remove(atOffsets: indexSet)
        SessionService.serverURLHistory = urlHistory

        // If deleted URL was selected, select first available
        if !urlHistory.contains(serverURL), let first = urlHistory.first {
            serverURL = first
        }
    }

    private func deleteServer(_ url: String) {
        guard let index = urlHistory.firstIndex(of: url) else { return }
        urlHistory.remove(at: index)
        SessionService.serverURLHistory = urlHistory

        // If deleted URL was selected, select first available
        if serverURL == url, let first = urlHistory.first {
            serverURL = first
        }

        urlToDelete = nil
    }
}

#Preview {
    SettingsView(onServerChanged: {})
}
