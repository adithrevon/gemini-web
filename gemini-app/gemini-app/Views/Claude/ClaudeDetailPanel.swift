import SwiftUI

struct ClaudeDetailPanel: View {
    let instance: InstanceState

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ClaudeTaskPanel(todos: instance.todos)

                Divider()
                    .padding(.vertical, 8)

                ClaudeUsageLimitsView(instanceId: instance.id)
            }
        }
    }
}

// Preview removed - add files to Xcode project to enable
