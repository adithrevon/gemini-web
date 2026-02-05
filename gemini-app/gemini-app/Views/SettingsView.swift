import SwiftUI

struct SettingsView: View {
    @State private var serverURL: String = SessionService.defaultServerURL
    @State private var urlHistory: [String] = SessionService.serverURLHistory
    @State private var showAddURL = false
    @State private var newURL = ""
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // URL picker from history
                    ForEach(urlHistory, id: \.self) { url in
                        Button {
                            serverURL = url
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(URL(string: url)?.host ?? url)
                                        .foregroundStyle(.primary)
                                    if let port = URL(string: url)?.port {
                                        Text("Port \(port)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if url == serverURL {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.blue)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    .onDelete { indexSet in
                        urlHistory.remove(atOffsets: indexSet)
                        SessionService.serverURLHistory = urlHistory
                    }
                    
                    // Add new URL button
                    Button {
                        showAddURL = true
                    } label: {
                        Label("Add Server", systemImage: "plus.circle")
                    }
                } header: {
                    Text("Server")
                } footer: {
                    Text("Select a server or add a new one. Swipe to delete.")
                }
                
                Section {
                    // Manual URL text field
                    TextField("Server URL", text: $serverURL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                } header: {
                    Text("Current URL")
                } footer: {
                    Text("e.g., http://192.168.1.200:7337")
                }
                
                Section {
                    Button("Reset to Default") {
                        serverURL = "http://127.0.0.1:7337"
                    }
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
                        SessionService.defaultServerURL = serverURL
                        dismiss()
                    }
                }
            }
            .alert("Add Server", isPresented: $showAddURL) {
                TextField("http://host:7337", text: $newURL)
                    #if os(iOS)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    #endif
                Button("Cancel", role: .cancel) {
                    newURL = ""
                }
                Button("Add") {
                    if !newURL.isEmpty {
                        // Ensure URL has scheme
                        var urlToAdd = newURL
                        if !urlToAdd.hasPrefix("http://") && !urlToAdd.hasPrefix("https://") {
                            urlToAdd = "http://" + urlToAdd
                        }
                        SessionService.addToServerURLHistory(urlToAdd)
                        urlHistory = SessionService.serverURLHistory
                        serverURL = urlToAdd
                        newURL = ""
                    }
                }
            } message: {
                Text("Enter the server URL (e.g., http://192.168.1.100:7337)")
            }
        }
        .onAppear {
            serverURL = SessionService.defaultServerURL
            urlHistory = SessionService.serverURLHistory
        }
    }
}

#Preview {
    SettingsView()
}
