# Gemini-Web: Complete Project Documentation

## 1. What Is This Project?

This is a **fork of the Google Gemini CLI** (an AI coding assistant) with two
custom packages added to give it a **native iOS/macOS app interface**. Instead of
using Gemini in a terminal, you use it through a polished SwiftUI app on your
iPhone, iPad, or Mac.

**The architecture is:**

```
iOS/macOS App (SwiftUI)         ← The only frontend (what users see)
       ↓ HTTP + SSE
Backend Server (Node.js)        ← Manages AI sessions, routes messages
       ↓ Claude Agent SDK
Claude AI (Anthropic)           ← The AI brain that does the work
```

---

## 2. Backend Server (`packages/web/`)

### 2.1 Entry Point (`src/index.ts`)

- Reads environment variables (`CLAUDE_WEB_PORT=7337`, `CLAUDE_WEB_DEBUG`, etc.)
- Creates a `GeminiWebServer` instance and calls `server.listen()`
- Exits the process if startup fails

### 2.2 HTTP Server (`src/server.ts` — `GeminiWebServer` class)

The main server that routes all HTTP requests. It coordinates 5 internal
managers.

**HTTP API Endpoints:**

| Endpoint                           | Method | What It Does                                                                 |
| ---------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `/health`                          | GET    | Returns `{ status: 'ok' }` — used by the app to check if server is alive    |
| `/api/usage-limits`               | GET    | Returns Claude API usage quotas (5-hour and 7-day limits)                    |
| `/api/browse?path=...`            | GET    | Lists subdirectories at a path (for project folder selection)                |
| `/api/validate-path?path=...`     | GET    | Checks if a path exists and is a valid project directory                     |
| `/api/session`                     | POST   | Creates a new session or resumes an existing one from disk                   |
| `/api/session/{id}/events`        | GET    | Opens an SSE (Server-Sent Events) stream for real-time updates               |
| `/api/session/{id}/command`       | POST   | Sends commands: spawnInstance, terminateInstance, submit, confirm, etc.       |

**Key behaviors:**

- Sets CORS headers (`Access-Control-Allow-Origin: *`) on all requests
- On session creation, restores any persisted instances from disk
- On SSE connection, replays buffered events (or sends a "server restarted"
  notification if events are lost)
- Persists state to disk after every mutation (debounced by 5 seconds)

### 2.3 Session Manager (`src/session-manager.ts`)

Manages **sessions** — each session is a group of chat instances belonging to one
app connection.

**What a Session contains:**

- `id` — UUID
- `instances` — Set of instance IDs in this session
- `sseClients` — Set of connected HTTP responses (SSE streams)
- `eventBuffer` — Last 1000 events (or last 5 minutes), for replay
- `nextSeq` — Sequence counter for event ordering

**Key operations:**

- `createSession()` — Creates a new session with a UUID
- `addSseClient()` / `removeSseClient()` — Manages SSE connections
- `replayEvents(sessionId, since)` — Replays buffered events to a client that
  reconnects (e.g., after app goes to background)
- `sendToSession(sessionId, event)` — Broadcasts an event to ALL connected SSE
  clients in that session. Assigns sequence numbers, buffers events, trims old
  events
- `sendSessionState()` — Sends a snapshot of all instances to connected clients
- `restoreSession(id)` — Loads a session from disk persistence
- `buildPersistedData()` — Creates a JSON-serializable snapshot for saving

### 2.4 Instance Manager (`src/instance-manager.ts`)

Manages **instances** — each instance is one Claude AI conversation.

**What an Instance contains:**

- `id` — UUID
- `sessionId` — Which session it belongs to
- `bridge` — A `ClaudeBridge` object (the AI connection)
- `projectPath` — The working directory for this conversation

**Key operations:**

- `spawnInstance(sessionId, projectPath, yolo)` — Creates a new `ClaudeBridge`,
  starts it, and wires up event handlers
- `restoreInstance(sessionId, data)` — Re-creates a bridge from persisted data
  (resumes a previous conversation)
- `terminateInstance(id)` — Calls `bridge.destroy()` and cleans up
- `submitMessage(id, text)` — Forwards a user message to the bridge
- `confirm(id, callId, outcome)` — Forwards a tool confirmation to the bridge
- `interrupt(id)` — Stops the AI mid-response
- `setModel(id, model)` / `togglePlanMode(id)` / `toggleYolo(id, yolo)` —
  Forwards settings changes

**Event wiring (`_setupEventHandlers`):**

When a bridge emits events, the instance manager forwards them to the session as
SSE events:

| Bridge Event       | SSE Event                    | Description                      |
| ------------------ | ---------------------------- | -------------------------------- |
| `text_delta`       | `claude:text_delta`          | Streaming text token             |
| `text_complete`    | `claude:text_complete`       | Full message done                |
| `tool_added`       | `claude:tool_added`          | AI wants to use a tool           |
| `tool_status`      | `claude:tool_status`         | Tool status changed              |
| `tool_result`      | `claude:tool_result`         | Tool finished with result        |
| `streaming_state`  | `claude:streaming_state`     | State machine update             |
| `models_available` | `claude:models_available`    | List of AI models                |
| `session_complete` | `claude:session_complete`    | Conversation turn done           |

### 2.5 Claude Bridge (`src/claude-bridge/`)

The core component that interfaces with the **Anthropic Claude Agent SDK**. This
is the actual AI integration.

#### 2.5.1 Main Bridge (`claude-bridge/index.ts` — `ClaudeBridge` class)

- Extends `EventEmitter` — emits events that the Instance Manager listens to
- Uses the `@anthropic-ai/claude-agent-sdk` package to create a `Query` object

**Lifecycle:**

1. `start()` — Creates an `AsyncPushQueue` and a `Query` (the SDK's
   conversation object). Fetches available models. Starts `_processMessages()`
   loop in background
2. `submitMessage(text)` — Pushes a user message into the `AsyncPushQueue`,
   which feeds the SDK Query
3. `_processMessages()` — Async loop that iterates over the Query's async
   iterator. For each message from the SDK, calls `_handleMessage()`
4. `destroy()` — Rejects all pending confirmations, ends the queue, aborts the
   query

**Message handling pipeline:**

- `_handleStreamEvent()` → Uses `MessageParser` to detect text starts, text
  deltas, and tool starts
- `_handleAssistantMessage()` → Parses complete assistant messages (text + tool
  uses)
- `_handleToolResults()` → Parses tool execution results
- `_handleResult()` → Captures the session ID for future resumption, marks
  conversation turn complete

**Permission system (`_canUseTool()`):**

When Claude wants to use a tool (run a bash command, edit a file, etc.):

1. Builds user-friendly `ConfirmationDetails` via `ConfirmationBuilder`
2. Emits `tool_added` event with the details
3. Emits `streaming_state` = `waiting_for_confirmation`
4. Returns a **Promise** that stays pending until the iOS app calls `confirm()`
5. When confirmed: resolves with `allow` or `deny` depending on outcome

**Permission modes:**

- **YOLO mode**: Bypasses all confirmations (auto-approves everything)
- **Plan mode**: Uses `permissionMode = 'plan'` (still asks for confirmations)
- **Default mode**: Uses `permissionMode = 'default'` with `_canUseTool`
  callback

#### 2.5.2 AsyncPushQueue (`claude-bridge/async-queue.ts`)

A producer-consumer queue that bridges the imperative "push a message" API with
the async iterator the SDK expects.

- `push(value)` — Adds a message (or immediately resolves a waiting consumer)
- `end()` — Signals no more messages
- Implements `AsyncIterable` so the SDK can `for await (const msg of queue)`

#### 2.5.3 Message Parser (`claude-bridge/message-parser.ts`)

Parses raw SDK messages into structured types:

- `parseStreamEvent()` — Detects `text_start`, `text_delta`, `tool_start`,
  `block_stop`
- `parseAssistantMessage()` — Extracts text parts and tool uses from assistant
  messages
- `parseToolResults()` — Extracts tool results from user messages (the SDK puts
  results in "user" messages)
- `_parseToolInput()` — Type-safe parsing for each known tool: Bash, Read,
  Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, TodoWrite

#### 2.5.4 Confirmation Builder (`claude-bridge/confirmation-builder.ts`)

Builds user-friendly confirmation details for tool uses:

- For **Bash** tool: Extracts the command string
- For **file tools** (Read/Write/Edit): Extracts file path and name
- For **Edit** tool: Creates a diff (`-old_string\n+new_string`)
- Sets `type` to `'exec'` for Bash, `'edit'` for everything else

#### 2.5.5 SDK Message Builder (`claude-bridge/sdk-message-builder.ts`)

Static helper that constructs SDK-compatible user messages:

- `userMessage(text, sessionId)` — Creates
  `{ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }`

#### 2.5.6 Error Classes (`claude-bridge/errors.ts`)

- `ClaudeError` (abstract base) — Has `code`, `recoverable`, `message`
- `ModelFetchError` — Failed to get available models (recoverable)
- `SessionNotInitializedError` — Bridge not started yet (not recoverable)
- `QueryAbortedError` — User interrupted the query (recoverable)

#### 2.5.7 Constants (`claude-bridge/constants.ts`)

- `TOOL_NAMES` — String constants for all known tool names (Bash, Read, Write,
  Edit, Glob, Grep, WebSearch, WebFetch, Task, TodoWrite)
- `LIMITS` — `MAX_COMMAND_PREVIEW: 120`, `MAX_URL_PREVIEW: 80`

### 2.6 Persistence (`src/persistence.ts`)

Saves and loads session data to `~/.claude-web/sessions.json`.

**Key features:**

- **Debounced writes** — Batches rapid changes into a single disk write every 5
  seconds
- **Atomic writes** — Writes to `.tmp` file first, then renames (prevents
  corruption on crash)
- **Corruption recovery** — If the JSON is invalid, renames the file to
  `.corrupt.{timestamp}` and starts fresh
- **Backup** — Keeps a `.backup` file of the previous version

**What is persisted:** Session IDs, instance IDs, project paths, YOLO mode, and
Claude session IDs (for resuming conversations).

### 2.7 Browse Manager (`src/browse-manager.ts`)

Lets the iOS app browse the server's filesystem to select project directories.

- `browse(path)` — Lists subdirectories (hides hidden files starting with `.`)
- `validatePath(path)` — Checks if a path is a valid directory
- `_isProjectDirectory()` — Detects projects by looking for `package.json`,
  `.git`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `.xcodeproj`, etc.

### 2.8 Usage Limits Tracker (`src/usage-limits.ts`)

Fetches Claude API usage quotas from
`https://api.anthropic.com/api/oauth/usage`.

- Gets API key from `ANTHROPIC_API_KEY` environment variable or macOS Keychain
- Caches results for 60 seconds
- Returns `five_hour` and `seven_day` utilization percentages and reset times

### 2.9 Logger (`src/logger.ts`)

Structured logging with Pino:

- **Always logs to file**: `~/.claude-web/logs/server-YYYY-MM-DD.log` (JSON
  format)
- **In dev mode**: Also logs to console with pretty-printing and colors
- `createLogger(component)` — Creates a child logger tagged with a component
  name
- Debug level enabled with `CLAUDE_WEB_DEBUG=1`

### 2.10 Utilities (`src/utils.ts`)

- `readJsonBody(req)` — Reads and parses HTTP request body as JSON
- `sendJson(res, status, payload)` — Sends JSON HTTP response
- `sendSse(res, payload)` — Writes one SSE data frame (`data: {...}\n\n`)
- `expandTilde(path)` — Expands `~` to home directory
- `resolveProjectPath(path)` — Resolves path with tilde expansion and symlink
  resolution

### 2.11 Types (`src/types.ts`)

Defines the complete contract between server and app.

**Streaming states:** `idle` | `responding` | `tool` | `waiting_for_confirmation`

**SSE event types sent to the app:**

| Event Type                 | Description                                        |
| -------------------------- | -------------------------------------------------- |
| `session_state`            | List of all instances in the session               |
| `claude:text_delta`        | Streaming text token                               |
| `claude:text_complete`     | Full text of a completed message                   |
| `claude:tool_added`        | AI wants to use a tool (includes confirmation)     |
| `claude:tool_status`       | Tool status change (running/confirming/approved)   |
| `claude:tool_result`       | Tool execution result                              |
| `claude:streaming_state`   | State machine update                               |
| `claude:models_available`  | Available AI models                                |
| `claude:session_complete`  | Turn complete                                      |
| `server:restarted`         | Server was restarted (client should refresh)       |

**Command types (from app to server):**

| Command              | Description                    |
| -------------------- | ------------------------------ |
| `spawnInstance`      | Create a new Claude conversation |
| `terminateInstance`  | Kill a conversation            |
| `submit`             | Send user message              |
| `confirm`            | Approve/deny a tool use        |
| `setModel`           | Change AI model                |
| `interrupt`          | Stop AI mid-response           |
| `togglePlanMode`     | Toggle plan mode               |
| `toggleYolo`         | Toggle auto-approve mode       |

---

## 3. iOS/macOS App (`gemini-app/`)

### 3.1 App Entry Point (`gemini_appApp.swift`)

- Creates the `WindowGroup` scene with `ContentView` as root
- On iOS: Registers background task handlers, listens for scene phase changes
  (active/inactive/background)
- On macOS: Adds a Settings scene, hides title bar
- When app goes to background: schedules background SSE monitoring task, posts
  notification
- When app returns to foreground: cancels background task, posts notification

### 3.2 State Management (`SessionStore.swift`)

The **central brain** of the app. An `@Observable` class decorated with
`@MainActor` (all updates happen on main thread).

**State it holds:**

- `connected: Bool` — Is the server reachable?
- `instances: [String: InstanceState]` — All active Claude conversations, keyed
  by ID
- `activeInstanceId: String?` — Which conversation is currently shown
- `recentProjects: [String]` — Last 10 project paths used

**How it connects to the server:**

1. Creates a `SessionService` internally
2. Implements `SessionServiceDelegate` to receive callbacks
3. On connect: `SessionService` creates a session via `POST /api/session`, then
   opens SSE stream
4. On SSE message: `SessionService` calls
   `sessionService(_:didReceive:)` → routes to `handleMessage()`

**Message handling (how server events become UI updates):**

| SSE Event                    | What Happens in the App                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `claude:text_delta`          | Appends text to current pending gemini message (streaming) |
| `claude:text_complete`       | Replaces accumulated text with final version               |
| `claude:tool_added`          | Adds tool call to pending messages (with confirmation)     |
| `claude:tool_status`         | Updates tool status (running → success/error/confirming)   |
| `claude:tool_result`         | Attaches result to the tool call                           |
| `claude:streaming_state`     | `idle`: flush pending→history, notify, save. `waiting_for_confirmation`: notify |
| `claude:models_available`    | Updates the model list for the model picker                |
| `session_state`              | Syncs the list of instances                                |
| `server:restarted`           | Handles server restart gracefully                          |

**Persistence:**

- Saves to `~/Application Support/gemini-app/instances.json`
- Debounced (1 second delay) to batch rapid changes
- Restores on app launch with instances in `.disconnected` status
- Saves: instance ID, project path, message history, current model, yolo/plan
  mode

**Commands it sends (via `SessionService`):**

- `spawnInstance(projectPath, yolo)` → Creates new AI conversation
- `submit(text, instanceId)` → Sends user message
- `confirm(callId, outcome, correlationId, instanceId)` → Approves/denies tool
  use
- `setModel(model, instanceId)` → Changes AI model
- `interrupt(instanceId)` → Stops streaming
- `togglePlanMode(instanceId)` → Toggles plan mode
- `toggleYolo(yolo, instanceId)` → Toggles auto-approve mode
- `terminateInstance(id)` → Kills conversation

### 3.3 Network Layer (`SessionService.swift`)

Handles all HTTP communication with the backend.

**Connection flow:**

1. `connect()` → `ensureSession()` → `POST /api/session` (sends stored sessionId
   if resuming)
2. `connectSSE(sessionId)` → Creates `SSEClient` pointing at
   `/api/session/{id}/events`
3. SSE callbacks: `onOpen` → notify delegate connected; `onMessage` →
   `processEvent()` → notify delegate with parsed message; `onError` →
   `scheduleReconnect()` (1 second delay)

**Command sending:**

All commands go through `sendCommand()` which does
`POST /api/session/{id}/command` with a JSON body containing the command type and
parameters.

**Server validation:**

- `validateServer(urlString)` — Static method that does `GET /health` with a
  5-second timeout
- Used by SettingsView when user adds/changes server URL

**Persistence:**

- Stores `sessionId` in `UserDefaults` (survives app restart)
- Stores recent projects per-server (so different servers have separate project
  histories)
- Stores server URL and URL history in `UserDefaults`

**Background handling:**

- On background: Saves connection state
- On foreground: Reconnects SSE if was previously connected
- 3-second grace period before marking as disconnected (avoids flickering during
  brief suspensions)

### 3.4 SSE Client (`SSEClient.swift`)

Low-level Server-Sent Events parser.

- Creates a `URLSessionDataTask` with infinite resource timeout
- Accumulates raw bytes into a string buffer
- Splits on `\n\n` (SSE message boundary)
- Extracts lines starting with `data:` and joins them
- Dispatches parsed JSON strings to `onMessage` callback on main thread
- Detects first data receipt to signal `onOpen`
- Reports errors via `onError`

### 3.5 Data Models (`GeminiModels.swift`)

Defines all the types for serialization/deserialization.

**Core types:**

- `Message` — Enum with cases: `.user(String)`, `.gemini(String)`,
  `.toolGroup([ToolCall])`
- `ToolCall` — A tool invocation with `callId`, `name`, `status`,
  `confirmationDetails`, `resultDisplay`
- `InstanceState` — All state for one conversation: `id`, `projectPath`,
  `status`, `history`, `pending`, `streamingState`, `currentModel`,
  `availableModels`, `usageMetrics`, `todos`, `planModeActive`, `yolo`
- `ConfirmationDetails` — What the user sees when a tool needs approval: `type`
  (exec/edit), `title`, `command`, `filePath`, `fileDiff`

**Incoming message types (from server via SSE):**

- `IncomingMessage` — A discriminated union decoded from JSON `type` field.
  Cases: `sessionState`, `claudeTextDelta`, `claudeTextComplete`,
  `claudeToolAdded`, `claudeToolStatus`, `claudeToolResult`,
  `claudeStreamingState`, `claudeModelsAvailable`, `claudeSessionComplete`,
  `serverRestarted`, `bridgeUpdate` (legacy), `bridgeError`, `unknown`

**Outgoing message types (to server via HTTP):**

- `OutgoingMessage` — Enum with cases: `submit`, `confirm`, `setModel`,
  `togglePlanMode`, `toggleYolo`, `spawnInstance`, `terminateInstance`,
  `setActiveInstance`, `interrupt`

### 3.6 UI Views

#### 3.6.1 ContentView (`Views/ContentView.swift`) — Root Navigation

- **iPhone**: Uses `NavigationStack` — sidebar pushes to chat detail or new chat
- **iPad/Mac**: Uses `NavigationSplitView` — 3-column layout (sidebar | chat |
  detail panel)
- Manages the "new chat" flow: project selection → spawn instance → first
  message → transition to chat
- Overlays `NotificationBadge` (Dynamic Island style) at top of screen
- Toolbar shows project name, plan mode toggle, detail panel toggle

#### 3.6.2 SidebarView — Chat List

- Groups instances by project path into sections
- Each section shows: folder icon + project name + list of chats
- Each chat row: status indicator (green/orange/red dot) + first user message
  preview
- Swipe-to-delete and context menu for terminating chats
- "New Chat" button per project section, "New Project" button at top
- Shows `OfflineBannerView` when disconnected

#### 3.6.3 ComposerView — Message Input

- Expandable text field (grows up to 6 lines)
- **Send button**: Submits the message
- **Stop button**: Interrupts AI streaming (visible during `responding` or
  `tool` state)
- **Mic button**: Starts voice-to-text via `SpeechRecognitionService`
- **Model selector**: Dropdown to pick AI model (Opus, Sonnet, Haiku, Auto)
- **Plan mode toggle**: Capsule button to enter/exit plan mode
- **Sudo toggle**: Shield icon to toggle auto-approve (YOLO) mode

#### 3.6.4 MessageListView — Chat History

- `ScrollView` with `LazyVStack` for performance
- **User messages**: Right-aligned blue bubbles
- **Gemini messages**: Left-aligned with markdown rendering (headings, code
  blocks, lists, inline formatting)
- **Tool groups**: Rendered as `ToolGroupView` cards
- **Typing indicator**: Three animated dots when AI is responding
- Auto-scrolls to bottom on new messages
- Groups consecutive gemini messages into single bubbles

#### 3.6.5 ToolGroupView — Tool Execution Display

- Each tool call shown as an expandable card with:
  - **Header**: Tool icon + name + status badge (color-coded:
    blue=pending, orange=running, green=success, red=error, yellow=confirming)
  - **Expanded content**: Description, scrollable result code block
  - **Confirmation section**: If status is "confirming", embeds
    `ConfirmationView`

#### 3.6.6 ConfirmationView — Tool Approval Dialog

- Shows what the AI wants to do (run a command, edit a file)
- For **Bash commands**: Shows the command text in monospace
- For **file edits**: Shows expandable diff view (red=removed, green=added)
- Three buttons: **Deny** (cancel) | **Allow** (once) | **Always** (remember)

#### 3.6.7 NewChatView — New Conversation Setup

- Hero animation (pulsing rings when connecting, brain icon when ready)
- `ProjectSelectorView` dropdown with recent projects + "Browse Folders..."
- `DirectoryBrowserView` — full filesystem browser (navigates directories,
  detects project folders)
- Model selector and sudo mode toggle
- `ComposerView` for the first message
- Handles offline state with "Server Offline" message

#### 3.6.8 SettingsView — Server Configuration

- List of saved server URLs with checkmarks
- Add new server URL with validation (calls `GET /health`)
- Copy URL, delete URL, reset to default
- Validates before switching (shows spinner and error messages)

#### 3.6.9 DetailPanelContainer + Claude Views (Right Panel)

- **ClaudeDetailPanel**: Scrollable panel with tasks + usage limits
- **ClaudeTaskPanel**: Shows todo items from the AI
  (pending/in-progress/completed with status icons)
- **ClaudeUsageLimitsView**: Progress bars for 5-hour and 7-day API usage limits
  (polls every 60s from `/api/usage-limits`)
- **ClaudePlanModeToggle**: Capsule toggle for plan mode

#### 3.6.10 OfflineComponents

- **OfflineBannerView**: Large banner in sidebar with wifi error icon + "Open
  Settings" button
- **ConnectionStatusBanner**: Slim banner in chat view with retry + settings
  buttons

### 3.7 Notifications (`NotificationService.swift` + `InAppNotification.swift`)

**Local notifications (when app is in background):**

- "Gemini Chat Complete" — When AI finishes responding
- "Action Required" — When AI needs tool confirmation
- Deep link URLs (`gemini-app://notification?id=...&action=...`) for tapping to
  navigate directly

**In-app notifications (when app is in foreground):**

- Dynamic Island style badge at top of screen
- Single notification: Shows project name, tap navigates
- Multiple notifications: Shows count, tap expands picker
- Swipe-to-dismiss gesture on each notification

### 3.8 Background Tasks (`BackgroundTaskManager.swift`)

- iOS only (no-op on macOS)
- Registers `BGProcessingTask` for SSE monitoring
- When app backgrounds: schedules a background task that keeps the SSE
  connection alive for ~30 seconds
- Chain-schedules the next task to maintain continuous monitoring
- Cancelled when app returns to foreground

### 3.9 Design System (`DesignSystem.swift`)

- **Colors**: Status indicators (green/orange/red), message bubbles (blue user,
  gray assistant), tool status colors, surface colors (platform-specific for iOS
  vs macOS)
- **Typography**: Hero title, section headers, message body, code blocks
  (monospaced)
- **Spacing**: xxs(2) through xxl(32)
- **Animations**: Spring (response 0.35), quick (0.2s), standard (0.25s)
- **View modifiers**: `messageBubbleStyle`, `cardStyle`, `statusBadgeStyle`,
  `inputFieldStyle`

---

## 4. Complete Interaction Flow (Server ↔ App)

### 4.1 App Launch & Connection

```
App                                    Server
 |                                       |
 |-- GET /health ----------------------->|  (check server is alive)
 |<---------- { status: 'ok' } ---------|
 |                                       |
 |-- POST /api/session ----------------->|  (body: { sessionId: "stored-id" } or empty)
 |<---------- { sessionId: "abc123" } ---|  (new or resumed session)
 |                                       |
 |-- GET /api/session/abc123/events ---->|  (opens SSE stream, stays open)
 |<---------- SSE: session_state --------|  (list of instances in session)
 |<---------- SSE: server:restarted -----|  (if events were lost)
```

### 4.2 Creating a New Chat

```
App                                    Server
 |                                       |
 |-- GET /api/browse?path=~ ------------>|  (browse home directory)
 |<---------- { directories: [...] } ----|
 |                                       |
 |-- GET /api/validate-path?path=/x ---->|  (validate selected path)
 |<---------- { valid: true, ... } ------|
 |                                       |
 |-- POST /command: spawnInstance ------->|  (body: { projectPath, yolo })
 |<---------- { instanceId, resolvedPath }|
 |<---------- SSE: session_state --------|  (updated instance list)
 |<---------- SSE: claude:models_available|  (available AI models)
```

### 4.3 Sending a Message & Receiving Response

```
App                                    Server                    Claude SDK
 |                                       |                          |
 |-- POST /command: submit ------------->|                          |
 |   { instanceId, text }               |-- bridge.submitMessage -->|
 |                                       |                          |
 |<-- SSE: claude:streaming_state -------|  (state: 'responding')   |
 |<-- SSE: claude:text_delta ------------|  (streaming token)       |
 |<-- SSE: claude:text_delta ------------|  (streaming token)       |
 |<-- SSE: claude:text_delta ------------|  ...more tokens...       |
 |<-- SSE: claude:text_complete ---------|  (full final text)       |
 |<-- SSE: claude:streaming_state -------|  (state: 'idle')         |
 |<-- SSE: claude:session_complete ------|  (turn done)             |
```

### 4.4 Tool Use with Confirmation

```
App                                    Server                    Claude SDK
 |                                       |                          |
 |   (AI decides to run a Bash command)  |                          |
 |                                       |<- _canUseTool callback --|
 |<-- SSE: claude:tool_added ------------|  (tool info + confirmation details)
 |<-- SSE: claude:tool_status -----------|  (status: 'confirming')
 |<-- SSE: claude:streaming_state -------|  (state: 'waiting_for_confirmation')
 |                                       |                          |
 |   [User sees ConfirmationView]        |                          |
 |   [User taps "Allow"]                 |                          |
 |                                       |                          |
 |-- POST /command: confirm ------------>|                          |
 |   { instanceId, callId, outcome }     |-- resolve Promise ------>|  (SDK continues)
 |                                       |                          |
 |<-- SSE: claude:tool_status -----------|  (status: 'approved')
 |<-- SSE: claude:streaming_state -------|  (state: 'responding')
 |<-- SSE: claude:tool_status -----------|  (status: 'running')
 |<-- SSE: claude:tool_result -----------|  (result content)
 |<-- SSE: claude:tool_status -----------|  (status: 'success')
 |<-- SSE: claude:text_delta ------------|  (AI's response about the result)
 |<-- SSE: claude:streaming_state -------|  (state: 'idle')
```

### 4.5 Tool Denial

```
App                                    Server
 |                                       |
 |-- POST /command: confirm ------------>|
 |   { outcome: 'cancel' }              |
 |<-- SSE: claude:tool_status -----------|  (status: 'denied')
 |<-- SSE: claude:streaming_state -------|  (state: 'responding')
 |   (AI acknowledges denial and continues)
```

### 4.6 Interrupt (Stop AI Mid-Response)

```
App                                    Server
 |                                       |
 |-- POST /command: interrupt ---------->|  → bridge.interrupt()
 |<-- SSE: claude:streaming_state -------|  (state: 'idle')
```

### 4.7 Model/Mode Changes

```
App                                    Server
 |                                       |
 |-- POST /command: setModel ----------->|  → bridge.setModel("claude-sonnet-4-5")
 |-- POST /command: togglePlanMode ----->|  → bridge.togglePlanMode()
 |-- POST /command: toggleYolo --------->|  → bridge.setYolo(true/false)
```

### 4.8 Usage Limits Polling

```
App                                    Server              Anthropic API
 |                                       |                     |
 |-- GET /api/usage-limits ------------->|                     |
 |                                       |-- GET /api/oauth/usage -->|
 |                                       |<-- { five_hour, seven_day } |
 |<---------- { five_hour, seven_day } --|
 |   (repeats every 60 seconds)          |
```

### 4.9 SSE Reconnection (after network drop or app backgrounding)

```
App                                    Server
 |                                       |
 |-- GET /events?since=42 -------------->|  (last received seq number)
 |                                       |
 |   [If buffer has events since 42:]    |
 |<-- SSE: (replayed events 43,44,45...) |  (catch up)
 |                                       |
 |   [If buffer doesn't have them:]      |
 |<-- SSE: server:restarted -------------|  (client must refresh)
```

### 4.10 Terminating an Instance

```
App                                    Server
 |                                       |
 |-- POST /command: terminateInstance -->|  → bridge.destroy()
 |<-- SSE: session_state ---------------|  (updated instance list)
```

---

## 5. Key Design Patterns

| Pattern                         | Where Used                          | Why                                                   |
| ------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| **Event Sourcing**              | SSE events with sequence numbers    | Enables replay on reconnection                        |
| **Producer-Consumer Queue**     | `AsyncPushQueue` in Claude Bridge   | Bridges imperative push with SDK's async iterator     |
| **Debounced Persistence**       | Server (5s) and app (1s)            | Prevents excessive disk writes during rapid changes   |
| **Atomic File Writes**          | Server persistence                  | Prevents data corruption on crash                     |
| **Delegate Pattern**            | `SessionServiceDelegate`            | Clean separation of network and state layers          |
| **Optimistic UI Updates**       | Tool confirmations in SessionStore  | Updates UI immediately, reverts on error              |
| **Responsive Layout**           | ContentView with `horizontalSizeClass` | iPhone (stack) vs iPad/Mac (split view)            |
| **Deep Linking**                | `gemini-app://notification?...`     | Notification taps navigate to specific conversations  |
| **Grace Period Disconnection**  | 3-second delay before marking offline | Avoids flicker during brief network interruptions   |
| **Background Task Chaining**    | `BackgroundTaskManager`             | Keeps SSE alive when app is backgrounded on iOS       |

---

## 6. File Map

### Backend (`packages/web/src/`)

| File                                    | Purpose                                          |
| --------------------------------------- | ------------------------------------------------ |
| `index.ts`                              | Entry point, reads env vars, starts server        |
| `server.ts`                             | HTTP server, request routing, coordinates managers |
| `types.ts`                              | All shared TypeScript types                       |
| `session-manager.ts`                    | Session lifecycle, SSE clients, event buffering   |
| `instance-manager.ts`                   | Instance lifecycle, event wiring                  |
| `persistence.ts`                        | Disk save/load with debouncing and atomic writes  |
| `browse-manager.ts`                     | Filesystem browsing for project selection         |
| `usage-limits.ts`                       | Claude API usage quota tracking                   |
| `logger.ts`                             | Structured logging with Pino                      |
| `utils.ts`                              | HTTP helpers, path utilities                      |
| `claude-bridge/index.ts`               | Main bridge to Claude Agent SDK                   |
| `claude-bridge/types.ts`               | Bridge-specific types                             |
| `claude-bridge/constants.ts`           | Tool name constants, limits                       |
| `claude-bridge/errors.ts`              | Custom error classes                              |
| `claude-bridge/async-queue.ts`         | Producer-consumer async queue                     |
| `claude-bridge/confirmation-builder.ts`| Builds tool confirmation details                  |
| `claude-bridge/message-parser.ts`      | Parses SDK messages into structured types         |
| `claude-bridge/sdk-message-builder.ts` | Builds SDK-compatible messages                    |

### iOS App (`gemini-app/gemini-app/`)

| File                                   | Purpose                                         |
| -------------------------------------- | ----------------------------------------------- |
| `gemini_appApp.swift`                  | App entry point, scene lifecycle                 |
| `ContentView.swift`                    | Main router, root navigation                     |
| `SessionStore.swift`                   | Central state container, message handling         |
| `SessionService.swift`                 | HTTP + SSE client, command sending                |
| `SSEClient.swift`                      | Low-level SSE streaming parser                    |
| `GeminiModels.swift`                   | All data models and serialization types           |
| `DesignSystem.swift`                   | Design tokens, colors, typography, modifiers      |
| `NotificationService.swift`            | Local push notification management                |
| `BackgroundTaskManager.swift`          | iOS background task scheduling                    |
| `InAppNotification.swift`              | In-app notification UI (Dynamic Island style)     |
| `Views/ContentView.swift`             | Root view with responsive layout                  |
| `Views/SidebarView.swift`             | Chat list grouped by project                      |
| `Views/ComposerView.swift`            | Message input with voice, model selector          |
| `Views/MessageListView.swift`         | Chat history with markdown rendering              |
| `Views/ConfirmationView.swift`        | Tool approval dialog (Allow/Deny/Always)          |
| `Views/ToolGroupView.swift`           | Tool execution cards with status badges           |
| `Views/NewChatView.swift`             | New chat setup with project selection             |
| `Views/SettingsView.swift`            | Server URL configuration                          |
| `Views/DetailPanelContainer.swift`    | iPad right panel wrapper                          |
| `Views/ProjectSelectorView.swift`     | Project dropdown + directory browser              |
| `Views/OfflineComponents.swift`       | Offline banners and retry UI                      |
| `Views/Claude/ClaudeDetailPanel.swift` | Right panel composing tasks + usage               |
| `Views/Claude/ClaudeTaskPanel.swift`   | Todo/task list display                            |
| `Views/Claude/ClaudePlanModeToggle.swift` | Plan mode toggle button                        |
| `Views/Claude/ClaudeUsageLimitsView.swift` | Usage limit progress bars                      |

---

## 7. Environment Variables

| Variable                   | Default | Purpose                           |
| -------------------------- | ------- | --------------------------------- |
| `CLAUDE_WEB_PORT`          | 7337    | Server port                       |
| `CLAUDE_WEB_WS_PATH`      | /ws     | WebSocket path                    |
| `CLAUDE_WEB_DEBUG`         | 0       | Enable debug logging (set to 1)   |
| `CLAUDE_WEB_CLI_LOG`       | false   | Log CLI output to stdout          |
| `CLAUDE_WEB_SPAWN_TIMEOUT_MS` | 18000 | CLI spawn timeout in ms          |
| `ANTHROPIC_API_KEY`        | —       | Claude API key (for usage limits) |

---

## 8. Persistence Locations

| What                  | Location                                             |
| --------------------- | ---------------------------------------------------- |
| Server sessions       | `~/.claude-web/sessions.json`                        |
| Server logs           | `~/.claude-web/logs/server-YYYY-MM-DD.log`           |
| App instance state    | `~/Application Support/gemini-app/instances.json`    |
| App session ID        | `UserDefaults` (key: `sessionId`)                    |
| App recent projects   | `UserDefaults` (per-server key)                      |
| App server URL        | `UserDefaults` (key: `serverURL`)                    |
