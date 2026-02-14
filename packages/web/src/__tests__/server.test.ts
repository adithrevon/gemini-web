import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startTestServer,
  post,
  get,
  collectSseEvents,
} from './helpers.js';
import type { TestServer } from './helpers.js';

let t: TestServer;

beforeAll(async () => {
  t = await startTestServer();
});

afterAll(async () => {
  await t.cleanup();
});

describe('Health & Sessions', () => {
  it('GET /health returns 200 ok', async () => {
    const r = await get(t.baseUrl, '/health');
    expect(r.status).toBe(200);
    expect(r.json?.['status']).toBe('ok');
  });

  it('POST /api/session creates a new session', async () => {
    const r = await post(t.baseUrl, '/api/session', {});
    expect(r.status).toBe(200);
    expect(r.json?.['sessionId']).toBeDefined();
    expect(typeof r.json?.['sessionId']).toBe('string');
  });

  it('POST /api/session resumes existing session', async () => {
    const r1 = await post(t.baseUrl, '/api/session', {});
    const sessionId = r1.json?.['sessionId'] as string;

    const r2 = await post(t.baseUrl, '/api/session', { sessionId });
    expect(r2.status).toBe(200);
    expect(r2.json?.['sessionId']).toBe(sessionId);
  });

  it('GET /api/session/:id/events returns SSE stream with initial session_state', async () => {
    const r = await post(t.baseUrl, '/api/session', {});
    const sessionId = r.json?.['sessionId'] as string;

    const events = await collectSseEvents(t.baseUrl, sessionId, 500);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe('session_state');
    const state = events[0] as Record<string, unknown>;
    expect(state['sessionId']).toBe(sessionId);
    // Instances is an array of {id, projectPath, yolo} objects
    expect(Array.isArray(state['instances'])).toBe(true);
    expect(state['instances']).toEqual([]);
  });

  it('returns 404 for unknown session', async () => {
    const r = await post(t.baseUrl, '/api/session/nonexistent/command', {
      type: 'submit',
      instanceId: 'x',
      text: 'hi',
    });
    expect(r.status).toBe(404);
  });
});

describe('File Browsing', () => {
  it('GET /api/browse returns directory listing', async () => {
    const r = await get(t.baseUrl, '/api/browse?path=/tmp');
    expect(r.status).toBe(200);
    expect(typeof r.json?.['path']).toBe('string');
    expect(Array.isArray(r.json?.['directories'])).toBe(true);
  });

  it('GET /api/validate-path validates a directory', async () => {
    const r = await get(t.baseUrl, '/api/validate-path?path=/tmp');
    expect(r.status).toBe(200);
    expect(r.json?.['valid']).toBe(true);
  });

  it('GET /api/validate-path returns error for missing path param', async () => {
    const r = await get(t.baseUrl, '/api/validate-path');
    expect(r.status).toBe(400);
  });
});

describe('Command Validation', () => {
  let sessionId: string;

  beforeAll(async () => {
    const r = await post(t.baseUrl, '/api/session', {});
    sessionId = r.json?.['sessionId'] as string;
  });

  it('missing type → 400', async () => {
    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {});
    expect(r.status).toBe(400);
    expect(r.json?.['error']).toBe('Invalid payload');
  });

  it('missing instanceId on submit → 400', async () => {
    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      text: 'hi',
    });
    expect(r.status).toBe(400);
    expect(r.json?.['error']).toBe('Missing instanceId');
  });

  it('instance not in session → 403', async () => {
    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId: 'nonexistent',
      text: 'hi',
    });
    expect(r.status).toBe(403);
  });

  it('unsupported command → 400', async () => {
    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'unknownCommand',
    });
    expect(r.status).toBe(400);
    expect(r.json?.['error']).toBe('Unsupported command');
  });

  it('missing projectPath on spawnInstance → 400', async () => {
    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
    });
    expect(r.status).toBe(400);
    expect(r.json?.['error']).toBe('Missing projectPath');
  });

  it('terminateInstance with missing instanceId → 400', async () => {
    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'terminateInstance',
    });
    expect(r.status).toBe(400);
  });
});

describe('Cross-session isolation', () => {
  it('cannot access instance from another session', async () => {
    // Create two sessions
    const r1 = await post(t.baseUrl, '/api/session', {});
    const session1 = r1.json?.['sessionId'] as string;
    const r2 = await post(t.baseUrl, '/api/session', {});
    const session2 = r2.json?.['sessionId'] as string;

    // Spawn in session1 (Claude is the only provider now)
    const spawn = await post(t.baseUrl, `/api/session/${session1}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    // Try to terminate from session2
    const r = await post(t.baseUrl, `/api/session/${session2}/command`, {
      type: 'terminateInstance',
      instanceId,
    });
    expect(r.status).toBe(403);
  });
});

describe('Claude Provider', () => {
  it('spawning Claude instance returns instanceId', async () => {
    // Create session
    const r = await post(t.baseUrl, '/api/session', {});
    const sessionId = r.json?.['sessionId'] as string;

    // Spawn Claude instance
    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'claude',
    });
    expect(spawn.status).toBe(200);
    const instanceId = spawn.json?.['instanceId'] as string;
    expect(instanceId).toBeDefined();
    expect(typeof spawn.json?.['resolvedPath']).toBe('string');

    // Verify instance appears in a new SSE connection's session_state
    // (This tests that the server state is properly updated)
    const events = await collectSseEvents(t.baseUrl, sessionId, 500);
    const sessionState = events.find((e) => e.type === 'session_state') as
      | Record<string, unknown>
      | undefined;
    expect(sessionState).toBeDefined();
    expect(sessionState?.['sessionId']).toBe(sessionId);

    const instances = sessionState?.['instances'] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(instances)).toBe(true);
    expect(instances?.some((i) => i['id'] === instanceId)).toBe(true);
  });

  it('Claude instance emits models_available event', async () => {
    // Create session and connect SSE
    const r = await post(t.baseUrl, '/api/session', {});
    const sessionId = r.json?.['sessionId'] as string;

    // Collect SSE events in the background
    const eventsPromise = collectSseEvents(t.baseUrl, sessionId, 3000);

    // Wait for initial session_state
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Spawn Claude instance
    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    // Wait for events
    const events = await eventsPromise;

    // Find claude:models_available event for this instance
    const modelsEvent = events.find(
      (e) =>
        e.type === 'claude:models_available' &&
        (e as Record<string, unknown>)['instanceId'] === instanceId,
    ) as Record<string, unknown> | undefined;

    // Models should be fetched within 3 seconds
    expect(modelsEvent).toBeDefined();
    const models = modelsEvent?.['models'] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(models)).toBe(true);
    expect(models!.length).toBeGreaterThan(0);
    expect(models![0]).toHaveProperty('value');
    expect(models![0]).toHaveProperty('label');
  });

  it('Claude instance handles submit command and emits events', async () => {
    // Create session
    const r = await post(t.baseUrl, '/api/session', {});
    const sessionId = r.json?.['sessionId'] as string;

    // Spawn instance
    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Start collecting events
    const eventsPromise = collectSseEvents(t.baseUrl, sessionId, 5000);

    // Submit a message
    const submit = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: 'say hello',
    });
    expect(submit.status).toBe(200);

    // Wait for response
    const events = await eventsPromise;

    // Should get streaming_state event
    const stateEvents = events.filter(
      (e) =>
        e.type === 'claude:streaming_state' &&
        (e as Record<string, unknown>)['instanceId'] === instanceId,
    );
    expect(stateEvents.length).toBeGreaterThan(0);

    // Should get text_delta events
    const textDeltas = events.filter(
      (e) =>
        e.type === 'claude:text_delta' &&
        (e as Record<string, unknown>)['instanceId'] === instanceId,
    );
    expect(textDeltas.length).toBeGreaterThan(0);

    // Should get text_complete event
    const textComplete = events.find(
      (e) =>
        e.type === 'claude:text_complete' &&
        (e as Record<string, unknown>)['instanceId'] === instanceId,
    );
    expect(textComplete).toBeDefined();
  });

  it('terminateInstance removes the instance from session', async () => {
    // Create session and spawn instance
    const r = await post(t.baseUrl, '/api/session', {});
    const sessionId = r.json?.['sessionId'] as string;

    const spawn = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Terminate the instance
    const terminate = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'terminateInstance',
      instanceId,
    });
    expect(terminate.status).toBe(200);

    // Wait for state update
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify it's gone from session_state
    const events = await collectSseEvents(t.baseUrl, sessionId, 500);
    const state = events.find((e) => e.type === 'session_state') as
      | Record<string, unknown>
      | undefined;
    const instances = state?.['instances'] as Array<Record<string, unknown>> | undefined;
    expect(instances?.some((i) => i['id'] === instanceId)).not.toBe(true);
  });
});
