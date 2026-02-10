import SwiftUI

/// Large offline banner for sidebar - shows server offline status with Settings button
struct OfflineBannerView: View {
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                Image(systemName: "wifi.exclamationmark")
                    .font(.body.weight(.semibold))
                    .foregroundColor(.statusError)

                Text("Server Offline")
                    .font(.body.weight(.semibold))
                    .foregroundColor(.primary)

                Spacer()
            }

            Text("Cannot connect to backend server. Check your server configuration in Settings.")
                .font(.caption)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

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
        .padding(Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: CornerRadius.medium)
                .fill(Color.statusError.opacity(0.1))
        )
        .overlay(
            RoundedRectangle(cornerRadius: CornerRadius.medium)
                .stroke(Color.statusError.opacity(0.3), lineWidth: 1)
        )
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
    }
}

/// Slim connection status banner for conversation view - shows reconnecting state with retry button
struct ConnectionStatusBanner: View {
    let onRetry: () -> Void
    let onOpenSettings: () -> Void
    @State private var isRetrying = false

    var body: some View {
        HStack(spacing: Spacing.md) {
            // Pulsing icon
            Image(systemName: "wifi.exclamationmark")
                .font(.body)
                .foregroundColor(.statusConnecting)
                .opacity(isRetrying ? 0.5 : 1.0)
                .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true), value: isRetrying)

            VStack(alignment: .leading, spacing: 2) {
                Text(isRetrying ? "Reconnecting..." : "Server Offline")
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(.primary)

                Text("Cannot connect to backend server")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer()

            // Retry button
            Button(action: {
                guard !isRetrying else { return }
                isRetrying = true
                onRetry()

                // Reset after 2 seconds to prevent spam
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                    isRetrying = false
                }
            }) {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption.weight(.medium))
                    Text("Retry")
                        .font(.caption.weight(.medium))
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(isRetrying ? Color.secondary.opacity(0.2) : Color.accentColor.opacity(0.2))
                .foregroundColor(isRetrying ? .secondary : .accentColor)
                .cornerRadius(CornerRadius.small)
            }
            .buttonStyle(.plain)
            .disabled(isRetrying)

            // Settings button
            Button(action: onOpenSettings) {
                Image(systemName: "gear")
                    .font(.body)
                    .foregroundColor(.secondary)
                    .padding(4)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
        .background(Color.statusConnecting.opacity(0.1))
        .overlay(
            Rectangle()
                .frame(height: 1)
                .foregroundColor(Color.statusConnecting.opacity(0.3)),
            alignment: .bottom
        )
    }
}

#Preview("Offline Banner") {
    OfflineBannerView(onOpenSettings: {})
        .padding()
}

#Preview("Connection Status Banner") {
    ConnectionStatusBanner(onRetry: {}, onOpenSettings: {})
}
