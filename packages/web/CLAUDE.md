# gemini-web Package Development Guidelines

## Testing Requirements

### Integration Tests Are Required for All New Features

**IMPORTANT:** Every new feature MUST include integration tests before merging.

#### When Tests Are Required

✅ **Always write tests for:**

- New API endpoints or routes
- State management changes (sessions, instances, persistence)
- Multi-instance or multi-session scenarios
- Message routing logic
- Provider implementations (Gemini, Claude)
- Data persistence and restoration
- Error handling and edge cases

❌ **Do NOT merge without tests for:**

- Features that affect session/instance lifecycle
- Changes to persistence or restoration logic
- Modifications to message routing
- Multi-entity scenarios (multiple instances/sessions)

#### Test Coverage Standards

- **Minimum coverage:** 80% for new code
- **Critical paths:** 100% coverage required for:
  - Session persistence/restoration
  - Message routing
  - Instance lifecycle
  - Cross-session isolation

#### Test Location

Place all integration tests in:

```
packages/web/src/__tests__/
```

#### Test Files

- `server.test.ts` - HTTP API endpoints, session management
- `claude-bridge.test.ts` - Claude SDK integration
- `persistence.test.ts` - Session persistence and restoration
- Add new files for new features (e.g., `auth.test.ts`)

#### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run specific test file
npm test -- server.test.ts

# Check coverage
npm test -- --coverage
```

#### Example Test Structure

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, post, collectSseEvents } from './helpers.js';
import type { TestServer } from './helpers.js';

describe('Feature Name', () => {
  let t: TestServer;

  beforeAll(async () => {
    t = await startTestServer();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it('does the thing correctly', async () => {
    // Arrange: Set up test state
    const session = await post(t.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    // Act: Perform the action
    const result = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'myCommand',
      data: 'test',
    });

    // Assert: Verify the outcome
    expect(result.status).toBe(200);
    expect(result.json?.['success']).toBe(true);
  });

  it('handles error cases', async () => {
    // Test error handling
  });
});
```

#### Multi-Instance Test Pattern

**CRITICAL:** Always test multi-instance scenarios for features that affect
routing or state:

```typescript
it('handles multiple instances correctly', async () => {
  // Spawn multiple instances
  const instance1 = await spawnInstance(session, 'claude', '/tmp/proj1');
  const instance2 = await spawnInstance(session, 'gemini', '/tmp/proj2');

  // Set active instance
  await setActiveInstance(session, instance1);

  // Verify behavior is correct for BOTH instances
  // Verify messages route to the CORRECT instance
  // Verify state isolation between instances
});
```

#### Restoration Test Pattern

**CRITICAL:** Test server restart for any persistence-related features:

```typescript
it('restores state correctly after server restart', async () => {
  // Create initial state
  const session = await createSession();
  const instance = await spawnInstance(session, 'claude', '/tmp');

  // Wait for persistence
  await new Promise((r) => setTimeout(r, 6000));

  // Restart server
  await t.cleanup();
  t = await startTestServer();

  // Verify state was restored correctly
  const restored = await getSession(session.id);
  expect(restored.instances).toContain(instance.id);
});
```

## Why This Matters

### Recent Bug Example

The `activeInstanceId` bug (Feb 2026) was caused by missing integration tests:

**What happened:**

- Persistence feature added WITHOUT tests
- Bug in multi-instance restoration went undetected
- Messages routed to wrong conversation after server restart

**What was missing:**

- No test for multi-instance restoration
- No test for activeInstanceId preservation
- No test for message routing validation

**The fix:**

- Added `isRestoring` parameter to prevent overwriting activeInstanceId
- Added comprehensive persistence tests (`persistence.test.ts`)
- Now have 100% coverage for restoration logic

### Test-First Development

For complex features, consider **Test-Driven Development (TDD)**:

1. **Write failing test** - Define expected behavior
2. **Implement feature** - Make test pass
3. **Refactor** - Clean up while tests still pass

This ensures:

- ✅ Feature works as expected
- ✅ Edge cases are handled
- ✅ Regressions are caught immediately
- ✅ Code is testable by design

## Code Review Checklist

Before submitting a PR, verify:

- [ ] All new features have integration tests
- [ ] Tests cover happy path AND error cases
- [ ] Multi-instance scenarios are tested (if applicable)
- [ ] Persistence/restoration is tested (if applicable)
- [ ] Tests pass locally (`npm test`)
- [ ] No tests are skipped or disabled
- [ ] Test coverage meets 80% minimum
- [ ] Critical paths have 100% coverage

## Getting Help

If you're unsure what tests to write:

1. Look at existing test files for patterns
2. Check `TEST_GAP_ANALYSIS.md` for examples
3. Ask in code review: "What scenarios should I test?"

## Test Helpers Available

**`helpers.ts` provides:**

- `startTestServer()` - Spin up test server
- `post(url, path, body)` - HTTP POST requests
- `get(url, path)` - HTTP GET requests
- `collectSseEvents(url, sessionId, timeout)` - Collect SSE events
- `MockCliClient` - Mock Gemini CLI WebSocket client

Use these helpers to keep tests concise and maintainable.
