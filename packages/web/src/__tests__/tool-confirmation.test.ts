/**
 * End-to-end tests for the tool confirmation (approval) flow.
 *
 * These tests drive the real ClaudeBridge + SDK path with Anthropic API mocked.
 * No private bridge internals are injected.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function createDeletionTarget(prefix = 'tool-confirm-target'): {
  targetDir: string;
  cleanup: () => void;
} {
  const targetDir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  writeFileSync(join(targetDir, 'dummy.txt'), 'dummy');
  return {
    targetDir,
    cleanup: () => rmSync(targetDir, { recursive: true, force: true }),
  };
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
    // Ignore timeout here; best-effort graceful settle.
  }
  bridge.destroy();
}

describe('Tool Confirmation Use Cases (Mock Anthropic API)', () => {
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

  it('emits confirmation events when a dangerous Bash tool_use is streamed', async () => {
    const bridge = createBridge('confirm-events');
    const target = createDeletionTarget();
    const callId = 'toolu_confirm_events_1';
    const promptText = 'please remove target for confirmation event test';
    const command = `rm -rf ${shellQuote(target.targetDir)}`;

    const states = trackStates(bridge);
    const statuses: Array<{ toolId: string; status: string }> = [];
    const confirmations: Array<{
      tool: Record<string, unknown>;
      confirmationDetails: unknown;
    }> = [];

    bridge.on('tool_status', (e: { toolId: string; status: string }) =>
      statuses.push(e),
    );
    bridge.on('tool_added', (e: any) => {
      if (e.confirmationDetails) {
        confirmations.push(e);
      }
    });

    configurePromptScenario(
      mockServer,
      promptText,
      anthropicSse.toolUseResponse({
        toolUseId: callId,
        toolName: 'Bash',
        input: { command },
      }),
    );

    try {
      await bridge.start();
      await bridge.submitMessage(promptText);

      await waitFor(() => confirmations.length > 0);
      await waitFor(() =>
        statuses.some((s) => s.toolId === callId && s.status === 'confirming'),
      );
      expect(states).toContain('waiting_for_confirmation');

      const confirmation = confirmations[0]!;
      expect(confirmation.tool['callId']).toBe(callId);
      expect(confirmation.tool['name']).toBe('Bash');
      expect(
        (confirmation.tool['input'] as Record<string, unknown>)['command'],
      ).toBe(command);

      await bridge.confirm(callId, 'cancel');
      await waitFor(() =>
        statuses.some((s) => s.toolId === callId && s.status === 'denied'),
      );
    } finally {
      await settleAndDestroy(bridge, states);
      target.cleanup();
    }
  });

  it('cancel outcome denies execution and keeps the target directory', async () => {
    const bridge = createBridge('confirm-cancel');
    const target = createDeletionTarget();
    const callId = 'toolu_confirm_cancel_1';
    const promptText = 'cancel this dangerous operation';
    const command = `rm -rf ${shellQuote(target.targetDir)}`;

    const states = trackStates(bridge);
    const statuses: Array<{ toolId: string; status: string }> = [];
    bridge.on('tool_status', (e: { toolId: string; status: string }) =>
      statuses.push(e),
    );

    configurePromptScenario(
      mockServer,
      promptText,
      anthropicSse.toolUseResponse({
        toolUseId: callId,
        toolName: 'Bash',
        input: { command },
      }),
    );

    try {
      await bridge.start();
      await bridge.submitMessage(promptText);

      await waitFor(() =>
        statuses.some((s) => s.toolId === callId && s.status === 'confirming'),
      );
      await bridge.confirm(callId, 'cancel');
      await waitFor(() =>
        statuses.some((s) => s.toolId === callId && s.status === 'denied'),
      );

      await sleep(400);
      expect(existsSync(target.targetDir)).toBe(true);
    } finally {
      await settleAndDestroy(bridge, states);
      target.cleanup();
    }
  });

  it('proceed_once approves execution and removes the target directory', async () => {
    const bridge = createBridge('confirm-proceed-once');
    const target = createDeletionTarget();
    const callId = 'toolu_confirm_proceed_once_1';
    const promptText = 'approve dangerous operation once';
    const command = `rm -rf ${shellQuote(target.targetDir)}`;

    const states = trackStates(bridge);
    const statuses: Array<{ toolId: string; status: string }> = [];
    bridge.on('tool_status', (e: { toolId: string; status: string }) =>
      statuses.push(e),
    );

    configurePromptScenario(
      mockServer,
      promptText,
      anthropicSse.toolUseResponse({
        toolUseId: callId,
        toolName: 'Bash',
        input: { command },
      }),
    );

    try {
      await bridge.start();
      await bridge.submitMessage(promptText);

      await waitFor(() =>
        statuses.some((s) => s.toolId === callId && s.status === 'confirming'),
      );
      await bridge.confirm(callId, 'proceed_once');
      await waitFor(() =>
        statuses.some((s) => s.toolId === callId && s.status === 'approved'),
      );
      await waitFor(() => !existsSync(target.targetDir), 12_000);
    } finally {
      await settleAndDestroy(bridge, states);
      target.cleanup();
    }
  });

  it('proceed_always approves execution and removes the target directory', async () => {
    const bridge = createBridge('confirm-proceed-always');
    const target = createDeletionTarget();
    const callId = 'toolu_confirm_proceed_always_1';
    const promptText = 'approve dangerous operation always';
    const command = `rm -rf ${shellQuote(target.targetDir)}`;

    const states = trackStates(bridge);
    const statuses: Array<{ toolId: string; status: string }> = [];
    bridge.on('tool_status', (e: { toolId: string; status: string }) =>
      statuses.push(e),
    );

    configurePromptScenario(
      mockServer,
      promptText,
      anthropicSse.toolUseResponse({
        toolUseId: callId,
        toolName: 'Bash',
        input: { command },
      }),
    );

    try {
      await bridge.start();
      await bridge.submitMessage(promptText);

      await waitFor(() =>
        statuses.some((s) => s.toolId === callId && s.status === 'confirming'),
      );
      await bridge.confirm(callId, 'proceed_always');
      await waitFor(() =>
        statuses.some((s) => s.toolId === callId && s.status === 'approved'),
      );
      await waitFor(() => !existsSync(target.targetDir), 12_000);
    } finally {
      await settleAndDestroy(bridge, states);
      target.cleanup();
    }
  });

  it('second confirm for the same callId is a no-op', async () => {
    const bridge = createBridge('confirm-double');
    const target = createDeletionTarget();
    const callId = 'toolu_confirm_double_1';
    const promptText = 'double confirm should no-op on second';
    const command = `rm -rf ${shellQuote(target.targetDir)}`;

    const states = trackStates(bridge);
    const statuses: Array<{ toolId: string; status: string }> = [];
    bridge.on('tool_status', (e: { toolId: string; status: string }) =>
      statuses.push(e),
    );

    configurePromptScenario(
      mockServer,
      promptText,
      anthropicSse.toolUseResponse({
        toolUseId: callId,
        toolName: 'Bash',
        input: { command },
      }),
    );

    try {
      await bridge.start();
      await bridge.submitMessage(promptText);

      await waitFor(() =>
        statuses.some((s) => s.toolId === callId && s.status === 'confirming'),
      );
      await bridge.confirm(callId, 'proceed_once');
      await waitFor(() =>
        statuses.some((s) => s.toolId === callId && s.status === 'approved'),
      );

      const countAfterFirstConfirm = statuses.filter(
        (s) => s.toolId === callId,
      ).length;
      await bridge.confirm(callId, 'cancel');
      await sleep(300);

      const countAfterSecondConfirm = statuses.filter(
        (s) => s.toolId === callId,
      ).length;
      const deniedAfterSecond = statuses.some(
        (s) => s.toolId === callId && s.status === 'denied',
      );

      expect(countAfterSecondConfirm).toBe(countAfterFirstConfirm);
      expect(deniedAfterSecond).toBe(false);
    } finally {
      await settleAndDestroy(bridge, states);
      target.cleanup();
    }
  });

  it('confirm on unknown callId is a no-op', async () => {
    const bridge = createBridge('confirm-unknown');
    const events: unknown[] = [];
    bridge.on('tool_status', (e) => events.push(e));
    bridge.on('streaming_state', (e) => events.push(e));

    try {
      await bridge.confirm('nonexistent-call-id', 'proceed_once');
      expect(events).toHaveLength(0);
    } finally {
      bridge.destroy();
    }
  });
});
