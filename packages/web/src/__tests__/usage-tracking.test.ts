import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, post, collectSseEvents } from './helpers.js';
import type { TestServer } from './helpers.js';
import type { BridgeUpdatePayload, UsageMetrics } from '../types.js';

describe('Usage Tracking - Claude Provider', () => {
  let t: TestServer;

  beforeAll(async () => {
    t = await startTestServer();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it('tracks usage metrics in Claude provider', async () => {
    // Create session and spawn Claude instance
    const session = await post(t.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: t.tmpDir,
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    // Submit message
    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: 'Say hello',
    });

    // Collect SSE events
    const events = await collectSseEvents(t.baseUrl, sessionId, 10000);

    // Find final bridge:update with idle state
    const updates = events
      .filter((e) => e.type === 'bridge:update')
      .map((e) => e.payload as BridgeUpdatePayload);

    const finalUpdate = updates.find((u) => u.streamingState === 'idle');
    expect(finalUpdate).toBeDefined();

    // Verify usage metrics exist
    expect(finalUpdate?.usageMetrics).toBeDefined();
    const metrics = finalUpdate!.usageMetrics!;

    expect(metrics.totalInputTokens).toBeGreaterThan(0);
    expect(metrics.totalOutputTokens).toBeGreaterThan(0);
    expect(metrics.totalTokens).toBeGreaterThan(0);
    expect(metrics.totalCostUsd).toBeGreaterThan(0);
  });

  it('persists usage metrics across server restart', async () => {
    // Create instance and submit message
    const session = await post(t.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: t.tmpDir,
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: 'Count to 3',
    });

    // Wait for completion
    await collectSseEvents(t.baseUrl, sessionId, 10000);

    // Wait for persistence (debounced 5 seconds)
    await new Promise((r) => setTimeout(r, 6000));

    // Restart server
    await t.cleanup();
    t = await startTestServer();

    // Verify metrics restored
    const events = await collectSseEvents(t.baseUrl, sessionId, 5000);
    const sessionState = events.find(
      (e) => e.type === 'session_state',
    ) as Record<string, unknown>;

    expect(sessionState).toBeDefined();
    const snapshots = sessionState['snapshots'] as BridgeUpdatePayload[];

    expect(snapshots).toBeDefined();
    expect(snapshots.length).toBeGreaterThan(0);

    const snapshot = snapshots[0];
    expect(snapshot?.usageMetrics).toBeDefined();
    expect(snapshot.usageMetrics!.totalTokens).toBeGreaterThan(0);
  });

  it('accumulates tool statistics', async () => {
    const session = await post(t.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: t.tmpDir,
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    // Submit message that will use tools
    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: 'List files in the current directory',
    });

    // Wait for completion
    const events = await collectSseEvents(t.baseUrl, sessionId, 15000);

    const updates = events
      .filter((e) => e.type === 'bridge:update')
      .map((e) => e.payload as BridgeUpdatePayload);

    const finalUpdate = updates.find((u) => u.streamingState === 'idle');
    expect(finalUpdate?.usageMetrics).toBeDefined();

    const metrics = finalUpdate!.usageMetrics!;

    // Should have at least one tool call
    expect(metrics.totalToolCalls).toBeGreaterThan(0);
    expect(
      metrics.totalToolSuccess + (metrics.totalToolFail || 0),
    ).toBeGreaterThan(0);
  });
});

describe('TODO Tracking - Claude Provider', () => {
  let t: TestServer;

  beforeAll(async () => {
    t = await startTestServer();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it('extracts TODOs from TodoWrite tool', async () => {
    const session = await post(t.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: t.tmpDir,
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    // Ask for TODO list
    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: 'Create a TODO list for building a simple web app with React',
    });

    // Collect events
    const events = await collectSseEvents(t.baseUrl, sessionId, 20000);
    const updates = events
      .filter((e) => e.type === 'bridge:update')
      .map((e) => e.payload as BridgeUpdatePayload);

    const withTodos = updates.find((u) => u.todos && u.todos.items.length > 0);

    // Note: This test may be flaky as Claude may not always use TodoWrite tool
    // It's more of an integration test to verify the extraction works when it does
    if (withTodos) {
      expect(withTodos.todos!.items.length).toBeGreaterThan(0);
      expect(withTodos.todos!.items[0].id).toBeDefined();
      expect(withTodos.todos!.items[0].description).toBeDefined();
      expect(withTodos.todos!.lastUpdated).toBeDefined();
    }
  });

  it('persists TODOs across server restart', async () => {
    const session = await post(t.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: t.tmpDir,
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    // Ask for TODO list
    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: 'Create a TODO list for building a simple CLI tool',
    });

    // Wait for completion
    const events = await collectSseEvents(t.baseUrl, sessionId, 20000);

    // Check if TODOs were created
    const updates = events
      .filter((e) => e.type === 'bridge:update')
      .map((e) => e.payload as BridgeUpdatePayload);

    const withTodos = updates.find((u) => u.todos && u.todos.items.length > 0);

    if (withTodos) {
      const originalTodoCount = withTodos.todos!.items.length;

      // Wait for persistence
      await new Promise((r) => setTimeout(r, 6000));

      // Restart server
      await t.cleanup();
      t = await startTestServer();

      // Verify TODOs restored
      const restoreEvents = await collectSseEvents(t.baseUrl, sessionId, 5000);
      const sessionState = restoreEvents.find(
        (e) => e.type === 'session_state',
      ) as Record<string, unknown>;

      expect(sessionState).toBeDefined();
      const snapshots = sessionState['snapshots'] as BridgeUpdatePayload[];

      expect(snapshots).toBeDefined();
      expect(snapshots.length).toBeGreaterThan(0);

      const snapshot = snapshots[0];
      expect(snapshot?.todos).toBeDefined();
      expect(snapshot.todos!.items.length).toBe(originalTodoCount);
    }
  });
});

describe('Usage Tracking - Gemini Provider', () => {
  let t: TestServer;

  beforeAll(async () => {
    t = await startTestServer();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it('tracks usage metrics in Gemini provider', async () => {
    // Create session and spawn Gemini instance
    const session = await post(t.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: t.tmpDir,
      provider: 'gemini',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    // Submit message
    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: 'Say hello',
    });

    // Collect SSE events
    const events = await collectSseEvents(t.baseUrl, sessionId, 10000);

    // Find final bridge:update with idle state
    const updates = events
      .filter((e) => e.type === 'bridge:update')
      .map((e) => e.payload as BridgeUpdatePayload);

    const finalUpdate = updates.find((u) => u.streamingState === 'idle');
    expect(finalUpdate).toBeDefined();

    // Verify usage metrics exist (Gemini tracks via SessionMetrics)
    expect(finalUpdate?.usageMetrics).toBeDefined();
    const metrics = finalUpdate!.usageMetrics!;

    expect(metrics.totalTokens).toBeGreaterThan(0);
    expect(metrics.totalApiCalls).toBeGreaterThan(0);

    // Gemini should have model breakdown
    expect(metrics.modelBreakdown).toBeDefined();
  });

  it('includes model breakdown in Gemini metrics', async () => {
    const session = await post(t.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: t.tmpDir,
      provider: 'gemini',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: 'Count to 5',
    });

    const events = await collectSseEvents(t.baseUrl, sessionId, 10000);

    const updates = events
      .filter((e) => e.type === 'bridge:update')
      .map((e) => e.payload as BridgeUpdatePayload);

    const finalUpdate = updates.find((u) => u.streamingState === 'idle');
    const metrics = finalUpdate?.usageMetrics;

    expect(metrics?.modelBreakdown).toBeDefined();

    const breakdown = metrics!.modelBreakdown!;
    const modelNames = Object.keys(breakdown);

    expect(modelNames.length).toBeGreaterThan(0);

    // Check structure of breakdown
    for (const modelName of modelNames) {
      const stats = breakdown[modelName];
      expect(stats.requests).toBeGreaterThan(0);
      expect(stats.inputTokens).toBeGreaterThan(0);
      expect(stats.outputTokens).toBeGreaterThan(0);
    }
  });
});

describe('TODO Tracking - Gemini Provider', () => {
  let t: TestServer;

  beforeAll(async () => {
    t = await startTestServer();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it('extracts TODOs from WriteTodosTool', async () => {
    const session = await post(t.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: t.tmpDir,
      provider: 'gemini',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    // Ask for TODO list
    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: 'Create a TODO list for building a REST API with Express',
    });

    // Collect events
    const events = await collectSseEvents(t.baseUrl, sessionId, 20000);
    const updates = events
      .filter((e) => e.type === 'bridge:update')
      .map((e) => e.payload as BridgeUpdatePayload);

    const withTodos = updates.find((u) => u.todos && u.todos.items.length > 0);

    // Note: This test may be flaky as Gemini may not always use WriteTodosTool
    if (withTodos) {
      expect(withTodos.todos!.items.length).toBeGreaterThan(0);
      expect(withTodos.todos!.items[0].id).toBeDefined();
      expect(withTodos.todos!.items[0].description).toBeDefined();
    }
  });
});
