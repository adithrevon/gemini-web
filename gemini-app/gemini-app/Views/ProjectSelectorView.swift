import SwiftUI

struct ProjectSelectorView: View {
    @Binding var selectedProject: String
    let recentProjects: [String]
    let disabled: Bool
    let onSelect: (String) -> Void
    
    @State private var isExpanded = false
    @State private var customPath = ""
    @State private var showCustomInput = false
    
    private var displayName: String {
        if selectedProject.isEmpty {
            return "Select a project..."
        }
        return selectedProject.split(separator: "/").last.map(String.init) ?? selectedProject
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Main selector button
            Button {
                withAnimation(.spring(response: 0.3)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack {
                    Image(systemName: "folder")
                        .foregroundStyle(.secondary)
                    
                    Text(displayName)
                        .foregroundStyle(selectedProject.isEmpty ? .secondary : .primary)
                    
                    Spacer()
                    
                    Image(systemName: "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(Color.secondary.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            
            // Expanded menu
            if isExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    // Recent projects
                    if !recentProjects.isEmpty {
                        Text("Recent Projects")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 12)
                            .padding(.top, 8)
                            .padding(.bottom, 4)
                        
                        ForEach(recentProjects, id: \.self) { project in
                            Button {
                                selectProject(project)
                            } label: {
                                HStack {
                                    Image(systemName: "clock.arrow.circlepath")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    
                                    Text(projectDisplayName(project))
                                        .lineLimit(1)
                                    
                                    Spacer()
                                    
                                    if project == selectedProject {
                                        Image(systemName: "checkmark")
                                            .font(.caption)
                                            .foregroundStyle(.blue)
                                    }
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            
                            if project != recentProjects.last {
                                Divider()
                                    .padding(.leading, 36)
                            }
                        }
                    }
                    
                    Divider()
                        .padding(.vertical, 4)
                    
                    // Custom path input
                    Button {
                        showCustomInput = true
                    } label: {
                        HStack {
                            Image(systemName: "folder.badge.plus")
                                .font(.caption)
                                .foregroundStyle(.blue)
                            
                            Text("Enter path manually...")
                                .foregroundStyle(.blue)
                            
                            Spacer()
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                    }
                    .buttonStyle(.plain)
                }
                .background(Color.secondary.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .alert("Enter Project Path", isPresented: $showCustomInput) {
            TextField("/path/to/project", text: $customPath)
            Button("Cancel", role: .cancel) {
                customPath = ""
            }
            Button("Open") {
                if !customPath.isEmpty {
                    selectProject(customPath)
                    customPath = ""
                }
            }
        }
    }
    
    private func projectDisplayName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
    
    private func selectProject(_ project: String) {
        selectedProject = project
        onSelect(project)
        withAnimation(.spring(response: 0.3)) {
            isExpanded = false
        }
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
            onSelect: { _ in }
        )
        .padding()
        
        Spacer()
    }
}
