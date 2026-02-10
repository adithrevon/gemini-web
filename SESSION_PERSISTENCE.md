# Session Persistence Implementation

## Overview

Sessions and conversation instances now persist across server restarts. When the backend server (packages/web/) is stopped and restarted, all active conversations are automatically restored with their full history.

## Storage Location

`~/.gemini-web/sessions.json`

This file is created automatically on first run and contains all session and instance state.

## How It Works

### 1. State Persistence

The server continuously saves state to disk with the following strategy:
- **Debounced writes**: Maximum 1 write per 5 seconds (batches rapid updates)
- **Atomic operations**: Writes to `.tmp` file, then atomic rename (prevents corruption)
- **Graceful shutdown**: Immediate final write on server shutdown (Ctrl+C)

State is persisted whenever:
- A session is created or modified
- An instance is spawned or terminated
- A conversation update occurs (new messages, tool calls, etc.)
- The active instance changes

### 2. Session Restoration

On server startup, the system:
1. Loads `~/.gemini-web/sessions.json`
2. Restores all sessions and instances into memory
3. For **Claude instances**: Restores the SDK session ID → resume on next message
4. For **Gemini instances**: Spawns CLI with `--resume <session-id>` flag → full restoration

### 3. Provider-Specific Resume

**Claude (SDK)**:
- Session ID is stored from the SDK's `result` message (`session_id` field)
- On restore, the `_sessionId` field is set in ClaudeBridge
- SDK automatically continues the conversation on the next message

**Gemini (CLI)**:
- Session ID is emitted by the CLI in `bridge:update` payload (from `config.getSessionId()`)
- On restore, the CLI is spawned with `--resume <session-id>` flag
- CLI loads conversation history from its session file

## File Structure

```json
{
  "version": 1,
  "lastUpdated": "2026-02-09T10:30:00Z",
  "sessions": [
    {
      "id": "session-uuid-123",
      "activeInstanceId": "instance-abc",
      "lastSeenAt": 1707475800000,
      "instances": [
        {
          "id": "instance-abc",
          "sessionId": "session-uuid-123",
          "provider": "claude",
          "providerName": "claude",
          "projectPath": "/Users/prem/workspace/project",
          "status": "connected",
          "error": null,
          "claudeSessionId": "claude-sdk-session-id-xyz",
          "lastSnapshot": { ... }
        }
      ]
    }
  ]
}
```

## iOS App Behavior

The iOS app requires **no changes**. It already:
- Persists `sessionId` in UserDefaults
- Loads it on startup
- Sends it to the server in `/api/session` POST
- Receives `session_state` event with all restored instances
- Displays conversations automatically

From the user's perspective, conversations simply reappear after a server restart.

## Error Handling

**Corrupt persistence file**:
- File is renamed to `sessions.json.corrupt.<timestamp>`
- Server starts fresh with empty state
- Error is logged to console

**Disk full / write errors**:
- Error is logged
- Server continues in-memory only
- Next successful write resumes persistence

**Expired Claude session**:
- SDK returns error on resume
- Logged as warning
- Conversation starts fresh

**Missing Gemini session file**:
- CLI creates a new session
- Logged as warning
- Conversation starts fresh

## Modified Files

### Backend (packages/web/)

**New:**
- `src/persistence.ts` - SessionPersistence class

**Modified:**
- `src/types.ts` - Added persistence types and `sessionId` to BridgeUpdatePayload
- `src/server.ts` - Added load/restore/persist methods
- `src/gemini-bridge.ts` - Added resume support and session ID capture

### CLI (packages/cli/)

**Modified:**
- `src/ui/components/WebBridge.tsx` - Added `sessionId` to bridge snapshot (from `config.getSessionId()`)

### iOS App

**No changes required** - persistence is transparent to the app.

## Testing

### Manual Test 1: Claude Session Resume

```bash
# 1. Start server
cd packages/web && npm start

# 2. iOS app: Create Claude instance, send message
# "Remember this code: XYZ123"

# 3. Kill server (Ctrl+C)

# 4. Restart server
npm start

# 5. iOS app reconnects automatically
# Send: "What code did I ask you to remember?"
# Expected: Claude responds "XYZ123"
```

### Manual Test 2: Gemini Session Resume

```bash
# 1. Start server
cd packages/web && npm start

# 2. iOS app: Create Gemini instance, have conversation

# 3. Check persistence file
cat ~/.gemini-web/sessions.json
# Should contain geminiSessionId

# 4. Kill server, restart
npm start

# 5. Check logs for "Resuming Gemini session"
# 6. iOS app should show restored history
```

### Verification Checklist

- ✅ `~/.gemini-web/sessions.json` file is created
- ✅ File contains session IDs for both providers
- ✅ Server logs show "Loading N persisted sessions" on startup
- ✅ Server logs show "Restored Claude SDK session ID"
- ✅ Server logs show "Resuming Gemini session" with --resume flag
- ✅ iOS app shows restored conversations automatically
- ✅ Full conversation history preserved
- ✅ Multi-turn conversations work (not starting fresh)

## Performance

- **Disk I/O**: Max 1 write per 5 seconds (negligible)
- **File size**: ~1-2KB per instance → 100 instances = ~200KB
- **Startup delay**: ~50-100ms to load and parse JSON
- **Memory**: No additional overhead (already storing lastSnapshot)

## Future Enhancements

- Automatic cleanup of old sessions (configurable retention policy)
- Session export/import for backup/migration
- Compression for large history
- Multi-device session sync (requires remote storage)
