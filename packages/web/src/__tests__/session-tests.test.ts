import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectSseEvents,
  post,
  startMockAnthropicServer,
  startTestServer,
} from './helpers.js';
import type { MockAnthropicServer, TestServer } from './helpers.js';

let testServer: TestServer;
let mockAnthropic: MockAnthropicServer;

beforeAll(async () => {
  mockAnthropic = await startMockAnthropicServer();
  vi.stubEnv('ANTHROPIC_BASE_URL', mockAnthropic.baseUrl);
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-mock-dummy');
  testServer = await startTestServer();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await testServer.cleanup();
  await mockAnthropic.cleanup();
});

beforeEach(() => {
  mockAnthropic.reset();
});

describe('Session Use Cases', () => {
  it('creates and resumes a session', async () => {
    const created = await post(testServer.baseUrl, '/api/session', {});
    const sessionId = created.json?.['sessionId'] as string;

    const resumed = await post(testServer.baseUrl, '/api/session', { sessionId });

    expect(created.status).toBe(200);
    expect(typeof sessionId).toBe('string');
    expect(resumed.status).toBe(200);
    expect(resumed.json?.['sessionId']).toBe(sessionId);
  });

  it('returns initial session_state when SSE client connects', async () => {
    const created = await post(testServer.baseUrl, '/api/session', {});
    const sessionId = created.json?.['sessionId'] as string;

    const events = await collectSseEvents(testServer.baseUrl, sessionId, 500);
    const state = events.find((event) => event.type === 'session_state') as
      | Record<string, unknown>
      | undefined;

    expect(state).toBeDefined();
    expect(state?.['sessionId']).toBe(sessionId);
    expect(state?.['instances']).toEqual([]);
  });

  it('adds spawned instances into session_state metadata', async () => {
    const created = await post(testServer.baseUrl, '/api/session', {});
    const sessionId = created.json?.['sessionId'] as string;

    const spawn = await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    const events = await collectSseEvents(testServer.baseUrl, sessionId, 1000);
    const state = events.find((event) => event.type === 'session_state') as
      | Record<string, unknown>
      | undefined;

    const instances = state?.['instances'] as Array<Record<string, unknown>> | undefined;

    expect(spawn.status).toBe(200);
    expect(instances?.some((instance) => instance['id'] === instanceId)).toBe(true);
  });

  it('removes an instance after terminateInstance', async () => {
    const created = await post(testServer.baseUrl, '/api/session', {});
    const sessionId = created.json?.['sessionId'] as string;

    const spawn = await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    const terminate = await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'terminateInstance',
      instanceId,
    });

    const events = await collectSseEvents(testServer.baseUrl, sessionId, 750);
    const state = events.find((event) => event.type === 'session_state') as
      | Record<string, unknown>
      | undefined;
    const instances = state?.['instances'] as Array<Record<string, unknown>> | undefined;

    expect(terminate.status).toBe(200);
    expect(instances?.some((instance) => instance['id'] === instanceId)).not.toBe(true);
  });

  it('enforces cross-session isolation for instance commands', async () => {
    const first = await post(testServer.baseUrl, '/api/session', {});
    const second = await post(testServer.baseUrl, '/api/session', {});

    const firstSessionId = first.json?.['sessionId'] as string;
    const secondSessionId = second.json?.['sessionId'] as string;

    const spawn = await post(testServer.baseUrl, `/api/session/${firstSessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    const terminateFromOtherSession = await post(
      testServer.baseUrl,
      `/api/session/${secondSessionId}/command`,
      {
        type: 'terminateInstance',
        instanceId,
      },
    );

    expect(terminateFromOtherSession.status).toBe(403);
  });

  it('returns 404 for unknown session SSE subscriptions', async () => {
    const response = await fetch(`${testServer.baseUrl}/api/session/nonexistent/events`);
    expect(response.status).toBe(404);
  });
});
