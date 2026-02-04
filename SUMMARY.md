# Web Bridge Implementation Summary

## Goal
Build a web-based chat UI that controls the Gemini CLI while keeping Ink UI changes minimal. The web UI should show streaming assistant messages, tool calls/results, and allow users to submit prompts through the CLI backend.

## What Was Built

### 1) CLI Bridge (Ink side)
- **New file**: `packages/cli/src/ui/components/WebBridge.tsx`
- **Mounted in**: `packages/cli/src/ui/App.tsx`
- **Behavior**:
  - Renders `null` (no UI impact).
  - Reads state from `UIStateContext`.
  - Serializes JSON-safe data only (messages + tool calls + tool outputs).
  - Streams updates over WebSocket to the web UI.
  - Accepts `submit` messages and calls `handleFinalSubmit()` directly (bypasses stdin/keystrokes).
  - Accepts `confirm` messages to resolve tool confirmation prompts.

### 2) Web Server (Relay + CLI Spawner)
- **New package**: `packages/web`
- **Server**: `packages/web/server.mjs`
- **Behavior**:
  - Serves static files from `packages/web/public`.
  - Hosts a WebSocket endpoint `/ws`.
  - Spawns the CLI process (prefers `packages/cli/dist/index.js`, falls back to `bundle/gemini.js`).
  - Relays `bridge:update` events to all web clients.
  - Forwards `submit` and `confirm` events from web → CLI bridge.

### 3) Web UI
- **Files**: `packages/web/public/index.html`, `app.js`, `styles.css`
- **Behavior**:
  - Connects to `/ws` and shows a live chat UI.
  - Renders:
    - User messages
    - Assistant streaming messages
    - Tool calls + results
  - Submits messages by sending `{ type: "submit", text }` (no stdin/ANSI injection).
  - Renders tool confirmation prompts (Allow once / Allow for session / No, suggest changes).
  - Sends `{ type: "confirm", callId, outcome, correlationId }` back to the CLI.

## Why This Approach
- **Minimal Ink changes**: One new component + one import.
- **Safe serialization**: Avoids passing functions or non-serializable values.
- **Stable input**: Directly invoking `handleFinalSubmit` avoids keystroke parsing, paste heuristics, and terminal focus escape sequences.
- **Separation of concerns**: Web UI is isolated in `packages/web`.

## Runtime Flow
1. `packages/web/server.mjs` starts and spawns the CLI.
2. CLI starts Ink UI and mounts `WebBridge`.
3. `WebBridge` streams state to the server via WebSocket.
4. Web UI renders live updates.
5. When the user submits:
   - Web UI sends `{ type: "submit", text }`.
   - Bridge calls `handleFinalSubmit(text)` inside CLI.
   - CLI processes and streams output back to UI.

## How To Run
```
npm run build --workspace @google/gemini-cli
npm run dev --workspace packages/web
```
Open http://localhost:7337 in a new window.

## Current Status / Remaining Work
- Confirmation UI is now rendered in the web UI and sends confirm messages.
- If confirmation clicks appear to be no-ops, verify:
  - CLI dist is rebuilt so `WebBridge` has confirm handling.
  - Debug logs show `confirm from web` (server) and `confirm` (web-bridge).
  - `correlationId` is present in tool snapshots and forwarded by the web UI.
