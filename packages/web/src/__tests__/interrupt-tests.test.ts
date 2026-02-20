import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicSse,
  bodyContainsMatcher,
  collectSseEvents,
  post,
  startMockAnthropicServer,
  startTestServer,
} from './helpers.js';
import type { MockAnthropicServer, MockAnthropicSseEvent, TestServer } from './helpers.js';

let testServer: TestServer;
let mockAnthropic: MockAnthropicServer;

function setPromptScenario(prompt: string, response: MockAnthropicSseEvent[]): void {
  mockAnthropic.setScenarios([
    {
      name: 'target_prompt',
      once: true,
      match: bodyContainsMatcher(prompt),
      response,
    },
    {
      name: 'default_fallback',
      response: anthropicSse.textResponse({ text: 'fallback mock response' }),
    },
  ]);
}

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

describe('Interrupt Use Cases', () => {
  it('stops an in-flight stream by interrupting and returning to idle', async () => {
    const prompt = 'interrupt use case';
    const chunks = Array.from({ length: 40 }, (_, index) => `chunk-${index} `);

    setPromptScenario(
      prompt,
      anthropicSse.textResponse({
        text: chunks.join(''),
        chunks,
        delayMs: 100,
      }),
    );

    const session = await post(testServer.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const spawn = await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    const eventsPromise = collectSseEvents(testServer.baseUrl, sessionId, 4300);

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: prompt,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const interrupt = await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'interrupt',
      instanceId,
    });

    const events = await eventsPromise;

    const textDeltas = events.filter(
      (event) =>
        event.type === 'claude:text_delta' &&
        (event as Record<string, unknown>)['instanceId'] === instanceId,
    );
    const textComplete = events.find(
      (event) =>
        event.type === 'claude:text_complete' &&
        (event as Record<string, unknown>)['instanceId'] === instanceId,
    );
    const idle = events.find(
      (event) =>
        event.type === 'claude:streaming_state' &&
        (event as Record<string, unknown>)['instanceId'] === instanceId &&
        (event as Record<string, unknown>)['state'] === 'idle',
    );

    expect(interrupt.status).toBe(200);
    expect(textComplete).not.toBeDefined();
    expect(idle).toBeDefined();
    if (textDeltas.length > 0) {
      expect(textDeltas.length).toBeLessThan(40);
    }

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'terminateInstance',
      instanceId,
    });
  });
});
