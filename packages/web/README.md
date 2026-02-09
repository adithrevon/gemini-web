# gemini-web

Backend API server for the Gemini iOS app. Manages sessions, spawns Gemini CLI
instances (via WebSocket) and Claude Agent SDK instances, and streams updates to
the iOS client over Server-Sent Events.

## Quick Start

```bash
npm install
npm run dev          # Start with tsx (development)
npm run build        # Compile TypeScript
npm start            # Run compiled JS
```

## Scripts

| Script          | Description                                        |
| --------------- | -------------------------------------------------- |
| `npm run dev`   | Run from source with tsx                           |
| `npm start`     | Run compiled output from `dist/`                   |
| `npm run build` | Compile TypeScript to `dist/`                      |
| `npm test`      | Run integration + unit tests with vitest           |
| `npm run typecheck` | Type-check without emitting                    |
| `npm run start:debug` | Run with debug + CLI log output enabled      |

## Environment Variables

| Variable                      | Default  | Description                                |
| ----------------------------- | -------- | ------------------------------------------ |
| `GEMINI_WEB_PORT`             | `7337`   | HTTP server port                           |
| `GEMINI_WEB_WS_PATH`         | `/ws`    | WebSocket endpoint path                    |
| `GEMINI_WEB_SPAWN_TIMEOUT_MS` | `18000` | CLI connect timeout (ms)                   |
| `GEMINI_WEB_DEBUG`            | -        | Set to `1` for console debug logging       |
| `GEMINI_WEB_CLI_LOG`          | -        | Set to `1` to pipe CLI stdout to terminal  |
| `GEMINI_WEB_CLI_PATH`         | -        | Override path to Gemini CLI entry point     |
| `GEMINI_WEB_CLI_ARGS`         | -        | Extra CLI arguments (space-separated)      |

## Architecture

```
iOS App
  ↕ HTTP/SSE
GeminiWebServer (src/server.ts)
  ├── GeminiBridge (src/gemini-bridge.ts) ← WebSocket → Gemini CLI process
  └── ClaudeBridge (src/claude-bridge.ts) ← Claude Agent SDK (in-process)
```

### Provider Interface

Both bridges implement a common `Provider` interface (`src/provider.ts`):

```typescript
interface Provider {
  readonly name: ProviderName;
  start(): Promise<void>;
  submitMessage(text: string): Promise<void>;
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
  confirm(callId: string, outcome: string, correlationId?: string): Promise<void>;
  destroy(): void;
  getSnapshot(): BridgeUpdatePayload;
}
```

The server routes all commands through this interface. Adding a new provider
means implementing `Provider` and registering it in `spawnInstance`.

### File Structure

```
src/
  index.ts           # Entry point: config from env, create server, listen
  types.ts           # All shared types (protocol, commands, SSE events)
  server.ts          # GeminiWebServer: HTTP, SSE, sessions, command routing
  ws-handler.ts      # WebSocket connection handler (CLI ↔ GeminiBridge)
  provider.ts        # Provider interface
  gemini-bridge.ts   # GeminiBridge: CLI spawn + WS relay
  claude-bridge.ts   # ClaudeBridge: SDK, accumulator, async queue
  logger.ts          # Structured file + console logger
  utils.ts           # readJsonBody, sendJson, expandTilde, etc.
  __tests__/
    helpers.ts           # Test server, mock CLI client, SSE collector
    server.test.ts       # Integration tests (HTTP, SSE, WS, both providers)
    claude-bridge.test.ts # Unit tests (accumulator, queue)
```

## API Endpoints

| Method | Path                              | Description                 |
| ------ | --------------------------------- | --------------------------- |
| GET    | `/health`                         | Health check                |
| POST   | `/api/session`                    | Create or resume a session  |
| GET    | `/api/session/:id/events`         | SSE event stream            |
| POST   | `/api/session/:id/command`        | Send a command              |
| GET    | `/api/browse?path=...`            | Browse directories          |
| GET    | `/api/validate-path?path=...`     | Validate a directory path   |

### Commands (via `/api/session/:id/command`)

| type               | Required fields                     |
| ------------------ | ----------------------------------- |
| `spawnInstance`    | `projectPath`, optional `provider`  |
| `terminateInstance`| `instanceId`                        |
| `setActiveInstance`| `instanceId`                        |
| `submit`           | `instanceId`, `text`                |
| `confirm`          | `instanceId`, `callId`, `outcome`   |
| `setModel`         | `instanceId`, `model`               |
| `interrupt`        | `instanceId`                        |

## Logging

Logs are written to `~/.gemini-web/logs/server-YYYY-MM-DD.log` (always on).
Set `GEMINI_WEB_DEBUG=1` for console output. Set `GEMINI_WEB_CLI_LOG=1` to see
CLI process stdout in the terminal.
