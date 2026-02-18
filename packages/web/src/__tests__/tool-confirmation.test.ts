/**
 * Integration tests for the tool confirmation (approval) flow.
 *
 * Tests the ClaudeBridge confirm() logic:
 *  - emitting correct tool_status events
 *  - resolving pending promises
 *  - streaming_state transition when all confirmations resolved
 *  - handling confirm for unknown callId
 *  - multiple simultaneous pending confirmations
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeBridge } from '../claude-bridge/index.js';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/**
 * Helper: inject a fake pending confirmation into the bridge's private map
 * so we can test confirm() without needing a live SDK query.
 */
function injectPending(
  bridge: ClaudeBridge,
  callId: string,
): { promise: Promise<PermissionResult> } {
  const map = (bridge as any)._pendingConfirmations as Map<string, any>;
  let resolveFn!: (result: PermissionResult) => void;
  const promise = new Promise<PermissionResult>((resolve) => {
    resolveFn = resolve;
  });
  map.set(callId, {
    resolve: resolveFn,
    toolUseID: callId,
    input: { command: 'echo test' },
    suggestions: undefined,
  });
  return { promise };
}

describe('Tool Confirmation Flow', () => {
  let bridge: ClaudeBridge;

  beforeEach(() => {
    bridge = new ClaudeBridge({
      instanceId: 'test-instance',
      projectPath: '/tmp/test',
    });
  });

  // ─── confirm() with outcome 'proceed_once' ────────────────────────

  it('resolves with allow when outcome is proceed_once', async () => {
    const { promise } = injectPending(bridge, 'tool-1');

    await bridge.confirm('tool-1', 'proceed_once');

    const result = await promise;
    expect(result.behavior).toBe('allow');
    expect(result.toolUseID).toBe('tool-1');
  });

  it('emits tool_status approved for proceed_once', async () => {
    injectPending(bridge, 'tool-1');

    const events: { toolId: string; status: string }[] = [];
    bridge.on('tool_status', (e) => events.push(e));

    await bridge.confirm('tool-1', 'proceed_once');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ toolId: 'tool-1', status: 'approved' });
  });

  // ─── confirm() with outcome 'proceed_always' ──────────────────────

  it('resolves with allow + updatedPermissions for proceed_always', async () => {
    const map = (bridge as any)._pendingConfirmations as Map<string, any>;
    const fakeSuggestions = [{ type: 'tool', tool: 'Bash', permission: 'allow' }];
    let resolveFn!: (result: PermissionResult) => void;
    const promise = new Promise<PermissionResult>((resolve) => {
      resolveFn = resolve;
    });
    map.set('tool-2', {
      resolve: resolveFn,
      toolUseID: 'tool-2',
      input: { command: 'ls' },
      suggestions: fakeSuggestions,
    });

    await bridge.confirm('tool-2', 'proceed_always');

    const result = await promise;
    expect(result.behavior).toBe('allow');
    expect(result.updatedPermissions).toBe(fakeSuggestions);
  });

  // ─── confirm() with outcome 'cancel' ──────────────────────────────

  it('resolves with deny when outcome is cancel', async () => {
    const { promise } = injectPending(bridge, 'tool-3');

    await bridge.confirm('tool-3', 'cancel');

    const result = await promise;
    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('User denied');
  });

  it('emits tool_status denied for cancel', async () => {
    injectPending(bridge, 'tool-3');

    const events: { toolId: string; status: string }[] = [];
    bridge.on('tool_status', (e) => events.push(e));

    await bridge.confirm('tool-3', 'cancel');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ toolId: 'tool-3', status: 'denied' });
  });

  // ─── confirm() for unknown callId ──────────────────────────────────

  it('does nothing for unknown callId', async () => {
    const events: unknown[] = [];
    bridge.on('tool_status', (e) => events.push(e));
    bridge.on('streaming_state', (e) => events.push(e));

    await bridge.confirm('nonexistent', 'proceed_once');

    expect(events).toHaveLength(0);
  });

  // ─── streaming_state transition ────────────────────────────────────

  it('emits streaming_state responding when last confirmation resolved', async () => {
    injectPending(bridge, 'tool-a');

    const states: string[] = [];
    bridge.on('streaming_state', (e: { state: string }) => states.push(e.state));

    await bridge.confirm('tool-a', 'proceed_once');

    expect(states).toContain('responding');
  });

  it('does NOT emit streaming_state when confirmations still pending', async () => {
    injectPending(bridge, 'tool-a');
    injectPending(bridge, 'tool-b');

    const states: string[] = [];
    bridge.on('streaming_state', (e: { state: string }) => states.push(e.state));

    // Resolve only the first — tool-b is still pending
    await bridge.confirm('tool-a', 'proceed_once');

    expect(states).toHaveLength(0);
  });

  it('emits streaming_state after ALL confirmations resolved', async () => {
    injectPending(bridge, 'tool-a');
    injectPending(bridge, 'tool-b');
    injectPending(bridge, 'tool-c');

    const states: string[] = [];
    bridge.on('streaming_state', (e: { state: string }) => states.push(e.state));

    await bridge.confirm('tool-a', 'proceed_once');
    expect(states).toHaveLength(0);

    await bridge.confirm('tool-b', 'cancel');
    expect(states).toHaveLength(0);

    await bridge.confirm('tool-c', 'proceed_always');
    expect(states).toHaveLength(1);
    expect(states[0]).toBe('responding');
  });

  // ─── mixed outcomes in multi-tool scenario ─────────────────────────

  it('each tool gets its own correct resolution in multi-tool scenario', async () => {
    const p1 = injectPending(bridge, 'tool-1');
    const p2 = injectPending(bridge, 'tool-2');
    const p3 = injectPending(bridge, 'tool-3');

    // Resolve in non-sequential order with different outcomes
    await bridge.confirm('tool-2', 'cancel');
    await bridge.confirm('tool-3', 'proceed_always');
    await bridge.confirm('tool-1', 'proceed_once');

    const r1 = await p1.promise;
    const r2 = await p2.promise;
    const r3 = await p3.promise;

    expect(r1.behavior).toBe('allow');
    expect(r2.behavior).toBe('deny');
    expect(r3.behavior).toBe('allow');
  });

  // ─── double confirm same callId ────────────────────────────────────

  it('second confirm for same callId is a no-op', async () => {
    const { promise } = injectPending(bridge, 'tool-1');

    const events: { toolId: string; status: string }[] = [];
    bridge.on('tool_status', (e) => events.push(e));

    await bridge.confirm('tool-1', 'proceed_once');
    await bridge.confirm('tool-1', 'cancel'); // should be a no-op

    const result = await promise;
    expect(result.behavior).toBe('allow'); // first confirm wins
    expect(events).toHaveLength(1); // only one event emitted
  });

  // ─── pending confirmations cleaned up on destroy ───────────────────

  it('destroy rejects all pending confirmations', async () => {
    const p1 = injectPending(bridge, 'tool-1');
    const p2 = injectPending(bridge, 'tool-2');

    bridge.destroy();

    const r1 = await p1.promise;
    const r2 = await p2.promise;

    expect(r1.behavior).toBe('deny');
    expect(r1.message).toBe('Session terminated');
    expect(r2.behavior).toBe('deny');
    expect(r2.message).toBe('Session terminated');
  });
});
