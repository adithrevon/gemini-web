import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicSse,
  bodyContainsMatcher,
  collectSseEvents,
  post,
  startMockAnthropicServer,
  startTestServer,
} from './helpers.js';
import type { MockAnthropicServer, MockAnthropicRequest, TestServer } from './helpers.js';

let testServer: TestServer;
let mockAnthropic: MockAnthropicServer;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

function requestForPrompt(prompt: string): MockAnthropicRequest | undefined {
  return [...mockAnthropic.requests].reverse().find(
    (req) => req.path === '/v1/messages' && req.rawBody.includes(prompt),
  );
}

function modelFamily(model: string | undefined): string {
  const lower = (model ?? '').toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return lower;
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

describe('Model Use Cases', () => {
  it('emits models_available after spawning a claude instance', async () => {
    const session = await post(testServer.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const eventsPromise = collectSseEvents(testServer.baseUrl, sessionId, 2500);

    const spawn = await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    const events = await eventsPromise;
    const modelsEvent = events.find(
      (event) =>
        event.type === 'claude:models_available' &&
        (event as Record<string, unknown>)['instanceId'] === instanceId,
    ) as Record<string, unknown> | undefined;

    const models = modelsEvent?.['models'] as Array<Record<string, unknown>> | undefined;

    expect(modelsEvent).toBeDefined();
    expect(Array.isArray(models)).toBe(true);
    expect((models ?? []).length).toBeGreaterThan(0);
    expect(typeof models?.[0]?.['value']).toBe('string');
    expect(typeof models?.[0]?.['label']).toBe('string');

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'terminateInstance',
      instanceId,
    });
  });

  it('applies setModel so the next submit sends the selected model', async () => {
    const baselinePrompt = `model-baseline-${Date.now()}`;
    const afterSetPrompt = `model-after-set-${Date.now()}`;

    mockAnthropic.setScenarios([
      {
        name: 'baseline_prompt',
        once: true,
        match: bodyContainsMatcher(baselinePrompt),
        response: anthropicSse.textResponse({ text: 'baseline response' }),
      },
      {
        name: 'after_set_prompt',
        once: true,
        match: bodyContainsMatcher(afterSetPrompt),
        response: anthropicSse.textResponse({ text: 'after set response' }),
      },
      {
        name: 'default_fallback',
        response: anthropicSse.textResponse({ text: 'fallback model response' }),
      },
    ]);

    const session = await post(testServer.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const startupEventsPromise = collectSseEvents(testServer.baseUrl, sessionId, 2500);

    const spawn = await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'spawnInstance',
      projectPath: '/tmp',
      provider: 'claude',
    });
    const instanceId = spawn.json?.['instanceId'] as string;

    const startupEvents = await startupEventsPromise;
    const modelsEvent = startupEvents.find(
      (event) =>
        event.type === 'claude:models_available' &&
        (event as Record<string, unknown>)['instanceId'] === instanceId,
    ) as Record<string, unknown> | undefined;

    const modelValues = (
      (modelsEvent?.['models'] as Array<Record<string, unknown>> | undefined) ?? []
    )
      .map((model) => model['value'])
      .filter((value): value is string => typeof value === 'string');

    expect(modelValues.length).toBeGreaterThan(0);
    const concreteModelValues = modelValues.filter(
      (value) => value !== 'default' && value !== 'auto',
    );
    expect(concreteModelValues.length).toBeGreaterThan(0);

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: baselinePrompt,
    });
    await waitFor(() => !!requestForPrompt(baselinePrompt));

    const baselineBody = requestForPrompt(baselinePrompt)?.body as
      | Record<string, unknown>
      | undefined;
    const baselineModel =
      typeof baselineBody?.['model'] === 'string' ? (baselineBody['model'] as string) : undefined;
    const baselineFamily = modelFamily(baselineModel);

    const requestedModel =
      concreteModelValues.find((value) => modelFamily(value) !== baselineFamily) ??
      concreteModelValues.find((value) => value !== baselineModel) ??
      concreteModelValues[0]!;
    const requestedFamily = modelFamily(requestedModel);

    const setModel = await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'setModel',
      instanceId,
      model: requestedModel,
    });
    expect(setModel.status).toBe(200);

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: afterSetPrompt,
    });
    await waitFor(() => !!requestForPrompt(afterSetPrompt));

    const afterSetBody = requestForPrompt(afterSetPrompt)?.body as
      | Record<string, unknown>
      | undefined;

    const afterModel =
      typeof afterSetBody?.['model'] === 'string' ? (afterSetBody['model'] as string) : undefined;
    expect(typeof afterModel).toBe('string');
    expect(modelFamily(afterModel)).toBe(requestedFamily);
    if (baselineFamily && requestedFamily !== baselineFamily) {
      expect(modelFamily(afterModel)).not.toBe(baselineFamily);
    }

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'terminateInstance',
      instanceId,
    });
  });
});
