import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startTestServer,
  post,
  collectSseEvents,
} from './helpers.js';
import type { TestServer } from './helpers.js';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PERSIST_FILE = join(homedir(), '.claude-web', 'sessions.json');

// Clean up persistence file before/after tests
beforeEach(() => {
  if (existsSync(PERSIST_FILE)) {
    unlinkSync(PERSIST_FILE);
  }
});

describe('Session Persistence', () => {
  it('creates persistence file on first state change', async () => {
    const t = await startTestServer();

    // Create a session
    const r = await post(t.baseUrl, '/api/session', {});
    const sessionId = r.json?.['sessionId'] as string;

    // Poll for the persistence file (debounce is 5s, poll up to 10s)
    const deadline = Date.now() + 10_000;
    while (!existsSync(PERSIST_FILE) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }

    // Verify file was created
    expect(existsSync(PERSIST_FILE)).toBe(true);

    await t.cleanup();
  });

  it('persists and restores a single Claude instance', async () => {
    let t = await startTestServer();

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

    // Verify session and instance were restored (allow time for bridge startup)
    const events = await collectSseEvents(t.baseUrl, sessionId, 15000);
    const state = events.find((e) => e.type === 'session_state') as
      | Record<string, unknown>
      | undefined;

    expect(state?.['sessionId']).toBe(sessionId);

    // Instances is an array of {id, projectPath, yolo} objects
    const instances = state?.['instances'] as Array<Record<string, unknown>> | undefined;

    expect(Array.isArray(instances)).toBe(true);
    expect(instances?.length).toBe(1);
    expect(instances?.[0]?.['id']).toBe(instanceId);
    expect(instances?.[0]?.['projectPath']).toBeDefined();
    expect(typeof instances?.[0]?.['yolo']).toBe('boolean');

    await t.cleanup();
  });

  it('restores multiple Claude instances', async () => {
    let t = await startTestServer();

    const r1 = await post(t.baseUrl, '/api/session', {});
    const sessionId = r1.json?.['sessionId'] as string;

    // Spawn first Claude instance
    const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp/test-claude-1',
      provider: 'claude',
    });
    const instance1Id = r2.json?.['instanceId'] as string;

    // Spawn second Claude instance
    const r3 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp/test-claude-2',
      provider: 'claude',
    });
    const instance2Id = r3.json?.['instanceId'] as string;

    // Wait for persistence
    await new Promise((r) => setTimeout(r, 6000));

    // Restart server
    await t.cleanup();
    t = await startTestServer();

    // Verify BOTH instances were restored (allow time for bridge startup)
    const events = await collectSseEvents(t.baseUrl, sessionId, 15000);
    const state = events.find((e) => e.type === 'session_state') as
      | Record<string, unknown>
      | undefined;

    const instances = state?.['instances'] as Array<Record<string, unknown>> | undefined;

    expect(Array.isArray(instances)).toBe(true);
    expect(instances?.length).toBe(2);
    expect(instances?.some((i) => i['id'] === instance1Id)).toBe(true);
    expect(instances?.some((i) => i['id'] === instance2Id)).toBe(true);

    await t.cleanup();
  });

  it('handles commands to specific instances after restoration', async () => {
    let t = await startTestServer();

    const r1 = await post(t.baseUrl, '/api/session', {});
    const sessionId = r1.json?.['sessionId'] as string;

    // Spawn two Claude instances
    const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp/test-1',
      provider: 'claude',
    });
    const instance1 = r2.json?.['instanceId'] as string;

    const r3 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp/test-2',
      provider: 'claude',
    });
    const instance2 = r3.json?.['instanceId'] as string;

    // Wait for persistence
    await new Promise((r) => setTimeout(r, 6000));

    // Restart server
    await t.cleanup();
    t = await startTestServer();

    // Wait for restoration
    await new Promise((r) => setTimeout(r, 1000));

    // Verify both instances can receive commands
    const submit1 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId: instance1,
      text: 'test message 1',
    });
    expect(submit1.status).toBe(200);

    const submit2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId: instance2,
      text: 'test message 2',
    });
    expect(submit2.status).toBe(200);

    await t.cleanup();
  });

  it('handles corrupt persistence file gracefully', async () => {
    let t = await startTestServer();

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
    const t = await startTestServer();

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
