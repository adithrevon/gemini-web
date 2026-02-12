import SwiftUI

struct ClaudeTaskPanel: View {
    let todos: TodoList?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "checklist")
                    .foregroundStyle(.blue)
                Text("Tasks")
                    .font(.headline)
            }

            if let todos = todos, !todos.items.isEmpty {
                ForEach(todos.items) { task in
                    TaskRowView(task: task)
                }
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "checkmark.circle")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text("No active tasks")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            }
        }
        .padding()
    }
}

struct TaskRowView: View {
    let task: TodoItem

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            statusIcon
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 4) {
                Text(task.subject)
                    .font(.body)
                    .foregroundStyle(task.status == "completed" ? .secondary : .primary)

                if let desc = task.description, !desc.isEmpty {
                    Text(desc)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                // Show blocked status
                if let blockedBy = task.blockedBy, !blockedBy.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "lock.fill")
                            .font(.caption2)
                        Text("Blocked by \(blockedBy.count) task(s)")
                            .font(.caption2)
                    }
                    .foregroundStyle(.orange)
                }
            }

            Spacer()
        }
        .padding(.vertical, 4)
    }

    var statusIcon: some View {
        Group {
            switch task.status {
            case "completed":
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            case "in_progress":
                Image(systemName: "circle.dotted")
                    .foregroundStyle(.blue)
            default: // pending
                Image(systemName: "circle")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.body)
    }
}

// MARK: - Preview

#Preview {
    VStack {
        ClaudeTaskPanel(todos: TodoList(
            items: [
                TodoItem(
                    id: "1",
                    subject: "Implement authentication",
                    description: "Add JWT-based auth with refresh tokens",
                    status: "in_progress",
                    blockedBy: [],
                    blocks: ["2"],
                    createdAt: "2026-02-12T09:00:00Z",
                    completedAt: nil
                ),
                TodoItem(
                    id: "2",
                    subject: "Write tests",
                    description: "Unit tests for auth module",
                    status: "pending",
                    blockedBy: ["1"],
                    blocks: [],
                    createdAt: "2026-02-12T09:30:00Z",
                    completedAt: nil
                ),
                TodoItem(
                    id: "3",
                    subject: "Deploy to staging",
                    description: nil,
                    status: "completed",
                    blockedBy: [],
                    blocks: [],
                    createdAt: "2026-02-12T08:00:00Z",
                    completedAt: "2026-02-12T09:45:00Z"
                )
            ],
            lastUpdated: "2026-02-12T10:00:00Z"
        ))
        .frame(width: 300)

        Divider()

        ClaudeTaskPanel(todos: nil)
            .frame(width: 300)
    }
}
