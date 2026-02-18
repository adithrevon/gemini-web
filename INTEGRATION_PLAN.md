# Integration Plan: File Browser as Library for iOS + Node.js Stack

## Purpose

This document is a **self-contained implementation specification** for another Claude Code agent. It describes how to repackage the `fileBrowserToyApp` as two libraries:

1. **`@file-browser/server`** — A Node.js library (Express middleware + WebSocket handler) that mounts into an existing Express/HTTP server
2. **`FileBrowserKit`** — A Swift iOS library (Swift Package) that replaces the vanilla JS web client with native SwiftUI views

The goal is to reproduce **every feature, behavior, edge case, and test** from the current web app as add-on libraries that integrate into an existing iOS app + Node.js backend **without modifying any existing workflows**.

---

## Part 1: Current System — Complete Behavioral Specification

### 1.1 Protocol (shared/protocol.js)

The protocol defines **13 command types** used for WebSocket communication. This is the single source of truth — both server and client must use these exact strings.

```
Command Type String        Constant Name         Direction        Payload Shape
─────────────────────────  ────────────────────  ───────────────  ──────────────────────────────────
"tree.fileAdded"           TREE_FILE_ADDED       server→client    { path: string, name: string }
"tree.fileRemoved"         TREE_FILE_REMOVED     server→client    { path: string }
"tree.dirAdded"            TREE_DIR_ADDED        server→client    { path: string, name: string }
"tree.dirRemoved"          TREE_DIR_REMOVED      server→client    { path: string }
"file.changed"             FILE_CHANGED          server→client    { path: string }
"file.open"                FILE_OPEN             server→client    { file: string }
"viewport.scroll"          VIEWPORT_SCROLL       server→client    { line: number }
"decoration.add"           DECORATION_ADD        server→client    { startLine: number, endLine: number, style: string }
"decoration.clear"         DECORATION_CLEAR      server→client    {} (empty payload)
"batch"                    BATCH                 server→client    { commands: Array<{type, payload}> }
"diff.show"                DIFF_SHOW             server→client    { fileName: string, diff: string, outputFormat: string, title?: string }
"diff.clear"               DIFF_CLEAR            server→client    {} (empty payload)
"ack"                      ACK                   client→server    { type: "ack", ref: string, status: "ok"|"error", error?: string }
```

**CRITICAL DETAILS:**
- `path` values in tree events are **relative to rootDir** (e.g. `"src/index.js"`, NOT absolute paths)
- `file` in `file.open` is also a relative path
- `ack.ref` matches the `id` (UUID) from the original command message
- `decoration.style` values: `"focus"` maps to a focus highlight style, anything else maps to a generic highlight style
- `batch.commands` is an array — commands are executed **sequentially in order**, not in parallel
- Every WS message from server has shape: `{ id: UUID, type: string, payload: object, timestamp: number }`
- The `"connected"` message (`{ type: "connected", clientId: UUID }`) is sent on WS connection open — it is NOT a command and must be filtered out by the dispatcher

### 1.2 REST API Endpoints

#### `GET /api/tree?path=<string>&depth=<number>`

Returns a directory tree rooted at `path` (relative to rootDir).

- **Default depth**: 2 (if not specified or NaN)
- **Path resolution**: Leading slashes are stripped; path is resolved relative to rootDir
- **Security**: `resolveSecure()` throws `PathTraversalError` (403) for `../` escapes
- **Excluded directories**: `node_modules` and `.git` (regex: `/node_modules|\.git/`)
- **Response shape** (recursive):
  ```json
  {
    "name": "dirname",
    "path": "relative/path",    // "." for root
    "type": "directory",
    "size": 4096,
    "extension": "",
    "children": [ ... ]         // same shape recursively
  }
  ```
- **CORNER CASE**: Root directory's path is returned as `"."` (not empty string, not `"/"`)
- **CORNER CASE**: When `path` is `"/"` or omitted, it resolves to rootDir itself
- **CORNER CASE**: `dirTree()` returns `null` for non-existent paths → 404
- **Error codes**: 403 (traversal), 404 (not found), 500 (other errors)

#### `GET /api/file?path=<string>`

Returns file content and metadata.

- **Required**: `path` query parameter (400 if missing)
- **Max file size**: 5,242,880 bytes (5 MB) → 413 if exceeded
- **File must exist and be a regular file** → 404 otherwise (`stat.isFile()`)
- **Response shape**:
  ```json
  {
    "path": "the/original/path/as-sent",
    "name": "filename.ext",
    "content": "file contents as UTF-8 string",
    "size": 1234,
    "mimeType": "application/javascript",
    "lineCount": 42,
    "extension": ".js"
  }
  ```
- **CORNER CASE**: `lineCount` is calculated as `content.split('\n').length` — a file with no trailing newline and N lines gives N; a file ending with `\n` gives N+1 (empty string after last split)
- **CORNER CASE**: Binary files read as UTF-8 will produce garbled `content` — no binary detection exists
- **CORNER CASE**: `mime.lookup()` returns `false` for unknown extensions → falls back to `"text/plain"`
- **CORNER CASE**: `path` in response is echoed back exactly as the client sent it (not normalized)
- **Error codes**: 400 (missing path), 403 (traversal), 404 (not found / not a file), 413 (too large), 500

#### `POST /api/command`

Sends a command to WebSocket client(s).

- **Request body**: `{ clientId?: string, type: string, payload: object }`
- **Validation**: `type` is required (400) and must be one of the 13 known `Commands` values (400 for unknown types)
- **Targeted send** (when `clientId` is provided): Uses `sendCommand()` which returns a **Promise** that waits for ACK (5-second timeout). If the client doesn't ACK, the Promise rejects and a 500 is returned.
- **Broadcast** (when `clientId` is omitted): Uses `broadcastCommand()` which is **fire-and-forget** (no ACK waiting). Returns immediately.
- **Batch handling** (`type === "batch"`):
  - `payload.commands` must be an array (400 if not)
  - **Each command type in the batch is validated** against the allowlist (400 if any is unknown)
  - Targeted: commands executed sequentially with `sendCommand` (each awaited)
  - Broadcast: commands iterated and broadcast individually
  - Response includes `{ executed: N }` with count

- **CORNER CASE**: `broadcastCommand` with a `specificClientId` sends to only that client (despite the function name). This is used by `POST /api/diff/send`.
- **CORNER CASE**: `sendCommand` generates a new UUID per command, stores `{resolve, reject, timeout}` in `pendingAcks` Map, and the ACK handler matches by `msg.ref === id`

#### `POST /api/diff`

Generates a unified diff string (pure computation, no WebSocket).

- **Two modes**:
  1. `{ fileName, oldContent, newContent }` — diff between two provided strings
  2. `{ fileName?, path, newContent }` — reads `oldContent` from disk at `path`, diffs against `newContent`
- **`context` option**: Number of surrounding lines (default 3)
- **Response**: `{ diff: string, fileName: string }`
- **Uses**: `createPatch()` from the `diff` npm package with headers `"original"` / `"modified"`
- **CORNER CASE**: When both `oldContent` and `path` are given, `oldContent` takes precedence (`path` is only used if `oldContent` is falsy)
- **CORNER CASE**: Explicitly checks `=== undefined` and `=== null` (not just falsy) — empty string `""` is a valid oldContent/newContent
- **Error codes**: 400 (missing content), 403 (traversal on path), 500

#### `POST /api/diff/send`

Generates diff AND broadcasts it via WebSocket as `diff.show` command.

- **Request body**: `{ clientId?, fileName, oldContent, newContent, context?, outputFormat? }`
- **Default outputFormat**: `"side-by-side"`
- **Default fileName**: `"unnamed"` if not provided
- **Response**: `{ status: "ok", diffSize: number }` (diffSize is the string length of the unified diff)
- **CORNER CASE**: Uses `broadcastCommand(Commands.DIFF_SHOW, ..., clientId)` — if `clientId` is provided, only that client receives it

### 1.3 WebSocket Server Behavior

**Connection lifecycle:**
1. Client connects to `/ws` path
2. Server generates UUID, stores `clientId → ws` in `clients` Map
3. Server sends `{ type: "connected", clientId: UUID }`
4. Client stores `clientId` for future reference
5. On close/error: server removes client from Map

**Message handling (server-side):**
- Only `"ack"` type messages are processed from clients
- Malformed JSON is logged with `console.warn` (not silently ignored)
- ACK processing: looks up `msg.ref` in `pendingAcks` Map, clears timeout, resolves/rejects the stored Promise

**Command sending:**
- `sendCommand(clientId, type, payload)`: Targeted, awaits ACK, 5-second timeout, rejects if client not connected or ws.readyState !== 1 (OPEN)
- `broadcastCommand(type, payload, specificClientId?)`: Fire-and-forget, skips clients with readyState !== 1
- Both attach `{ id: UUID, type, payload, timestamp: Date.now() }` to messages

**CRITICAL DETAILS:**
- `clients` and `pendingAcks` are **module-level** Maps (global singletons)
- Multiple calls to `setupWebSocket` operate on the **same** Maps — this means the library must be careful about test isolation
- `ACK_TIMEOUT` is 5000ms (5 seconds)
- WS server is mounted at path `/ws` specifically

### 1.4 File Watcher Behavior

**Setup:**
- Uses `chokidar.watch(rootDir, options)` with:
  - `ignored`: `/node_modules|\.git/` (configurable)
  - `persistent: true`
  - `ignoreInitial: true` — does NOT fire events for existing files on startup
  - `awaitWriteFinish: { stabilityThreshold: debounceMs }` — waits for file writes to stabilize (default 300ms)

**Events → Commands:**
| chokidar event | Command broadcast | Payload |
|---|---|---|
| `add` | `tree.fileAdded` | `{ path: relative, name: basename }` |
| `unlink` | `tree.fileRemoved` | `{ path: relative }` |
| `addDir` | `tree.dirAdded` | `{ path: relative, name: basename }` |
| `unlinkDir` | `tree.dirRemoved` | `{ path: relative }` |
| `change` | `file.changed` | `{ path: relative }` |

**CRITICAL DETAILS:**
- Paths broadcast are **relative to rootDir** (via `path.relative(getRootDir(), absolutePath)`)
- Only one watcher can be active at a time (module-level `let watcher = null`; starting a new one closes the previous)
- `stopWatcher()` must be called on shutdown to clean up

### 1.5 Client-Side Behavior

#### WebSocket Client (WSClient)

- **Auto-reconnect**: On close, schedules reconnect after `_currentDelay` (starts at 2000ms)
- **Backoff**: Multiplied by 1.5 on each reconnect, capped at `maxReconnectDelay` (30000ms)
- **Reset**: On successful connection, `_currentDelay` resets to `reconnectDelay`
- **Closed state**: `close()` sets `_closed = true` — prevents reconnection
- **Message listeners**: Array-based `_messageListeners` — `addMessageListener(fn)` appends, all listeners called for every parsed message
- **CORNER CASE**: `send()` silently does nothing if ws is null or not OPEN — no error thrown, no queuing
- **CORNER CASE**: Malformed JSON messages are caught and logged with `console.warn`
- **CORNER CASE**: The `"connected"` message with `clientId` is handled inline in `onmessage` before listeners are called

#### Command Dispatcher

- Registers via `wsClient.addMessageListener()` — no monkey-patching
- Filters out `type === "connected"` and `type === "ack"` (does NOT dispatch these)
- Handler lookup: `this.handlers[msg.type]` — single handler per type (last registration wins)
- On successful handler: sends `{ type: "ack", ref: msg.id, status: "ok" }`
- On handler error: sends `{ type: "ack", ref: msg.id, status: "error", error: err.message }`
- **CORNER CASE**: If no handler is registered for a type, dispatch silently returns — NO ack is sent
- **CORNER CASE**: Handlers are `async` — dispatch awaits them

#### File Tree State Model

The tree uses a **flat array** representation (`this.state = []`) where nesting is encoded via `depth` property.

**Node shape in state array:**
```
{ path, name, type: "directory"|"file", depth: number, expanded: boolean, loaded: boolean, extension: string }
```

**Key behaviors:**
- **Sort order**: Directories first, then alphabetical by `name` (case-sensitive `localeCompare`)
- **Root node**: `state[0]` is the root directory at depth 0 — it is **hidden** from rendering (skipped in render loop)
- **Lazy loading**: `expand()` fetches children only if `!node.loaded`; after first load, sets `loaded = true` — subsequent expand/collapse toggles don't re-fetch
- **Collapse**: Removes all consecutive items with `depth > node.depth` starting from index+1 (spliced out of array). Sets `node.expanded = false` but keeps `node.loaded = true`
- **CORNER CASE**: `addNode()` only inserts if parent is found AND `parent.expanded === true` (ignores if parent is collapsed)
- **CORNER CASE**: `addNode()` inserts after parent's **last descendant** (walks forward while `depth > parent.depth`)
- **CORNER CASE**: `removeNode()` removes the node AND all its descendants (same depth-walking logic as collapse)
- **CORNER CASE**: Clicking a file sets `this.selectedPath` and re-renders entire tree. Clicking a directory calls `toggle()` (no selection set).
- **Render**: Full DOM clear + rebuild on every state change. Indentation: `(depth - 1) * 16 + 8` px padding-left.
- **Icons**: SVG icons with unique gradient IDs (monotonically incrementing counter `_gradientIdCounter`). File icons colored by extension via `EXT_GRADIENTS` map (21 extensions mapped). Folder icons have blue gradient with opacity based on expanded state (1.0 expanded, 0.75 collapsed).

#### Code Viewer (CodeMirror 6 wrapper)

- **Read-only**: Both `EditorState.readOnly.of(true)` and `EditorView.editable.of(false)` are set
- **Theme**: `oneDark`
- **Language detection**: Maps file extension to dynamic import of CodeMirror language pack:
  - `.js`, `.mjs` → javascript()
  - `.jsx` → javascript({ jsx: true })
  - `.ts` → javascript({ typescript: true })
  - `.tsx` → javascript({ typescript: true, jsx: true })
  - `.py` → python()
  - `.html`, `.htm` → html()
  - `.css` → css()
  - `.json` → json()
  - `.md`, `.markdown` → markdown()
  - Unknown extensions → no language highlighting
- **CORNER CASE**: `setContent()` always destroys and recreates the entire editor (even if only content changes). Both branches of the if/else do the same thing.
- **CORNER CASE**: Language loading failure is silently caught — editor still shows content without highlighting
- **Highlight system**: Uses CodeMirror `StateField` + `StateEffect` pattern:
  - `addHighlight` effect: `{ from: lineStartPos, className?: string }`
  - `clearHighlights` effect: clears all decorations
  - `highlightField` state field: maps decorations through transaction changes, processes effects
  - `goToLine(n)`: Scrolls to line N (1-based), clears existing highlights, adds new highlight at that line. Uses `{ y: 'center' }` scroll option. Returns silently for out-of-range lines (`< 1` or `> doc.lines`).
  - `highlight(startLine, endLine, className)`: Adds decoration to each line in range. Clamps `endLine` to `doc.lines`. Default className: `"cm-highlighted-line"`.

#### Diff Viewer (diff2html wrapper)

- **Show**: Sets `container.style.display = "block"`, clears innerHTML, renders header (title, toggle button, close button) + diff content
- **Clear**: Sets `container.style.display = "none"`, clears innerHTML, calls `onClear()` callback
- **Toggle**: Switches between `"side-by-side"` and `"line-by-line"` outputFormat by re-calling `show()` with flipped format
- **diff2html options**: `{ outputFormat, matching: 'lines', drawFileList: false, diffStyle: 'word' }`
- **Callbacks**: `onShow()` called after rendering; `onClear()` called after clearing
- **CORNER CASE**: `toggle()` does nothing if `_currentDiff` is null (no diff shown)
- **CORNER CASE**: Toggle button text shows the OTHER format name ("Inline" when currently side-by-side, "Side-by-Side" when currently inline)
- **CORNER CASE**: Default title is `"Diff View"` if options.title is empty/falsy

#### Main App Wiring (client/main.js)

Command handler behaviors that have subtle logic:
- `file.open`: Fetches file via API, calls `viewer.setContent(content, extension)` — no tree selection update
- `file.changed`: Only reloads if `tree.selectedPath.endsWith(filePath)` — uses `endsWith`, not exact match
- `tree.fileAdded/dirAdded`: Computes `parentPath` as `filePath.substring(0, filePath.lastIndexOf('/')) || '/'`
- `decoration.add`: Maps `style === 'focus'` → `"cm-focus-line"`, else → `"cm-highlighted-line"`
- `batch`: Iterates `commands` array, looks up handler in `dispatcher.handlers[cmd.type]`, awaits each

### 1.6 Security Model

**Path Traversal Prevention (`resolveSecure`):**
1. If `userPath` is falsy or empty after stripping leading slashes → returns `rootDir`
2. Strips ALL leading `/` characters (`userPath.replace(/^\/+/, '')`)
3. Resolves against rootDir: `path.resolve(rootDir, cleaned)`
4. Validates: `resolved.startsWith(rootDir + path.sep) || resolved === rootDir`
5. Throws `PathTraversalError` (name: `"PathTraversalError"`, status: 403) on violation

**CORNER CASE**: The check uses `rootDir + path.sep` — this prevents a path like `/root-extra/foo` from passing when rootDir is `/root`. Without the `path.sep`, `/root-extra` would startWith `/root`.
**CORNER CASE**: `resolveSecure('/')` → strips to empty string → returns rootDir
**CORNER CASE**: `resolveSecure(null)` → returns rootDir (first guard)

**Command allowlisting:**
- `const allowedTypes = new Set(Object.values(Commands))` — 13 known types
- Validated on `POST /api/command` for both single commands and each command in a batch
- Unknown types return 400 with message `"Unknown command type: <type>"`

**File size limit:**
- `MAX_FILE_SIZE = 5 * 1024 * 1024` (5,242,880 bytes)
- Checked via `stat.size` BEFORE reading file content (prevents memory issues)
- Returns 413 with message `"File too large (<size> bytes). Max: <MAX_FILE_SIZE> bytes"`

---

## Part 2: Node.js Server Library (`@file-browser/server`)

### 2.1 Design Principle

The library must be **mountable middleware** — the host app calls a single setup function and gets Express routes + WebSocket handler attached to its existing server. No standalone server, no Vite, no client-serving.

### 2.2 Package Structure

```
file-browser-server/
├── package.json
├── index.js              # Main entry: exports createFileBrowserMiddleware(), setupFileBrowserWS(), startFileBrowserWatcher()
├── protocol.js           # Command type constants (shared between server and iOS client)
├── utils.js              # resolveSecure, PathTraversalError, MAX_FILE_SIZE
├── diff.js               # generateDiff (uses 'diff' npm package)
├── routes/
│   ├── tree.js           # GET /api/file-browser/tree
│   ├── file.js           # GET /api/file-browser/file
│   ├── command.js        # POST /api/file-browser/command
│   └── diff.js           # POST /api/file-browser/diff, POST /api/file-browser/diff/send
├── ws/
│   ├── handler.js        # WebSocket server setup
│   └── commands.js       # sendCommand, broadcastCommand
├── watcher.js            # File system watcher
└── tests/                # Full test suite (see Part 4)
```

### 2.3 API Design

```javascript
// In the host application:
import { createFileBrowserMiddleware, setupFileBrowserWS, startFileBrowserWatcher } from '@file-browser/server';

// 1. Mount REST routes under a configurable prefix
const fileBrowserRoutes = createFileBrowserMiddleware({
  rootDir: '/path/to/serve',
  routePrefix: '/api/file-browser',  // default: '/api/file-browser'
});
app.use(fileBrowserRoutes);

// 2. Attach WebSocket handler to existing HTTP server
const wss = setupFileBrowserWS(server, {
  path: '/ws/file-browser',  // default: '/ws/file-browser'
});

// 3. Start file watcher (optional)
const watcher = startFileBrowserWatcher('/path/to/serve', {
  ignored: /node_modules|\.git/,  // default
  debounceMs: 300,                // default
});

// 4. Clean shutdown
watcher.close();
```

### 2.4 Key Differences from Current Implementation

1. **Route prefix**: All routes must be under a configurable prefix (default `/api/file-browser`) to avoid collisions with host app routes. Current routes `/api/tree`, `/api/file`, etc. become `/api/file-browser/tree`, `/api/file-browser/file`, etc.

2. **No global state**: Current implementation uses module-level `let rootDir`, `const clients = new Map()`, `const pendingAcks = new Map()`. The library must use **instance-scoped state** (pass config through factory functions or use a context object). This is critical for:
   - Multiple file browser instances serving different rootDirs
   - Test isolation (tests currently share global state)

3. **WebSocket path**: Must be configurable and namespaced (default `/ws/file-browser`) to avoid collision with host app's WebSocket endpoints.

4. **No express.json()**: The host app may already have body parsing. The library should document that `express.json()` middleware must be applied before the file browser routes, or apply it narrowly to its own routes only.

5. **Dependencies**: `chokidar`, `diff`, `directory-tree`, `fs-extra`, `mime-types`, `ws` — all must be listed as `dependencies` in package.json. `express` should be a `peerDependency`.

### 2.5 Instance-Scoped State Design

```javascript
function createFileBrowserMiddleware({ rootDir, routePrefix = '/api/file-browser' }) {
  // Instance state — NOT module globals
  const config = {
    rootDir: path.resolve(rootDir),
    maxFileSize: 5 * 1024 * 1024,
  };

  const router = Router();
  router.use(express.json()); // Narrow scope

  // Mount routes with prefix
  router.get(`${routePrefix}/tree`, createTreeHandler(config));
  router.get(`${routePrefix}/file`, createFileHandler(config));
  router.post(`${routePrefix}/command`, createCommandHandler(config, wsContext));
  router.post(`${routePrefix}/diff`, createDiffHandler(config));
  router.post(`${routePrefix}/diff/send`, createDiffSendHandler(config, wsContext));

  return router;
}
```

The WebSocket context (clients Map, pendingAcks Map) must be shared between the WS handler and the command/diff routes. Use a shared context object:

```javascript
function createFileBrowserContext() {
  return {
    clients: new Map(),
    pendingAcks: new Map(),
  };
}
```

### 2.6 Behavioral Fidelity Checklist

Every behavior from Part 1 must be preserved. Pay special attention to:

- [ ] `resolveSecure` uses `rootDir + path.sep` check (not just `startsWith(rootDir)`)
- [ ] `resolveSecure` strips ALL leading slashes (regex `/^\/+/`)
- [ ] Tree paths converted to relative using `path.relative(rootDir, absolutePath)` — root becomes `"."`
- [ ] Tree excludes `node_modules` and `.git` (regex in both tree query and watcher)
- [ ] `dirTree()` returns null for non-existent paths → 404 response
- [ ] File route checks `stat.isFile()` — directories return 404
- [ ] File size check happens BEFORE `readFile` (via `stat.size`)
- [ ] `lineCount` uses `.split('\n').length`
- [ ] Diff route: `oldContent` takes precedence over `path` when both provided
- [ ] Diff route: checks `=== undefined || === null` (not falsy — empty string is valid)
- [ ] Command route: validates type against allowlist for both single and batch commands
- [ ] `sendCommand` uses 5000ms ACK timeout
- [ ] `broadcastCommand` skips clients with `ws.readyState !== 1`
- [ ] Watcher uses `ignoreInitial: true` and `awaitWriteFinish: { stabilityThreshold: debounceMs }`
- [ ] Only one watcher active at a time (new start closes previous)

---

## Part 3: Swift iOS Library (`FileBrowserKit`)

### 3.1 Design Principle

The Swift library provides native SwiftUI views and networking layer that replicate all client-side functionality. It connects to the same Node.js backend API. The library must be a **Swift Package** that the host iOS app imports and embeds views from.

### 3.2 Package Structure

```
FileBrowserKit/
├── Package.swift
├── Sources/
│   └── FileBrowserKit/
│       ├── FileBrowserKit.swift           # Public entry point / configuration
│       ├── Protocol/
│       │   └── Commands.swift             # Command type enum matching protocol.js
│       ├── Networking/
│       │   ├── FileBrowserAPIClient.swift  # REST API client
│       │   ├── WebSocketClient.swift       # WS client with auto-reconnect
│       │   └── CommandDispatcher.swift     # Routes WS commands to handlers
│       ├── Models/
│       │   ├── FileNode.swift             # Tree node model (Codable)
│       │   ├── FileContent.swift          # File content response model
│       │   └── DiffContent.swift          # Diff response model
│       ├── ViewModels/
│       │   ├── FileTreeViewModel.swift    # Observable tree state
│       │   ├── CodeViewerViewModel.swift  # Observable editor state
│       │   └── DiffViewerViewModel.swift  # Observable diff state
│       ├── Views/
│       │   ├── FileBrowserView.swift      # Main container view (tree + viewer + diff)
│       │   ├── FileTreeView.swift         # Recursive tree with expand/collapse
│       │   ├── CodeViewerView.swift       # Syntax-highlighted code display
│       │   └── DiffViewerView.swift       # Diff display view
│       └── Utilities/
│           └── SyntaxHighlighter.swift    # Extension-based syntax coloring
└── Tests/
    └── FileBrowserKitTests/
        ├── CommandsTests.swift
        ├── APIClientTests.swift
        ├── WebSocketClientTests.swift
        ├── CommandDispatcherTests.swift
        ├── FileTreeViewModelTests.swift
        ├── CodeViewerViewModelTests.swift
        └── DiffViewerViewModelTests.swift
```

### 3.3 Commands.swift — Protocol Mirror

```swift
public enum FileBrowserCommand: String, CaseIterable, Codable {
    case treeFileAdded = "tree.fileAdded"
    case treeFileRemoved = "tree.fileRemoved"
    case treeDirAdded = "tree.dirAdded"
    case treeDirRemoved = "tree.dirRemoved"
    case fileChanged = "file.changed"
    case fileOpen = "file.open"
    case viewportScroll = "viewport.scroll"
    case decorationAdd = "decoration.add"
    case decorationClear = "decoration.clear"
    case batch = "batch"
    case diffShow = "diff.show"
    case diffClear = "diff.clear"
    case ack = "ack"
}
```

**CRITICAL**: The raw string values must EXACTLY match the JS `protocol.js` constants.

### 3.4 Networking Layer

#### FileBrowserAPIClient

```swift
public class FileBrowserAPIClient {
    let baseURL: URL        // e.g. "https://myserver.com/api/file-browser"
    let session: URLSession

    public func fetchTree(path: String, depth: Int = 1) async throws -> FileNode
    public func fetchFile(path: String) async throws -> FileContent
    public func sendCommand(type: FileBrowserCommand, payload: [String: Any]) async throws
    public func sendDiff(fileName: String, oldContent: String, newContent: String, outputFormat: String) async throws
}
```

**Path encoding**: Must use `addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)` for path parameters — mirrors JS `encodeURIComponent()`.

**Error handling**: Parse JSON error body `{ "error": "message" }` from non-2xx responses and throw structured errors:
```swift
public enum FileBrowserError: Error {
    case pathTraversal(String)      // 403
    case notFound(String)           // 404
    case fileTooLarge(String)       // 413
    case badRequest(String)         // 400
    case serverError(String)        // 500
    case networkError(Error)
}
```

#### WebSocketClient

Must replicate these exact behaviors from `client/ws/client.js`:

- Auto-reconnect with exponential backoff (1.5x multiplier)
- Initial delay: 2000ms, max delay: 30000ms
- Reset delay to initial on successful connection
- `_closed` flag prevents reconnect after explicit `close()`
- Store `clientId` from `"connected"` message
- `send()` silently no-ops if connection is not open (no error, no queuing)
- Message listener array pattern (`addMessageListener`)
- Log malformed JSON messages (don't silently ignore)

Use `URLSessionWebSocketTask` for the WebSocket connection.

**CORNER CASE**: iOS apps go to background — the WS connection will drop. The auto-reconnect must handle this gracefully. Consider adding `willEnterForeground` / `didEnterBackground` notifications to pause/resume reconnect attempts.

#### CommandDispatcher

Must replicate from `client/ws/dispatcher.js`:

- Filter out `"connected"` and `"ack"` message types
- Route to registered handler by type (single handler per type)
- Send `"ack"` with `ref: msg.id` on success/error
- Silently ignore commands with no registered handler (NO ack sent)
- Handlers are async — await completion before sending ack

### 3.5 Models (Codable structs)

```swift
public struct FileNode: Codable, Identifiable {
    public var id: String { path }
    public let name: String
    public let path: String
    public let type: String          // "directory" or "file"
    public let size: Int?
    public let extension: String?
    public let children: [FileNode]?
}

public struct FileContent: Codable {
    public let path: String
    public let name: String
    public let content: String
    public let size: Int
    public let mimeType: String
    public let lineCount: Int
    public let extension: String
}

// WebSocket message envelope
public struct WSMessage: Codable {
    public let id: String?
    public let type: String
    public let payload: [String: AnyCodable]?  // Needs AnyCodable or use JSONSerialization
    public let timestamp: Double?
    public let clientId: String?               // Only in "connected" message
}
```

**CORNER CASE**: The `payload` field has different shapes per command type. Use `[String: Any]` with manual JSON decoding or a library like `AnyCodable`. Alternatively, use typed payload structs per command and decode based on `type`.

### 3.6 ViewModels

#### FileTreeViewModel

```swift
@Observable
public class FileTreeViewModel {
    public var nodes: [FlatTreeNode] = []    // Flat array mirroring JS state
    public var selectedPath: String? = nil
    public var isLoading = false

    // Must replicate the flat array + depth model from tree.js
    public struct FlatTreeNode: Identifiable {
        public var id: String { path }
        let path: String
        let name: String
        let type: NodeType        // .directory or .file
        let depth: Int
        var expanded: Bool
        var loaded: Bool
        let ext: String
    }
}
```

**Must replicate these exact behaviors:**
- Sort: directories first, then alphabetical by name (case-sensitive, matching JS `localeCompare`)
- Root node at depth 0 is hidden from UI
- `expand()`: Lazy fetch on first expand only (`loaded` flag)
- `collapse()`: Remove descendants from array (walk forward while `depth > node.depth`)
- `addNode()`: Only if parent is found AND expanded; insert after parent's last descendant
- `removeNode()`: Remove node + all descendants
- `selectedPath` set only on file click, not directory click

**CORNER CASE**: Swift `String.localizedCompare` may differ from JS `localeCompare` on edge cases (emoji, accented chars). Use `String.compare(_:options:)` with no locale option for closest match.

#### CodeViewerViewModel

```swift
@Observable
public class CodeViewerViewModel {
    public var content: String = ""
    public var fileExtension: String = ""
    public var highlights: [HighlightRange] = []
    public var scrollToLine: Int? = nil

    public struct HighlightRange: Identifiable {
        public let id = UUID()
        let startLine: Int
        let endLine: Int
        let style: HighlightStyle
    }

    public enum HighlightStyle {
        case focus
        case highlight
    }
}
```

**Behaviors to replicate:**
- `goToLine(n)`: Clear existing highlights, add single-line highlight, scroll to center
- `highlight(start, end, style)`: Add range highlight (clamped to document line count)
- `clearHighlights()`: Remove all highlights
- Out-of-range line numbers silently ignored (line < 1 or line > lineCount)

#### DiffViewerViewModel

```swift
@Observable
public class DiffViewerViewModel {
    public var isVisible = false
    public var diffHTML: String = ""        // For WKWebView rendering
    public var title: String = "Diff View"
    public var outputFormat: DiffFormat = .sideBySide
    public var currentDiff: String? = nil

    public enum DiffFormat: String {
        case sideBySide = "side-by-side"
        case lineByLine = "line-by-line"
    }
}
```

**Behaviors:**
- `show()`: Set visible, render diff (use a WKWebView with diff2html JS or a native diff rendering)
- `clear()`: Hide, reset state, notify parent to show code viewer
- `toggle()`: Flip format and re-render. No-op if no diff shown.
- Default title: `"Diff View"` when title is empty/nil

**Implementation choice for diff rendering**: Since diff2html is a JS library, the simplest approach is to embed a `WKWebView` that loads diff2html from a bundled HTML template. Alternative: parse unified diff format natively and render in SwiftUI (more complex but fully native).

### 3.7 Views

#### FileBrowserView (main container)

```swift
public struct FileBrowserView: View {
    let configuration: FileBrowserConfiguration

    // Replicates the layout from client/index.html:
    // - Left sidebar: FileTreeView (collapsible)
    // - Right main area: CodeViewerView OR DiffViewerView (mutually exclusive)
}

public struct FileBrowserConfiguration {
    public let serverURL: URL           // Base URL for API
    public let webSocketURL: URL        // WebSocket URL
    public let rootPath: String         // Initial tree root (default "/")

    public init(serverURL: URL, webSocketURL: URL, rootPath: String = "/") { ... }
}
```

#### FileTreeView

- Uses `List` or `LazyVStack` for efficient scrolling
- Indentation via `.padding(.leading, CGFloat((node.depth - 1) * 16 + 8))`
- Directory rows: chevron icon (rotated when expanded) + folder icon + name
- File rows: spacer + file icon (colored by extension) + name
- Selected file has highlighted background
- Tap directory → toggle expand/collapse
- Tap file → set selected, fire callback

**CORNER CASE**: The icon colors must match `EXT_GRADIENTS` from tree.js (21 extension-to-color mappings). The folder gradient is blue (`#7C9CF5` → `#5A6FE6`). Default file color is gray (`#90A4AE` → `#607D8B`).

#### CodeViewerView

For syntax highlighting in Swift, options:
1. **Splash** or **Highlightr** library — supports many languages
2. **TextKit 2** with custom syntax tokens
3. **WKWebView** with CodeMirror (reuses exact same rendering)

Minimum requirements:
- Read-only text display with line numbers
- Syntax highlighting for: JS/JSX/TS/TSX, Python, HTML, CSS, JSON, Markdown
- Scroll-to-line with animation
- Line highlight decorations (two styles: focus and generic highlight)
- Dark theme (matching oneDark)

#### DiffViewerView

- Side-by-side and inline (line-by-line) diff display
- Toggle button to switch formats
- Close button to dismiss and show code viewer
- Header with title

### 3.8 Command Handler Wiring

The main `FileBrowserView` must wire command handlers to the dispatcher, replicating `client/main.js`:

```swift
func setupCommandHandlers() {
    dispatcher.on(.fileOpen) { [weak self] payload in
        let file = payload["file"] as! String
        let content = try await apiClient.fetchFile(path: file)
        self?.codeViewModel.setContent(content.content, extension: content.extension)
    }

    dispatcher.on(.viewportScroll) { [weak self] payload in
        let line = payload["line"] as! Int
        self?.codeViewModel.goToLine(line)
    }

    dispatcher.on(.decorationAdd) { [weak self] payload in
        let startLine = payload["startLine"] as! Int
        let endLine = payload["endLine"] as! Int
        let style = (payload["style"] as? String) == "focus" ? .focus : .highlight
        self?.codeViewModel.highlight(startLine, endLine, style: style)
    }

    dispatcher.on(.decorationClear) { [weak self] _ in
        self?.codeViewModel.clearHighlights()
    }

    dispatcher.on(.batch) { [weak self] payload in
        let commands = payload["commands"] as! [[String: Any]]
        for cmd in commands {
            let type = cmd["type"] as! String
            let cmdPayload = cmd["payload"] as? [String: Any] ?? [:]
            if let handler = self?.dispatcher.handlers[type] {
                try await handler(cmdPayload)
            }
        }
    }

    // ... diff.show, diff.clear, tree events (same logic as main.js)
}
```

**CRITICAL for tree events:**
- `parentPath` computation: `filePath.substring(0, filePath.lastIndexOf('/')) || '/'`
  In Swift: `String(path.prefix(upTo: path.lastIndex(of: "/") ?? path.startIndex))` — but must handle the `|| '/'` fallback when there's no `/`
- `file.changed` handler: Only reload if `selectedPath?.hasSuffix(filePath) == true` (mirrors `endsWith`)

---

## Part 4: Test Specifications

### 4.1 Server Library Tests

Port all 14 existing test files. Each test must verify the exact same behavior:

#### utils.test (8 tests)
1. `setRootDir` / `getRootDir` — sets and returns root directory
2. `resolveSecure` — resolves simple relative path within root
3. `resolveSecure` — returns root when no path given (null)
4. `resolveSecure` — returns root for empty string
5. `resolveSecure` — rejects `../` path traversal (throws PathTraversalError)
6. `resolveSecure` — rejects encoded traversal sequences like `subdir/../..`
7. `resolveSecure` — allows nested paths within root
8. `PathTraversalError` has status 403 and name "PathTraversalError"

#### routes/tree.test (6 tests)
1. Returns JSON tree with relative paths, root path is `"."`
2. Respects depth parameter (deeper directories not expanded)
3. Returns 403 for path traversal attempts
4. Returns 404 for non-existent directory
5. Lists files with relative paths and correct extensions
6. **Integration**: returned relative paths work for subsequent tree and file API calls (chained requests)

#### routes/file.test (6 tests)
1. Returns file content and metadata (content, name, extension, lineCount, size, mimeType)
2. Returns 400 when path is missing
3. Returns 404 for non-existent files
4. Returns 403 for path traversal attempts
5. Returns 413 for files over 5MB size limit
6. Detects correct MIME type for known extensions

#### routes/command.test (5 tests)
1. Sends command to specific client (with ACK)
2. Broadcasts when no clientId given (all clients receive)
3. Returns 400 when type is missing
4. Handles batch commands (broadcast mode) — all commands received in order
5. Handles batch with specific client (sequential with ACK)

#### routes/diff.test (6 tests)
1. `POST /api/diff` — returns diff string from two provided strings
2. `POST /api/diff` — diffs against file on disk when path provided
3. `POST /api/diff` — returns 400 when newContent is missing
4. `POST /api/diff` — returns 403 for path traversal
5. `POST /api/diff/send` — generates diff and returns ok with diffSize
6. `POST /api/diff/send` — returns 400 when content is missing

#### diff.test (5 tests)
1. Produces valid unified diff string with ---, +++, @@ markers
2. Handles empty strings (old is empty, new has content)
3. Handles identical strings (no change hunks)
4. Respects context option (larger context = more surrounding lines)
5. Includes file name in diff header

#### ws/handler.test (3 tests)
1. Accepts client connection and assigns UUID
2. Removes client from Map on disconnect
3. Handles multiple simultaneous connections (unique IDs)

#### ws/commands.test (5 tests)
1. `sendCommand` delivers message to specific client (with ACK)
2. `sendCommand` rejects when client not connected
3. `sendCommand` times out after 5 seconds if no ACK
4. `broadcastCommand` reaches all connected clients
5. `broadcastCommand` with specificClientId only sends to that client

#### watcher.test (4 tests)
1. Broadcasts `tree.fileAdded` when file created (path is relative)
2. Broadcasts `tree.fileRemoved` when file deleted
3. Broadcasts `file.changed` when file modified
4. Ignores `node_modules` and `.git` directories (no events broadcast)

### 4.2 iOS Library Tests (XCTest)

#### CommandsTests
1. All 13 command raw values match exact strings from protocol.js
2. CaseIterable count is 13
3. Codable round-trip preserves raw values

#### APIClientTests (use URLProtocol mocking)
1. `fetchTree` — correct URL encoding, parses FileNode response
2. `fetchFile` — correct URL encoding, parses FileContent response
3. `sendCommand` — correct POST body with type and payload
4. `sendDiff` — correct POST body
5. Error parsing — 400, 403, 404, 413, 500 responses map to correct FileBrowserError cases
6. Network failure maps to `.networkError`

#### WebSocketClientTests
1. Connects and receives clientId from "connected" message
2. Auto-reconnects on disconnect (verify delay timing)
3. Exponential backoff — delay increases by 1.5x, capped at 30s
4. Resets delay on successful reconnection
5. `close()` prevents further reconnection attempts
6. `send()` no-ops when not connected (no crash)
7. Malformed messages logged, not crashed
8. Message listeners all called for each message

#### CommandDispatcherTests
1. Routes commands to registered handlers
2. Sends "ok" ack on success
3. Sends "error" ack on handler failure
4. Ignores commands with no handler (no ack sent)
5. Filters out "connected" and "ack" message types

#### FileTreeViewModelTests
1. Loads tree from API response, correct flat array structure
2. Sort order: directories first, then alphabetical
3. Root node at depth 0 is not visible
4. Expand fetches children (only on first expand)
5. Collapse removes descendants from array
6. Re-expand after collapse doesn't re-fetch (loaded flag)
7. `addNode` inserts at correct position (after parent's last descendant)
8. `addNode` ignores if parent not expanded
9. `removeNode` removes node and all descendants
10. File click sets selectedPath, directory click doesn't

#### CodeViewerViewModelTests
1. `setContent` updates content and extension
2. `goToLine` sets scrollToLine, clears highlights, adds single highlight
3. `goToLine` ignores out-of-range (< 1 or > lineCount)
4. `highlight(start, end)` adds range, clamped to lineCount
5. `clearHighlights` removes all highlights
6. Style mapping: "focus" → .focus, anything else → .highlight

#### DiffViewerViewModelTests
1. `show()` sets isVisible, stores diff and options
2. `clear()` hides, resets state
3. `toggle()` flips format (side-by-side ↔ line-by-line)
4. `toggle()` no-ops when no diff shown
5. Default title is "Diff View"

---

## Part 5: Integration Checklist

Before considering the implementation complete:

- [ ] Server library can be `npm install`ed and mounted on an existing Express app with `app.use()`
- [ ] Server library WebSocket can be attached to an existing `http.Server`
- [ ] Server library route prefix is configurable and defaults to `/api/file-browser`
- [ ] Server library WS path is configurable and defaults to `/ws/file-browser`
- [ ] Server library does not use module-level global state (instance-scoped)
- [ ] iOS library can be added via Swift Package Manager
- [ ] iOS library provides a single `FileBrowserView` that can be embedded in any SwiftUI hierarchy
- [ ] iOS library connects to configurable server URL
- [ ] All 13 command types work end-to-end (server sends → iOS receives and renders)
- [ ] ACK mechanism works (iOS sends ack, server resolves sendCommand promise)
- [ ] File watcher events appear in real-time on iOS
- [ ] All 87 existing server tests pass (ported to new library structure)
- [ ] All iOS unit tests pass
- [ ] No existing host app routes/endpoints are affected
- [ ] No existing host app WebSocket connections are affected
