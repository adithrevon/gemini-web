import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ClaudeBridge } from '../claude-bridge/index.js';
import {
  anthropicSse,
  bodyContainsMatcher,
  startMockAnthropicServer,
  type MockAnthropicServer,
  type MockAnthropicSseEvent,
} from './helpers.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

function createBridge(instanceId: string): ClaudeBridge {
  return new ClaudeBridge({
    instanceId,
    projectPath: '/tmp',
    yolo: false,
  });
}

function trackStates(bridge: ClaudeBridge): string[] {
  const states: string[] = [];
  bridge.on('streaming_state', (e: { state: string }) => states.push(e.state));
  return states;
}

async function settleAndDestroy(
  bridge: ClaudeBridge,
  states: string[],
): Promise<void> {
  try {
    await waitFor(() => states.includes('idle'), 5_000);
  } catch {
    // Best-effort graceful shutdown.
  }
  bridge.destroy();
}

function configurePromptScenario(
  mockServer: MockAnthropicServer,
  prompt: string,
  response: MockAnthropicSseEvent[],
): void {
  mockServer.setScenarios([
    {
      name: 'target_prompt',
      once: true,
      match: bodyContainsMatcher(prompt),
      response,
    },
    {
      name: 'sdk_probe_fallback',
      response: anthropicSse.textResponse({ text: 'mock probe' }),
    },
  ]);
}

describe('ClaudeBridge Use Cases (Mock Anthropic API)', () => {
  let mockServer: MockAnthropicServer;

  beforeAll(async () => {
    mockServer = await startMockAnthropicServer();
    vi.stubEnv('ANTHROPIC_BASE_URL', mockServer.baseUrl);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-mock-dummy');
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await mockServer.cleanup();
  });

  beforeEach(() => {
    mockServer.reset();
  });

  describe('Use Case: Stream Text Response to App', () => {
    it('emits text_delta chunks from streamed text', async () => {
      const bridge = createBridge('usecase-text');
      const states = trackStates(bridge);
      const promptText = 'respond with mock streamed text chunks';
      const expected = 'Hello from scenario-driven mock stream.';
      const chunks: string[] = [];

      bridge.on('text_delta', (e: { text: string }) => chunks.push(e.text));

      configurePromptScenario(
        mockServer,
        promptText,
        anthropicSse.textResponse({
          text: expected,
          chunks: ['Hello from ', 'scenario-driven ', 'mock stream.'],
        }),
      );

      try {
        await bridge.start();
        await bridge.submitMessage(promptText);

        await waitFor(() => chunks.join('').includes(expected));
        expect(chunks.join('')).toContain(expected);
        expect(states).toContain('responding');
      } finally {
        await settleAndDestroy(bridge, states);
      }
    });
  });

  describe('Use Case: Stream Tool Request Requiring Confirmation', () => {
    it('emits tool_added for Bash tool_use streamed from Anthropic mock', async () => {
      const bridge = createBridge('usecase-tool');
      const states = trackStates(bridge);
      const promptText = 'run a dangerous bash command';
      const callId = 'toolu_usecase_1';
      const expectedCommand = 'rm -rf /tmp/some_dummy_folder';
      const toolEvents: Array<{
        tool: Record<string, unknown>;
        confirmationDetails?: unknown;
      }> = [];
      const statuses: Array<{ toolId: string; status: string }> = [];

      bridge.on('tool_added', (e: any) => toolEvents.push(e));
      bridge.on('tool_status', (e: { toolId: string; status: string }) =>
        statuses.push(e),
      );

      configurePromptScenario(
        mockServer,
        promptText,
        anthropicSse.toolUseResponse({
          toolUseId: callId,
          toolName: 'Bash',
          input: { command: expectedCommand },
        }),
      );

      try {
        await bridge.start();
        await bridge.submitMessage(promptText);

        await waitFor(() =>
          toolEvents.some(
            (e) => e.tool['callId'] === callId && e.tool['name'] === 'Bash',
          ),
        );
        await waitFor(() =>
          statuses.some(
            (s) => s.toolId === callId && s.status === 'confirming',
          ),
        );

        const event = toolEvents.find((e) => e.tool['callId'] === callId)!;
        const input = event.tool['input'] as Record<string, unknown>;
        expect(input['command']).toBe(expectedCommand);

        // Resolve pending confirmation so test exits cleanly.
        await bridge.confirm(callId, 'cancel');
        await waitFor(() =>
          statuses.some((s) => s.toolId === callId && s.status === 'denied'),
        );
      } finally {
        await settleAndDestroy(bridge, states);
      }
    });
  });

  describe('Use Case: Submit Message Contract', () => {
    it('sends submitted user prompt to Anthropic /v1/messages body', async () => {
      const bridge = createBridge('usecase-submit');
      const states = trackStates(bridge);
      const promptText = 'include this exact prompt in outbound request body';

      configurePromptScenario(
        mockServer,
        promptText,
        anthropicSse.textResponse({ text: 'ack' }),
      );

      try {
        await bridge.start();
        await bridge.submitMessage(promptText);

        await waitFor(() =>
          mockServer.requests.some(
            (req) =>
              req.path === '/v1/messages' && req.rawBody.includes(promptText),
          ),
        );

        const outbound = mockServer.requests.find(
          (req) =>
            req.path === '/v1/messages' && req.rawBody.includes(promptText),
        );
        expect(outbound).toBeDefined();
        expect(outbound?.rawBody).toContain(promptText);
      } finally {
        await settleAndDestroy(bridge, states);
      }
    });
  });
});
