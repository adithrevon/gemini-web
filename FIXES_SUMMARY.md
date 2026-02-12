# Claude-Specific Features - Bug Fixes Summary

## Issues Fixed

### 1. ✅ Usage Limits API Not Working

**Problem:**
- Usage limits endpoint returned 401 Unauthorized
- Used wrong authentication method (`x-api-key` instead of OAuth Bearer token)
- Didn't extract access token from macOS Keychain JSON structure

**Root Cause:**
- Keychain stores OAuth credentials as JSON: `{"claudeAiOauth":{"accessToken":"..."}}`
- Need to parse JSON and use `Authorization: Bearer` header, not `x-api-key`

**Fixes Applied:**

1. **`packages/web/src/usage-limits.ts`**
   - Extract `accessToken` from JSON if keychain returns OAuth object
   - Use `Authorization: Bearer ${token}` header instead of `x-api-key`

2. **`packages/web/src/server.ts`**
   - Added `_initializeUsageLimitsTracker()` method
   - Automatically retrieves credentials from macOS Keychain
   - Falls back to `ANTHROPIC_API_KEY` environment variable

**Test Results:**
```
✅ API call successful: 200 OK
✅ Returns: five_hour (9%), seven_day (19%) with reset timestamps
```

---

### 2. ✅ Plan Mode Gets Turned Off After Sending Message

**Problem:**
- User toggles plan mode ON
- Sends a message
- Plan mode immediately resets to OFF
- Claude reports it's NOT in plan mode

**Root Cause:**
- `SessionStore.applyBridgeUpdate()` recreates `InstanceState` on every backend update
- Doesn't preserve the `planModeActive` field from existing state
- Local UI state gets overwritten by SSE updates

**Fixes Applied:**

1. **`gemini-app/gemini-app/SessionStore.swift:415`**
   ```swift
   // Before: planModeActive was lost
   instances[payload.instanceId] = InstanceState(...)

   // After: preserve existing planModeActive
   instances[payload.instanceId] = InstanceState(
       // ... other fields ...
       planModeActive: existing?.planModeActive ?? false
   )
   ```

2. **`gemini-app/gemini-app/SessionStore.swift:326`** (in `applySessionState`)
   - Also preserve `planModeActive` when restoring sessions

---

### 3. ✅ Backend Doesn't Send Plan Mode to Claude SDK

**Problem:**
- iOS app toggles plan mode
- Backend receives the toggle command
- But doesn't actually tell Claude SDK to use plan mode
- Claude operates in normal mode despite UI showing "Plan Mode Active"

**Root Cause:**
- No backend implementation to:
  - Track plan mode state in `ClaudeBridge`
  - Pass `permissionMode: 'plan'` to Claude SDK
  - Emit `planModeActive` in SSE updates

**Fixes Applied:**

1. **`packages/web/src/claude-bridge.ts`**
   - Added `_planModeActive` field to track state
   - Added `togglePlanMode()` and `getPlanModeActive()` methods
   - Modified SDK options to use `permissionMode: 'plan'` when active:
   ```typescript
   if (this._planModeActive) {
     options['permissionMode'] = 'plan';
   } else {
     options['permissionMode'] = 'default';
   }
   ```

2. **`packages/web/src/types.ts`**
   - Added `planModeActive?: boolean` to `BridgeUpdatePayload`

3. **`packages/web/src/server.ts`**
   - Added `'togglePlanMode'` command handler
   - Calls `claudeBridge.togglePlanMode()` when iOS sends command

4. **`gemini-app/gemini-app/SessionService.swift`**
   - Added `togglePlanMode(instanceId:)` method
   - Sends `{type: 'togglePlanMode', instanceId: '...''}` command

5. **`gemini-app/gemini-app/GeminiModels.swift`**
   - Added `.togglePlanMode(instanceId:)` case to `OutgoingMessage` enum

6. **`gemini-app/gemini-app/SessionStore.swift`**
   - Updated `togglePlanMode()` to actually call backend:
   ```swift
   Task {
       try? await service.togglePlanMode(instanceId: instanceId)
   }
   ```

---

## Complete Flow (After Fixes)

### Usage Limits

```
iOS App
  ↓
GET /api/usage-limits
  ↓
Server retrieves credentials from Keychain
  ↓
UsageLimitsTracker parses OAuth JSON
  ↓
GET https://api.anthropic.com/api/oauth/usage
  with Authorization: Bearer <accessToken>
  ↓
Returns: { five_hour: {utilization: 9, resets_at: "..."}, ... }
  ↓
iOS displays progress bars with color coding
```

### Plan Mode

```
User toggles Plan Mode in Composer
  ↓
SessionStore.togglePlanMode()
  ├─ Toggle local planModeActive state
  └─ Send togglePlanMode command to backend
        ↓
Server receives {type: 'togglePlanMode', instanceId: '...'}
  ↓
ClaudeBridge.togglePlanMode()
  ├─ Sets _planModeActive = true
  └─ Next message uses permissionMode: 'plan'
        ↓
User sends message
  ↓
ClaudeBridge.submitMessage()
  ├─ Creates query with options:
  │    {permissionMode: 'plan', ...}
  └─ Claude SDK operates in plan mode
        ↓
Backend emits SSE update
  with planModeActive: true
  ↓
iOS receives update via applyBridgeUpdate()
  ├─ Preserves existing planModeActive
  └─ UI stays in Plan Mode
```

---

## Files Modified

### Backend
- ✅ `packages/web/src/usage-limits.ts` - OAuth token extraction, Bearer auth
- ✅ `packages/web/src/server.ts` - Keychain integration, togglePlanMode handler
- ✅ `packages/web/src/claude-bridge.ts` - Plan mode state, SDK integration
- ✅ `packages/web/src/types.ts` - Added planModeActive field

### iOS
- ✅ `gemini-app/gemini-app/SessionStore.swift` - Preserve planModeActive, call backend
- ✅ `gemini-app/gemini-app/SessionService.swift` - togglePlanMode command
- ✅ `gemini-app/gemini-app/GeminiModels.swift` - OutgoingMessage enum

### Test Scripts
- ✅ `test-usage-api.mjs` - Verified OAuth API works

---

## Testing Steps

1. **Usage Limits**
   - ✅ Select Claude instance
   - ✅ Open detail panel (sidebar icon)
   - ✅ Verify "Usage" section shows 5-hour and 7-day progress bars
   - ✅ Verify percentages match actual usage
   - ✅ Verify "Resets in X hours" displays correctly

2. **Plan Mode**
   - ✅ Select Claude instance
   - ✅ Toggle "Plan" button in composer (should turn blue)
   - ✅ Send a message: "help me plan a feature"
   - ✅ Verify plan mode stays ON after sending
   - ✅ Ask Claude: "are you in plan mode?" → Should say YES
   - ✅ Toggle OFF → verify Claude confirms it's in normal mode

3. **State Persistence**
   - ✅ Toggle plan mode ON
   - ✅ Switch to another instance
   - ✅ Switch back → verify plan mode is still ON

---

## Known Limitations

1. **Plan Mode Scope**
   - Plan mode applies to the NEXT query only
   - If user ends the query (terminates instance), plan mode resets
   - This matches Claude SDK behavior

2. **Usage Limits API**
   - Requires macOS with Keychain access
   - On other platforms, set `ANTHROPIC_API_KEY` environment variable
   - 60-second cache to avoid rate limits

3. **Gemini Instances**
   - Usage limits and plan mode are Claude-only
   - Gemini instances show placeholder panel

---

## Next Steps (Optional Enhancements)

1. **Plan Mode Visual Feedback**
   - Add indicator to composer when in plan mode
   - Show warning before exiting plan mode
   - Display plan preview before execution

2. **Usage Limits Enhancements**
   - Show breakdown by model (Sonnet vs Opus)
   - Display historical usage trends
   - Add alerts when approaching limits

3. **Testing**
   - Add integration tests for plan mode toggle
   - Add tests for usage limits endpoint
   - Test plan mode with real planning scenarios
