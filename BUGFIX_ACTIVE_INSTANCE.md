# Bug Fix: Active Instance Routing After Restart

## Problem

After server restart, when entering a message in a Claude conversation, the message would go to a different Gemini conversation instead. This was caused by the `activeInstanceId` being incorrectly overwritten during instance restoration.

## Root Cause

During session restoration in `_loadPersistedSessions()`:

1. ✅ Session created with correct `activeInstanceId` from persisted data
2. ✅ Claude instances restored correctly (manually created, no issue)
3. ❌ Gemini instances restored via `_spawnGeminiInstance()` which **overwrote** `session.activeInstanceId = instanceId` (line 549)

Result: The last Gemini instance restored became the active one, regardless of which conversation was actually active before shutdown.

## Fix

Added `isRestoring` parameter to both spawn methods:

```typescript
private async _spawnGeminiInstance(
  instanceId: string,
  projectPath: string,
  sessionId: string,
  resolvedPath: string,
  yolo = false,
  resumeSessionId?: string,
  isRestoring = false,  // NEW
): Promise<void>
```

And only set `activeInstanceId` when creating NEW instances:

```typescript
const session = this.sessions.get(sessionId);
if (session) {
  session.instances.add(instanceId);
  // Only set as active instance when creating NEW instances, not when restoring
  if (!isRestoring) {
    session.activeInstanceId = instanceId;
  }
}
```

When restoring, `_restoreGeminiInstance` now passes `isRestoring = true`:

```typescript
await this._spawnGeminiInstance(
  instData.id,
  instData.projectPath,
  sessionId,
  instData.projectPath,
  false,
  instData.geminiSessionId,
  true, // isRestoring = true
);
```

## Testing

After this fix:

1. Create multiple conversations (e.g., 1 Claude + 1 Gemini)
2. Set Claude conversation as active
3. Restart server
4. Send message to Claude conversation
5. ✅ Message should go to Claude, not Gemini

## Additional Logging

Added logging to verify activeInstanceId preservation:

```
[web] Session restored {
  sessionId: 'abc12345',
  activeInstanceId: 'xyz67890',
  instanceCount: 2
}
```

This helps verify the correct instance remains active after restoration.
