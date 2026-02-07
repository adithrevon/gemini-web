# Gemini Web Fork - Architecture Overview

This repository is a **fork of the Google Gemini CLI**. We have added two new
packages to extend the CLI with a backend API and native iOS interface.

## New Packages

| Package    | Location        | Purpose                                                                       |
| ---------- | --------------- | ----------------------------------------------------------------------------- |
| gemini-web | `packages/web/` | Backend API server (HTTP + WebSocket) for spawning and managing CLI instances |
| gemini-app | `./gemini-app/` | Native iOS/macOS client app                                                   |

---

## Package: gemini-web (`packages/web/`)

A Node.js backend server that spawns and controls CLI instances. The iOS app
connects to this server.

### Architecture

**Backend (Node.js HTTP + WebSocket):**

- `server.mjs` - HTTP/WebSocket server with:
  - Session management (create/resume sessions)
  - SSE event streaming to clients
  - CLI instance spawning via node-pty (fallback to child_process)
  - WebSocket relay for CLI communication (path: `/ws`)

### API Endpoints

| Endpoint                           | Method | Purpose                                                     |
| ---------------------------------- | ------ | ----------------------------------------------------------- |
| `/api/session`                     | POST   | Create/retrieve session                                     |
| `/api/session/{sessionId}/events`  | GET    | Server-Sent Events stream                                   |
| `/api/session/{sessionId}/command` | POST   | Send commands (spawn, terminate, submit, confirm, setModel) |

### Communication Flow

1. iOS app calls `/api/session` to get sessionId
2. Connects to SSE `/api/session/{sessionId}/events` for real-time updates
3. Sends `spawnInstance` command with projectPath
4. CLI connects via `/ws` and streams state updates
5. User input sent as `submit` messages
6. Tool confirmations displayed, user sends `confirm` messages

### Running the Server

```bash
cd packages/web
npm start          # Start server on port 7337
npm run start:debug  # Start with debug logging
```

### Environment Variables

| Variable                      | Default | Purpose                  |
| ----------------------------- | ------- | ------------------------ |
| `GEMINI_WEB_PORT`             | 7337    | Server port              |
| `GEMINI_WEB_WS_PATH`          | /ws     | WebSocket path           |
| `GEMINI_WEB_DEBUG`            | false   | Enable debug logging     |
| `GEMINI_WEB_CLI_LOG`          | false   | Log CLI output to stdout |
| `GEMINI_WEB_SPAWN_TIMEOUT_MS` | 18000   | CLI spawn timeout        |

---

## Package: gemini-app (`./gemini-app/`)

A native iOS/macOS SwiftUI client for interacting with Gemini through the
backend server.

### Architecture

```
UI Layer (SwiftUI Views)
    ↓
State Management (SessionStore - @Observable)
    ↓
Service Layer (SessionService, SSEClient)
    ↓
Backend Server (HTTP + SSE at port 7337)
```

### Key Components

**Core:**

- `SessionStore.swift` - Central state container (@Observable, @MainActor)
- `SessionService.swift` - HTTP + SSE client with reconnection logic
- `SSEClient.swift` - Server-Sent Events streaming client
- `GeminiModels.swift` - Data models (Message, InstanceState, Status types)

**Views:** | View | Purpose | |------|---------| | `ContentView.swift` | Main
router - adaptive layout for iPhone/iPad/Mac | | `SidebarView.swift` | Chat
instances list grouped by project | | `ComposerView.swift` | Message input with
voice recording, model selector | | `MessageListView.swift` | Chat history with
auto-scroll | | `ConfirmationView.swift` | Tool confirmation dialogs | |
`ToolGroupView.swift` | Tool execution results, file diffs | |
`NewChatView.swift` | Project selector for new chats | | `SettingsView.swift` |
App configuration |

**Design:**

- `DesignSystem.swift` - Centralized design tokens, colors, typography, view
  modifiers

### Features

- Multi-instance support (multiple concurrent chat sessions)
- Real-time streaming via Server-Sent Events
- Voice input with Speech Recognition
- Model selection per session
- Tool confirmation UI
- Cross-platform (iPhone, iPad, macOS)

### Default Server

Connects to `http://127.0.0.1:7337` (configurable in settings)

---

## Original Gemini CLI

The fork includes all original Gemini CLI packages:

| Package                         | Purpose                               |
| ------------------------------- | ------------------------------------- |
| `@google/gemini-cli`            | Terminal CLI entry point              |
| `@google/gemini-cli-core`       | Core business logic, AI models, tools |
| `@google/gemini-cli-a2a-server` | Agent-to-agent server                 |
| `packages/vscode-ide-companion` | VS Code extension                     |
| `@google/gemini-cli-test-utils` | Testing utilities                     |

---

## Integration Point

The backend adds a `WebBridge.tsx` component to the CLI core that:

- Renders invisible (`null`) in terminal
- Streams state updates over WebSocket
- Enables remote control of CLI instances from the iOS app
