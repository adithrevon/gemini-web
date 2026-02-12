import SwiftUI

struct ClaudePlanModeToggle: View {
    @Binding var isActive: Bool

    var body: some View {
        Button {
            isActive.toggle()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isActive ? "doc.text.fill.badge.checkmark" : "doc.text.magnifyingglass")
                    .font(.caption)
                    .imageScale(.small)
                Text("Plan")
                    .font(.caption)
                    .fontWeight(.medium)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(isActive ? Color.blue : Color.secondary.opacity(0.15))
            )
            .foregroundStyle(isActive ? .white : .primary)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Preview

#Preview {
    VStack(spacing: 20) {
        ClaudePlanModeToggle(isActive: .constant(false))
        ClaudePlanModeToggle(isActive: .constant(true))
    }
    .padding()
}
