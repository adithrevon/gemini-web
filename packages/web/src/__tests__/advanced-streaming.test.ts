import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  anthropicSse,
  bodyContainsMatcher,
  post,
  startMockAnthropicServer,
  startTestServer,
} from './helpers.js';
import type {
  MockAnthropicServer,
  MockAnthropicSseEvent,
  SseEvent,
  TestServer,
} from './helpers.js';

let testServer: TestServer;
let mockAnthropic: MockAnthropicServer;

async function sseUntil(
  baseUrl: string,
  sessionId: string,
  predicate: (events: SseEvent[]) => boolean,
  timeoutMs = 7000,
  since?: number,
): Promise<SseEvent[]> {
  const controller = new AbortController();
  const events: SseEvent[] = [];
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const qs = since !== undefined ? `?since=${since}` : '';

  try {
    const response = await fetch(
      `${baseUrl}/api/session/${sessionId}/events${qs}`,
      {
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          events.push(JSON.parse(line.slice(6)) as SseEvent);
        } catch {
          // Ignore malformed lines.
        }
      }

      if (predicate(events)) {
        break;
      }
    }
  } catch (error: unknown) {
    const isAbort =
      error instanceof Error &&
      (error.name === 'AbortError' ||
        error.message.toLowerCase().includes('aborted'));
    if (!isAbort) {
      throw error;
    }
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }

  return events;
}

function setPromptScenario(
  prompt: string,
  response: MockAnthropicSseEvent[],
): void {
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

describe('Advanced Streaming Use Cases', () => {
  it('streams text delta events and completes response', async () => {
    const prompt = 'advanced streaming text case';
    const expectedText = 'streamed text from advanced suite';

    setPromptScenario(
      prompt,
      anthropicSse.textResponse({
        text: expectedText,
        chunks: ['streamed ', 'text from ', 'advanced suite'],
      }),
    );

    const session = await post(testServer.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const eventsPromise = sseUntil(
      testServer.baseUrl,
      sessionId,
      (events) => events.some((event) => event.type === 'claude:text_complete'),
      10000,
    );

    const spawn = await post(
      testServer.baseUrl,
      `/api/session/${sessionId}/command`,
      {
        type: 'spawnInstance',
        projectPath: '/tmp',
        provider: 'claude',
      },
    );
    const instanceId = spawn.json?.['instanceId'] as string;

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: prompt,
    });

    const events = await eventsPromise;

    const deltas = events.filter(
      (event) =>
        event.type === 'claude:text_delta' &&
        (event as Record<string, unknown>)['instanceId'] === instanceId,
    );
    const text = deltas
      .map((event) => (event as Record<string, unknown>)['text'])
      .filter((part): part is string => typeof part === 'string')
      .join('');

    const complete = events.find(
      (event) =>
        event.type === 'claude:text_complete' &&
        (event as Record<string, unknown>)['instanceId'] === instanceId,
    );

    expect(deltas.length).toBeGreaterThan(0);
    expect(text).toContain(expectedText);
    expect(complete).toBeDefined();

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'terminateInstance',
      instanceId,
    });
  });

  it('streams tool_use events and enters confirming status', async () => {
    const prompt = 'advanced streaming tool use case';
    const callId = 'toolu_advanced_stream_1';

    setPromptScenario(
      prompt,
      anthropicSse.toolUseResponse({
        toolUseId: callId,
        toolName: 'Bash',
        input: { command: 'rm -rf /tmp/some_dummy_folder' },
      }),
    );

    const session = await post(testServer.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const eventsPromise = sseUntil(
      testServer.baseUrl,
      sessionId,
      (events) =>
        events.some(
          (event) =>
            event.type === 'claude:tool_status' &&
            (event as Record<string, unknown>)['status'] === 'confirming',
        ),
      10000,
    );

    const spawn = await post(
      testServer.baseUrl,
      `/api/session/${sessionId}/command`,
      {
        type: 'spawnInstance',
        projectPath: '/tmp',
        provider: 'claude',
      },
    );
    const instanceId = spawn.json?.['instanceId'] as string;

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: prompt,
    });

    const events = await eventsPromise;

    const toolAdded = events.find(
      (event) =>
        event.type === 'claude:tool_added' &&
        (event as Record<string, unknown>)['instanceId'] === instanceId &&
        (
          (event as Record<string, unknown>)['tool'] as
            | Record<string, unknown>
            | undefined
        )?.['callId'] === callId,
    );
    const confirming = events.find(
      (event) =>
        event.type === 'claude:tool_status' &&
        (event as Record<string, unknown>)['instanceId'] === instanceId &&
        (event as Record<string, unknown>)['toolId'] === callId &&
        (event as Record<string, unknown>)['status'] === 'confirming',
    );

    expect(toolAdded).toBeDefined();
    expect(confirming).toBeDefined();

    const confirm = await post(
      testServer.baseUrl,
      `/api/session/${sessionId}/command`,
      {
        type: 'confirm',
        instanceId,
        callId,
        outcome: 'cancel',
      },
    );
    expect(confirm.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'terminateInstance',
      instanceId,
    });
  });

  it('replays buffered claude events when reconnecting with since', async () => {
    const prompt = 'advanced replay case';

    setPromptScenario(
      prompt,
      anthropicSse.textResponse({
        text: 'replay data',
        chunks: ['re', 'play ', 'data'],
      }),
    );

    const session = await post(testServer.baseUrl, '/api/session', {});
    const sessionId = session.json?.['sessionId'] as string;

    const firstConnection = sseUntil(
      testServer.baseUrl,
      sessionId,
      (events) => events.some((event) => event.type === 'claude:text_complete'),
      10000,
    );

    const spawn = await post(
      testServer.baseUrl,
      `/api/session/${sessionId}/command`,
      {
        type: 'spawnInstance',
        projectPath: '/tmp',
        provider: 'claude',
      },
    );
    const instanceId = spawn.json?.['instanceId'] as string;

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'submit',
      instanceId,
      text: prompt,
    });

    const firstEvents = await firstConnection;
    const firstClaudeEvent = firstEvents.find(
      (event) =>
        typeof event.type === 'string' &&
        event.type.startsWith('claude:') &&
        typeof (event as Record<string, unknown>)['seq'] === 'number',
    ) as Record<string, unknown> | undefined;

    expect(firstClaudeEvent).toBeDefined();
    const since = firstClaudeEvent!['seq'] as number;

    const replayed = await sseUntil(
      testServer.baseUrl,
      sessionId,
      (events) => events.some((event) => event.type === 'session_state'),
      3000,
      since,
    );

    const replayedClaude = replayed.filter(
      (event) =>
        typeof event.type === 'string' &&
        event.type.startsWith('claude:') &&
        typeof (event as Record<string, unknown>)['seq'] === 'number',
    );

    expect(replayedClaude.length).toBeGreaterThan(0);
    for (const event of replayedClaude) {
      expect(
        (event as Record<string, unknown>)['seq'] as number,
      ).toBeGreaterThan(since);
    }

    await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
      type: 'terminateInstance',
      instanceId,
    });
  });
});
