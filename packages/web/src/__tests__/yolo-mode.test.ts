import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 12_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function createDeletionTarget(prefix: string): { targetDir: string; cleanup: () => void } {
  const targetDir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  writeFileSync(join(targetDir, 'dummy.txt'), 'dummy');
  return {
    targetDir,
    cleanup: () => rmSync(targetDir, { recursive: true, force: true }),
  };
}

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
      response: anthropicSse.textResponse({ text: 'fallback yolo response' }),
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

describe('Yolo Mode Use Cases', () => {
  it('spawning with yolo=true executes dangerous tool use without confirmation', async () => {
    const callId = 'toolu_yolo_start_1';
    const prompt = 'run dangerous command in yolo start mode';
    const target = createDeletionTarget('yolo-start');
    const command = `rm -rf ${shellQuote(target.targetDir)}`;

    setPromptScenario(
      prompt,
      anthropicSse.toolUseResponse({
        toolUseId: callId,
        toolName: 'Bash',
        input: { command },
      }),
    );

    let instanceId = '';
    let sessionId = '';
    try {
      const session = await post(testServer.baseUrl, '/api/session', {});
      sessionId = session.json?.['sessionId'] as string;

      const spawn = await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
        provider: 'claude',
        yolo: true,
      });
      instanceId = spawn.json?.['instanceId'] as string;

      const eventsPromise = collectSseEvents(testServer.baseUrl, sessionId, 6500);

      await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'submit',
        instanceId,
        text: prompt,
      });

      await waitFor(() => !existsSync(target.targetDir));
      const events = await eventsPromise;

      const confirming = events.filter(
        (event) =>
          event.type === 'claude:tool_status' &&
          (event as Record<string, unknown>)['instanceId'] === instanceId &&
          (event as Record<string, unknown>)['toolId'] === callId &&
          (event as Record<string, unknown>)['status'] === 'confirming',
      );
      const waitingForConfirmation = events.filter(
        (event) =>
          event.type === 'claude:streaming_state' &&
          (event as Record<string, unknown>)['instanceId'] === instanceId &&
          (event as Record<string, unknown>)['state'] === 'waiting_for_confirmation',
      );
      const toolResults = events.filter(
        (event) =>
          event.type === 'claude:tool_result' &&
          (event as Record<string, unknown>)['instanceId'] === instanceId,
      );

      expect(confirming).toHaveLength(0);
      expect(waitingForConfirmation).toHaveLength(0);
      expect(toolResults.length).toBeGreaterThan(0);
    } finally {
      if (instanceId && sessionId) {
        await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
          type: 'terminateInstance',
          instanceId,
        });
      }
      target.cleanup();
    }
  });

  it('after toggling yolo on an existing conversation, dangerous tool use no longer asks confirmation', async () => {
    const callId = 'toolu_yolo_toggle_1';
    const warmupPrompt = `warmup-before-toggle-${Date.now()}`;
    const dangerousPrompt = `dangerous-after-toggle-${Date.now()}`;
    const target = createDeletionTarget('yolo-toggle');
    const command = `rm -rf ${shellQuote(target.targetDir)}`;

    mockAnthropic.setScenarios([
      {
        name: 'warmup_prompt',
        once: true,
        match: bodyContainsMatcher(warmupPrompt),
        response: anthropicSse.textResponse({ text: 'warmup response' }),
      },
      {
        name: 'dangerous_prompt',
        once: true,
        match: bodyContainsMatcher(dangerousPrompt),
        response: anthropicSse.toolUseResponse({
          toolUseId: callId,
          toolName: 'Bash',
          input: { command },
        }),
      },
      {
        name: 'default_fallback',
        response: anthropicSse.textResponse({ text: 'fallback yolo response' }),
      },
    ]);

    let instanceId = '';
    let sessionId = '';
    try {
      const session = await post(testServer.baseUrl, '/api/session', {});
      sessionId = session.json?.['sessionId'] as string;

      const spawn = await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
        provider: 'claude',
      });
      instanceId = spawn.json?.['instanceId'] as string;

      await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'submit',
        instanceId,
        text: warmupPrompt,
      });
      await waitFor(() =>
        mockAnthropic.requests.some(
          (request) => request.path === '/v1/messages' && request.rawBody.includes(warmupPrompt),
        ),
      );

      const toggleYolo = await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'toggleYolo',
        instanceId,
        yolo: true,
      });
      expect(toggleYolo.status).toBe(200);

      const eventsPromise = collectSseEvents(testServer.baseUrl, sessionId, 6500);

      await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'submit',
        instanceId,
        text: dangerousPrompt,
      });

      await waitFor(() => !existsSync(target.targetDir));
      const events = await eventsPromise;

      const confirming = events.filter(
        (event) =>
          event.type === 'claude:tool_status' &&
          (event as Record<string, unknown>)['instanceId'] === instanceId &&
          (event as Record<string, unknown>)['toolId'] === callId &&
          (event as Record<string, unknown>)['status'] === 'confirming',
      );
      const waitingForConfirmation = events.filter(
        (event) =>
          event.type === 'claude:streaming_state' &&
          (event as Record<string, unknown>)['instanceId'] === instanceId &&
          (event as Record<string, unknown>)['state'] === 'waiting_for_confirmation',
      );
      const toolResults = events.filter(
        (event) =>
          event.type === 'claude:tool_result' &&
          (event as Record<string, unknown>)['instanceId'] === instanceId,
      );

      expect(confirming).toHaveLength(0);
      expect(waitingForConfirmation).toHaveLength(0);
      expect(toolResults.length).toBeGreaterThan(0);
    } finally {
      if (instanceId && sessionId) {
        await post(testServer.baseUrl, `/api/session/${sessionId}/command`, {
          type: 'terminateInstance',
          instanceId,
        });
      }
      target.cleanup();
    }
  });
});
