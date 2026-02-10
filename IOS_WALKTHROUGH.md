# iOS App Walkthrough

## Overview

The iOS app (`gemini-app/`) is a native SwiftUI chat client that connects to a
backend server (`packages/web/server.mjs`). It supports two AI providers (Gemini
and Claude) and includes on-device speech recognition via a local Swift package
(`SpeechRecognitionKit/`).

```
gemini-app/          → SwiftUI iOS client
SpeechRecognitionKit/ → Local SPM package for on-device ASR
packages/web/        → Node.js backend (HTTP + SSE + WebSocket)
```

## Architecture

```
iOS App (SwiftUI)
    ↓ HTTP POST (commands) + SSE (events)
Backend Server (packages/web/server.mjs, port 7337)
    ↓ WebSocket / SDK
Gemini CLI instances  or  Claude Agent SDK
```

The app uses SSE (Server-Sent Events) for real-time streaming from the server
and HTTP POST for sending commands. There are no WebSockets in the app—the
backend handles WebSocket connections to Gemini CLI.

## Build & Deploy

```bash
# Build
cd gemini-app
xcodebuild -scheme gemini-app \
  -destination 'id=00008130-00045D8434E0001C' \
  -configuration Debug build

# Install to device
xcrun devicectl device install app \
  --device 00008130-00045D8434E0001C \
  ~/Library/Developer/Xcode/DerivedData/gemini-app-cqhbwsmyhoyrffdkocuwhppwfawj/Build/Products/Debug-iphoneos/gemini-app.app

# Launch on device
xcrun devicectl device process launch \
  --device 00008130-00045D8434E0001C com.prem.gemini-app
```

**Important**: Always build from the `gemini-app/` directory. The Xcode project
has a local SPM dependency on `../SpeechRecognitionKit`.

## File Map

### App Core

| File                   | Purpose                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini_appApp.swift`  | App entry point. Creates `ContentView` in a `WindowGroup`.                                                                                                                                               |
| `ContentView.swift`    | Root navigation. Manages sidebar ↔ detail split view. Handles instance spawning, project selection, and chat routing. Has separate iPhone (NavigationStack) and iPad/Mac (NavigationSplitView) layouts. |
| `SessionStore.swift`   | App state store (`@Observable`). Holds all `InstanceState` objects, connection status, active instance ID, recent projects. Delegates to `SessionService` for network.                                   |
| `SessionService.swift` | Network layer. Manages SSE connection, HTTP commands, session persistence. All server communication flows through here.                                                                                  |
| `SSEClient.swift`      | Low-level SSE client using `URLSession`. Parses `data:` lines from the event stream.                                                                                                                     |
| `GeminiModels.swift`   | All data models and message types. See "Data Model" section below.                                                                                                                                       |
| `DesignSystem.swift`   | Design tokens: `AppConstants`, `Spacing`, `CornerRadius`, semantic `Color` extensions, `AppAnimation`.                                                                                                   |

### Views

| File                        | Purpose                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ComposerView.swift`        | Message input bar with text field, send button, mic button for voice input. Uses `SpeechRecognitionService` from SpeechRecognitionKit for on-device transcription. Also contains `ModelSelectorView` and `StatusIndicatorView`. |
| `MessageListView.swift`     | Scrollable chat message list. Renders user messages, assistant messages, and tool call groups. Auto-scrolls to bottom on new messages.                                                                                          |
| `ConfirmationView.swift`    | Tool confirmation dialog. Shows when the AI wants to run a tool (file edit, bash command, etc.) and needs user approval. Supports proceed once, proceed always, and cancel.                                                     |
| `NewChatView.swift`         | New chat creation screen. Project browser with directory listing, provider picker (Gemini/Claude), model selector, and YOLO mode toggle.                                                                                        |
| `SidebarView.swift`         | Navigation sidebar. Lists active chat instances grouped by project. Shows status indicators. Supports new chat, terminate, and project-based grouping.                                                                          |
| `SettingsView.swift`        | Server URL configuration with validation.                                                                                                                                                                                       |
| `ProjectSelectorView.swift` | Directory browser for selecting a project folder on the server.                                                                                                                                                                 |
| `ToolGroupView.swift`       | Renders a group of tool calls with expandable results (file diffs, bash output, todos).                                                                                                                                         |

## Data Model (`GeminiModels.swift`)

### Key Types

- **`Provider`** — `.gemini` or `.claude`. Each has its own default models.
- **`InstanceState`** — Full state for one chat instance: messages, streaming
  state, model, project path, provider.
- **`StreamingState`** — `.idle`, `.responding`, `.tool`,
  `.waiting_for_confirmation`
- **`InstanceStatus`** — `.connecting`, `.connected`, `.disconnected`, `.error`
- **`Message`** — Enum: `.user(String)`, `.gemini(String)`,
  `.geminiContent(String)`, `.toolGroup([ToolCall])`
- **`ToolCall`** — A tool invocation with `callId`, `name`, `status`,
  `resultDisplay`, `confirmationDetails`
- **`OutgoingMessage`** — Commands sent to server: `.submit`, `.confirm`,
  `.setModel`, `.spawnInstance`, `.terminateInstance`, `.interrupt`
- **`IncomingMessage`** — Events from server: `.sessionState`, `.bridgeUpdate`,
  `.cliStatus`, `.instanceList`, `.bridgeError`

### Server Communication Protocol

**Commands (HTTP POST to `/api/session/{id}/command`):**

```json
{"type": "submit", "instanceId": "...", "text": "hello"}
{"type": "spawnInstance", "projectPath": "/path", "provider": "gemini", "yolo": false}
{"type": "confirm", "instanceId": "...", "callId": "...", "outcome": "proceed_once"}
{"type": "interrupt", "instanceId": "..."}
```

**Events (SSE from `/api/session/{id}/events`):**

- `session_state` — Full state snapshot on connect (all instances + their
  message history)
- `bridge:update` — Incremental update to an instance (new messages, streaming
  state change)
- `bridge:cli-status` — Instance connection status change
- `bridge:error` — Error from an instance

## SpeechRecognitionKit

Local Swift Package at `SpeechRecognitionKit/` providing on-device speech
recognition using NVIDIA's Parakeet TDT 0.6B CoreML model via
[FluidAudio](https://github.com/FluidInference/FluidAudio).

### Package Structure

```
SpeechRecognitionKit/
├── Package.swift                    # SPM manifest, depends on FluidAudio ≥0.7.9
└── Sources/SpeechRecognitionKit/
    ├── SpeechRecognitionService.swift  # Main public API
    ├── ModelManager.swift              # Shared App Group model storage
    └── Resources/PrivacyInfo.xcprivacy
```

### Key Classes

**`SpeechRecognitionService`** (`@MainActor`, `ObservableObject`)

- Drop-in replacement for Apple's `SFSpeechRecognizer`
- Published properties: `transcript`, `isAvailable`, `isModelLoaded`,
  `isModelLoading`
- Methods: `preloadModel()`, `requestAuthorization(completion:)`,
  `startTranscribing()`, `stopTranscribing()`
- `preloadModel()` is called on `.onAppear` in `ComposerView` to compile CoreML
  models in the background (~10s first run, instant after)

**`AudioCaptureEngine`** (nonisolated, `@unchecked Sendable`)

- Manages `AVAudioEngine` on a dedicated `DispatchQueue`
- **Critical**: AVAudioEngine must NOT be created/started in a `@MainActor`
  context on iOS 26 — causes `_dispatch_assert_queue_fail` crash
- Captures raw audio at device sample rate (48kHz), stores in thread-safe
  `SampleBuffer`

**`SharedTranscriptionState`** (`@unchecked Sendable`)

- Thread-safe bridge between `@MainActor` service, detached transcription task,
  and audio capture engine
- Contains `SampleBuffer` and active flag

**Transcription Flow:**

1. Audio captured at 48kHz on `AudioCaptureEngine`'s dedicated queue →
   `SampleBuffer`
2. `Task.detached` loop reads samples every 800ms, resamples to 16kHz via
   `AudioConverter`
3. `AsrManager.transcribe()` runs CoreML inference off the main actor
4. Results sent back to main actor via `AsyncStream` → updates `transcript`
   property
5. `ComposerView` observes `transcript` via `onChange` and updates text field

### Known iOS 26 Issues

- **Neural Engine crash**: `MLModelConfiguration.computeUnits` must be
  `.cpuAndGPU` (not `.all`). The Neural Engine (E5RT) crashes with
  `Failed to PropagateInputTensorShapes` on iOS 26.
- **AVAudioEngine crash**: Must be created and started on a non-main-actor
  `DispatchQueue`. Creating it in a `@MainActor` context causes
  `_dispatch_assert_queue_fail` on iOS 26 due to Swift 6 strict concurrency
  interaction with AVAudioEngine's internal threading.
- **Non-Sendable types**: `AsrManager` is not `Sendable`. Use
  `nonisolated(unsafe)` to pass across actor boundaries (same pattern FluidAudio
  uses internally).

### App Group

The app uses App Group `group.com.prem.gemini-shared` (configured in
`gemini-app.entitlements`) for shared model storage across apps. `ModelManager`
handles reading/writing to the shared container.

## Navigation Flow

1. **App Launch** → `ContentView` → `SessionStore.connect()` → establishes SSE
   connection to server
2. **New Chat** → `NewChatView` → user picks project + provider →
   `spawnInstance` HTTP POST → server spawns CLI/SDK
3. **Chat** → User types in `ComposerView` → `submit` command → server processes
   → `bridge:update` SSE events → `MessageListView` renders
4. **Tool Confirmation** → Server sends `waiting_for_confirmation` state →
   `ConfirmationView` appears → user approves/denies → `confirm` command
5. **Voice Input** → Mic button → `SpeechRecognitionService.startTranscribing()`
   → on-device transcription → text appears in composer

## Key Patterns

- **`@MainActor` everywhere**: The app target uses
  `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`. All types default to main actor
  isolation.
- **`@Observable` / `@StateObject`**: `SessionStore` uses `@Observable`,
  `SpeechRecognitionService` uses `ObservableObject` with `@Published`.
- **SSE not WebSocket**: The app receives events via SSE (simpler, HTTP-based),
  sends commands via HTTP POST. No WebSocket in the app layer.
- **Multi-instance**: The app supports multiple concurrent chat instances, each
  with its own project path, provider, and model. Managed via
  `instances: [String: InstanceState]` dictionary in `SessionStore`.
