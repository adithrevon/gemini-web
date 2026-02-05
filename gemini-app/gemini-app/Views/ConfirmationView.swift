import SwiftUI

struct ConfirmationView: View {
    let details: ConfirmationDetails
    let isTrustedFolder: Bool
    let onConfirm: (ConfirmOutcome) -> Void
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Title or prompt
            if let title = details.title {
                Text(title)
                    .font(.subheadline)
                    .fontWeight(.medium)
            } else if let prompt = details.prompt {
                Text(prompt)
                    .font(.subheadline)
            }
            
            // Command preview
            if let command = details.command {
                HStack {
                    Image(systemName: "terminal")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(command)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(2)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            
            // File info
            if let fileName = details.fileName {
                HStack {
                    Image(systemName: "doc")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(fileName)
                        .font(.caption)
                }
            }
            
            // File diff preview
            if let fileDiff = details.fileDiff {
                ScrollView {
                    Text(fileDiff)
                        .font(.system(.caption2, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 100)
                .padding(8)
                .background(Color.primary.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            
            // Action buttons
            HStack(spacing: 8) {
                Button {
                    onConfirm(.cancel)
                } label: {
                    Text("Cancel")
                        .font(.subheadline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.bordered)
                
                Button {
                    onConfirm(.proceed_once)
                } label: {
                    Text("Proceed")
                        .font(.subheadline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                
                if !isTrustedFolder {
                    Button {
                        onConfirm(.proceed_always)
                    } label: {
                        Text("Always")
                            .font(.subheadline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.bordered)
                    .tint(.green)
                }
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.orange.opacity(0.3), lineWidth: 1)
        )
    }
}

#Preview {
    VStack(spacing: 16) {
        ConfirmationView(
            details: ConfirmationDetails(
                type: "exec",
                title: "Run command",
                command: "npm install",
                rootCommand: nil,
                prompt: nil,
                toolDisplayName: nil,
                toolName: nil,
                fileName: nil,
                filePath: nil,
                fileDiff: nil
            ),
            isTrustedFolder: false,
            onConfirm: { _ in }
        )
        
        ConfirmationView(
            details: ConfirmationDetails(
                type: "edit",
                title: "Edit file",
                command: nil,
                rootCommand: nil,
                prompt: nil,
                toolDisplayName: nil,
                toolName: nil,
                fileName: "main.swift",
                filePath: "/src/main.swift",
                fileDiff: """
                + import Foundation
                - import UIKit
                  
                  func main() {
                +     print("Hello")
                  }
                """
            ),
            isTrustedFolder: true,
            onConfirm: { _ in }
        )
    }
    .padding()
}
