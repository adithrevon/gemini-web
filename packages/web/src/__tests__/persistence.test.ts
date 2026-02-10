import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startTestServer,
  post,
  collectSseEvents,
  MockCliClient,
} from './helpers.js';
import type { TestServer } from './helpers.js';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PERSIST_FILE = join(homedir(), '.gemini-web', 'sessions.json');

// Clean up persistence file before/after tests
beforeEach(() => {
  if (existsSync(PERSIST_FILE)) {
    unlinkSync(PERSIST_FILE);
  }
});

describe('Session Persistence', () => {
  let t: TestServer;

  afterAll(async () => {
    await t?.cleanup();
    if (existsSync(PERSIST_FILE)) {
      unlinkSync(PERSIST_FILE);
    }
  });

  it('creates persistence file on first state change', async () => {
    t = await startTestServer();

    // Create a session
    const r = await post(t.baseUrl, '/api/session', {});
    const sessionId = r.json?.['sessionId'] as string;

    // Wait for debounced write
    await new Promise((r) => setTimeout(r, 6000));

    // Verify file was created
    expect(existsSync(PERSIST_FILE)).toBe(true);

    await t.cleanup();
  });

  it('persists and restores a single Claude instance', async () => {
    t = await startTestServer();

    const r1 = await post(t.baseUrl, '/api/session', {});
    const sessionId = r1.json?.['sessionId'] as string;

    // Spawn Claude instance
    const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp/test-claude',
      provider: 'claude',
    });
    const instanceId = r2.json?.['instanceId'] as string;

    // Wait for persistence
    await new Promise((r) => setTimeout(r, 6000));

    // Restart server
    await t.cleanup();
    t = await startTestServer();

    // Verify session and instance were restored
    const events = await collectSseEvents(t.baseUrl, sessionId, 1000);
    const state = events.find((e) => e.type === 'session_state') as
      | Record<string, unknown>
      | undefined;

    expect(state?.['sessionId']).toBe(sessionId);

    const instances = state?.['instances'] as
      | Array<Record<string, unknown>>
      | undefined;

    expect(instances?.length).toBe(1);
    expect(instances?.[0]?.['id']).toBe(instanceId);
    expect(instances?.[0]?.['provider']).toBe('claude');

    await t.cleanup();
  });

  it('preserves activeInstanceId when restoring multiple instances', async () => {
    t = await startTestServer();

    const r1 = await post(t.baseUrl, '/api/session', {});
    const sessionId = r1.json?.['sessionId'] as string;

    // Spawn Claude instance
    const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp/test-claude',
      provider: 'claude',
    });
    const claudeId = r2.json?.['instanceId'] as string;

    // Spawn Gemini instance
    const r3 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp/test-gemini',
      provider: 'gemini',
    });
    const geminiId = r3.json?.['instanceId'] as string;

    // Set Claude as active (overriding Gemini which became active on spawn)
    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'setActiveInstance',
      instanceId: claudeId,
    });

    // Wait for persistence
    await new Promise((r) => setTimeout(r, 6000));

    // Restart server
    await t.cleanup();
    t = await startTestServer();

    // Verify BOTH instances were restored
    const events = await collectSseEvents(t.baseUrl, sessionId, 1000);
    const state = events.find((e) => e.type === 'session_state') as
      | Record<string, unknown>
      | undefined;

    const instances = state?.['instances'] as
      | Array<Record<string, unknown>>
      | undefined;

    expect(instances?.length).toBe(2);

    // CRITICAL: Verify Claude is still the active instance, not Gemini
    expect(state?.['activeInstanceId']).toBe(claudeId);

    await t.cleanup();
  });

  it('routes messages to the correct instance after restoration', async () => {
    t = await startTestServer();

    const r1 = await post(t.baseUrl, '/api/session', {});
    const sessionId = r1.json?.['sessionId'] as string;

    // Spawn two Gemini instances with mock clients
    const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp/test-1',
      provider: 'gemini',
    });
    const instance1 = r2.json?.['instanceId'] as string;

    const r3 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp/test-2',
      provider: 'gemini',
    });
    const instance2 = r3.json?.['instanceId'] as string;

    // Connect mock CLIs
    await new Promise((r) => setTimeout(r, 200));

    const cli1 = new MockCliClient();
    await cli1.connect(t.port, instance1, '/tmp/test-1');
    await cli1.ready();

    const cli2 = new MockCliClient();
    await cli2.connect(t.port, instance2, '/tmp/test-2');
    await cli2.ready();

    // Set instance1 as active
    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'setActiveInstance',
      instanceId: instance1,
    });

    // Wait for persistence
    await new Promise((r) => setTimeout(r, 6000));

    // Restart server (CLIs will disconnect)
    cli1.close();
    cli2.close();
    await t.cleanup();
    t = await startTestServer();

    // Reconnect CLIs
    await new Promise((r) => setTimeout(r, 200));

    const cli1New = new MockCliClient();
    await cli1New.connect(t.port, instance1, '/tmp/test-1');
    await cli1New.ready();

    const cli2New = new MockCliClient();
    await cli2New.connect(t.port, instance2, '/tmp/test-2');
    await cli2New.ready();

    // Listen for messages
    const cli1Messages: Record<string, unknown>[] = [];
    const cli2Messages: Record<string, unknown>[] = [];

    cli1New.onMessage((msg) => cli1Messages.push(msg));
    cli2New.onMessage((msg) => cli2Messages.push(msg));

    // Send message - should go to instance1 (the active one)
    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId: instance1,
      text: 'test message',
    });

    await new Promise((r) => setTimeout(r, 200));

    // CRITICAL: Verify message went to instance1, not instance2
    const cli1Submit = cli1Messages.find((m) => m['type'] === 'submit');
    const cli2Submit = cli2Messages.find((m) => m['type'] === 'submit');

    expect(cli1Submit).toBeDefined();
    expect(cli1Submit?.['text']).toBe('test message');
    expect(cli2Submit).toBeUndefined(); // Should NOT receive the message

    cli1New.close();
    cli2New.close();
    await t.cleanup();
  });

  it('handles corrupt persistence file gracefully', async () => {
    t = await startTestServer();

    // Create a corrupt file
    const fs = await import('node:fs/promises');
    await fs.writeFile(PERSIST_FILE, '{ invalid json }', 'utf8');

    // Restart server - should handle corrupt file and start fresh
    await t.cleanup();
    t = await startTestServer();

    // Verify corrupt file was renamed and server started
    expect(existsSync(PERSIST_FILE + '.corrupt')).toBe(false); // Will be timestamped

    // Should be able to create new sessions
    const r = await post(t.baseUrl, '/api/session', {});
    expect(r.status).toBe(200);
    expect(r.json?.['sessionId']).toBeDefined();

    await t.cleanup();
  });

  it('persists session immediately on graceful shutdown', async () => {
    t = await startTestServer();

    const r1 = await post(t.baseUrl, '/api/session', {});
    const sessionId = r1.json?.['sessionId'] as string;

    // Spawn instance
    await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp/test-shutdown',
      provider: 'claude',
    });

    // Graceful shutdown (should trigger immediate write)
    await t.cleanup();

    // Verify file was written (without waiting for debounce)
    expect(existsSync(PERSIST_FILE)).toBe(true);

    const fs = await import('node:fs/promises');
    const content = await fs.readFile(PERSIST_FILE, 'utf8');
    const data = JSON.parse(content);

    expect(data.sessions.length).toBe(1);
    expect(data.sessions[0].id).toBe(sessionId);
  });
});
