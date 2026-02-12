import SwiftUI

struct ClaudeUsageLimitsView: View {
    let instanceId: String

    @State private var limits: UsageLimits?
    @State private var isLoading = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "chart.bar.fill")
                    .foregroundStyle(.blue)
                Text("Usage Limits")
                    .font(.headline)
            }

            if isLoading && limits == nil {
                HStack {
                    ProgressView()
                        .scaleEffect(0.8)
                    Text("Loading...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if let error = error {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                        .font(.caption)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.vertical, 8)
            } else if let limits = limits {
                UsageLimitRow(
                    title: "5 Hour",
                    utilization: limits.fiveHour.utilization,
                    resetsAt: limits.fiveHour.resetsAt
                )

                UsageLimitRow(
                    title: "7 Day",
                    utilization: limits.sevenDay.utilization,
                    resetsAt: limits.sevenDay.resetsAt
                )
            }
        }
        .padding()
        .task(id: instanceId) {
            await fetchClaudeUsageLimits()
        }
    }

    func fetchClaudeUsageLimits() async {
        isLoading = true
        error = nil

        defer { isLoading = false }

        let baseURL = SessionService.defaultServerURL
        guard let url = URL(string: "\(baseURL)/api/usage-limits") else {
            error = "Invalid URL"
            return
        }

        do {
            let (data, response) = try await URLSession.shared.data(from: url)

            if let httpResponse = response as? HTTPURLResponse {
                print("Usage limits response status: \(httpResponse.statusCode)")
                if httpResponse.statusCode == 503 {
                    error = "API key not configured"
                    return
                } else if httpResponse.statusCode != 200 {
                    error = "Server error (\(httpResponse.statusCode))"
                    return
                }
            }

            // Log the raw response
            if let responseStr = String(data: data, encoding: .utf8) {
                print("Usage limits raw response: \(responseStr.prefix(200))...")
            }

            let decoder = JSONDecoder()
            do {
                limits = try decoder.decode(UsageLimits.self, from: data)
                print("Successfully decoded usage limits: 5h=\(limits?.fiveHour.utilization ?? 0)%, 7d=\(limits?.sevenDay.utilization ?? 0)%")
            } catch {
                print("Decoding error: \(error)")
                if let decodingError = error as? DecodingError {
                    switch decodingError {
                    case .keyNotFound(let key, let context):
                        print("Missing key: \(key.stringValue), context: \(context.debugDescription)")
                    case .typeMismatch(let type, let context):
                        print("Type mismatch: \(type), context: \(context.debugDescription)")
                    case .valueNotFound(let type, let context):
                        print("Value not found: \(type), context: \(context.debugDescription)")
                    case .dataCorrupted(let context):
                        print("Data corrupted: \(context.debugDescription)")
                    @unknown default:
                        print("Unknown decoding error")
                    }
                }
                throw error
            }

            // Poll every 60 seconds
            try await Task.sleep(for: .seconds(60))
            if !Task.isCancelled {
                await fetchClaudeUsageLimits()
            }
        } catch is CancellationError {
            // Task was cancelled, don't set error
        } catch {
            self.error = "Failed to load"
            print("Failed to fetch usage limits: \(error)")
        }
    }
}

struct UsageLimitRow: View {
    let title: String
    let utilization: Double
    let resetsAt: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                    .font(.caption)
                Spacer()
                Text("\(Int(utilization))%")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(progressColor)
            }

            ProgressView(value: utilization / 100.0)
                .tint(progressColor)
                .frame(height: 6)

            if let resetDate = parseDate(resetsAt) {
                Text("Resets \(resetDate, style: .relative)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    var progressColor: Color {
        if utilization > 90 {
            return .red
        } else if utilization > 70 {
            return .orange
        } else {
            return .blue
        }
    }

    func parseDate(_ iso8601: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: iso8601)
    }
}

// MARK: - Preview

#Preview {
    ClaudeUsageLimitsView(instanceId: "test-instance")
        .frame(width: 300, height: 400)
}
