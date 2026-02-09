import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startTestServer,
  post,
  get,
  collectSseEvents,
  MockCliClient,
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

describe('Gemini Provider (mock CLI)', () => {
  let sessionId: string;
  let instanceId: string;
  let mockCli: MockCliClient;

  beforeAll(async () => {
    const r = await post(t.baseUrl, '/api/session', {});
    sessionId = r.json?.['sessionId'] as string;
  });

  afterAll(() => {
    mockCli?.close();
  });

  it('spawnInstance with provider=gemini returns instanceId', async () => {
    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'gemini',
    });
    expect(r.status).toBe(200);
    expect(r.json?.['instanceId']).toBeDefined();
    instanceId = r.json?.['instanceId'] as string;
    expect(r.json?.['resolvedPath']).toBeDefined();
  });

  it('mock CLI connects via WS and sends bridge:update → status becomes connected', async () => {
    // Give the server a moment to register the instance
    await new Promise(r => setTimeout(r, 100));

    mockCli = new MockCliClient();
    await mockCli.connect(t.port, instanceId, '/tmp');
    await mockCli.ready();

    // Wait a bit for the bridge:update to propagate
    await new Promise(r => setTimeout(r, 200));

    // Check via SSE that instance is connected
    const events = await collectSseEvents(t.baseUrl, sessionId, 500);
    const sessionState = events.find((e) => e.type === 'session_state') as Record<string, unknown> | undefined;
    const instances = sessionState?.['instances'] as Array<Record<string, unknown>> | undefined;
    const inst = instances?.find((i) => i['id'] === instanceId);
    expect(inst?.['status']).toBe('connected');
    expect(inst?.['provider']).toBe('gemini');
  });

  it('submit is forwarded via WS', async () => {
    const received: Record<string, unknown>[] = [];
    mockCli.onMessage((msg) => received.push(msg));

    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: 'hello world',
    });
    expect(r.status).toBe(200);
    expect(r.json?.['ok']).toBe(true);

    // Wait for WS message
    await new Promise(r => setTimeout(r, 100));
    const submit = received.find((m) => m['type'] === 'submit');
    expect(submit).toBeDefined();
    expect(submit?.['text']).toBe('hello world');
  });

  it('setModel is forwarded via WS', async () => {
    const received: Record<string, unknown>[] = [];
    mockCli.onMessage((msg) => received.push(msg));

    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'setModel',
      instanceId,
      model: 'gemini-2.0-flash',
    });
    expect(r.status).toBe(200);

    await new Promise(r => setTimeout(r, 100));
    const setModel = received.find((m) => m['type'] === 'setModel');
    expect(setModel).toBeDefined();
    expect(setModel?.['model']).toBe('gemini-2.0-flash');
  });

  it('confirm is forwarded via WS', async () => {
    const received: Record<string, unknown>[] = [];
    mockCli.onMessage((msg) => received.push(msg));

    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'confirm',
      instanceId,
      callId: 'call-123',
      outcome: 'proceed_once',
    });
    expect(r.status).toBe(200);

    await new Promise(r => setTimeout(r, 100));
    const confirm = received.find((m) => m['type'] === 'confirm');
    expect(confirm).toBeDefined();
    expect(confirm?.['callId']).toBe('call-123');
  });

  it('bridge:update from CLI arrives via SSE', async () => {
    // Send a bridge:update with history
    mockCli.sendUpdate(instanceId, '/tmp', 'responding', [
      { type: 'user', text: 'hello' },
      { type: 'gemini', text: 'world' },
    ], []);

    await new Promise(r => setTimeout(r, 200));

    const events = await collectSseEvents(t.baseUrl, sessionId, 500);
    // session_state snapshot should contain the update
    const state = events.find((e) => e.type === 'session_state') as Record<string, unknown> | undefined;
    const snapshots = state?.['snapshots'] as Array<Record<string, unknown>> | undefined;
    const snap = snapshots?.find((s) => s['instanceId'] === instanceId);
    expect(snap).toBeDefined();
    // The snapshot should have the history we sent
    const history = snap?.['history'] as Array<Record<string, unknown>> | undefined;
    expect(history?.length).toBeGreaterThanOrEqual(1);
  });

  it('setActiveInstance works', async () => {
    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'setActiveInstance',
      instanceId,
    });
    expect(r.status).toBe(200);
    expect(r.json?.['ok']).toBe(true);
  });

  it('terminateInstance removes the instance', async () => {
    const r = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'terminateInstance',
      instanceId,
    });
    expect(r.status).toBe(200);
    expect(r.json?.['ok']).toBe(true);

    await new Promise(r => setTimeout(r, 200));

    // Verify it's gone
    const events = await collectSseEvents(t.baseUrl, sessionId, 500);
    const state = events.find((e) => e.type === 'session_state') as Record<string, unknown> | undefined;
    const instances = state?.['instances'] as Array<Record<string, unknown>> | undefined;
    const inst = instances?.find((i) => i['id'] === instanceId);
    expect(inst).toBeUndefined();
  });
});

describe('Cross-session isolation', () => {
  it('cannot access instance from another session', async () => {
    // Create two sessions
    const r1 = await post(t.baseUrl, '/api/session', {});
    const session1 = r1.json?.['sessionId'] as string;
    const r2 = await post(t.baseUrl, '/api/session', {});
    const session2 = r2.json?.['sessionId'] as string;

    // Spawn in session1
    const spawn = await post(t.baseUrl, `/api/session/${session1}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'gemini',
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
