import { describe, it, expect } from 'vitest';
import { AsyncPushQueue, ClaudeStateAccumulator } from '../claude-bridge.js';

describe('AsyncPushQueue', () => {
  it('should deliver pushed values in order', async () => {
    const q = new AsyncPushQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.end();

    const values: number[] = [];
    for await (const v of q) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  it('should resolve waiting consumer when value is pushed', async () => {
    const q = new AsyncPushQueue<string>();

    // Start consuming in the background
    const consumer = (async () => {
      const values: string[] = [];
      for await (const v of q) {
        values.push(v);
      }
      return values;
    })();

    // Push after a delay
    q.push('a');
    q.push('b');
    q.end();

    const values = await consumer;
    expect(values).toEqual(['a', 'b']);
  });

  it('should not deliver after end()', async () => {
    const q = new AsyncPushQueue<number>();
    q.push(1);
    q.end();
    q.push(2); // should be ignored
    await expect(q.next()).resolves.toEqual({ value: 1, done: false });
    await expect(q.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('should handle empty queue ending immediately', async () => {
    const q = new AsyncPushQueue<number>();
    q.end();
    const result = await q.next();
    expect(result.done).toBe(true);
  });
});

describe('ClaudeStateAccumulator', () => {
  it('should start with idle state and empty history', () => {
    const acc = new ClaudeStateAccumulator('inst-1', '/tmp');
    const snap = acc.snapshot();
    expect(snap.instanceId).toBe('inst-1');
    expect(snap.projectPath).toBe('/tmp');
    expect(snap.streamingState).toBe('idle');
    expect(snap.history).toEqual([]);
    expect(snap.pending).toEqual([]);
  });

  it('should transition to responding on user message', () => {
    const acc = new ClaudeStateAccumulator('inst-1', '/tmp');
    acc.addUserMessage('hello');
    const snap = acc.snapshot();
    expect(snap.streamingState).toBe('responding');
    expect(snap.history).toEqual([{ type: 'user', text: 'hello' }]);
  });

  it('should accumulate streaming text from content_block_delta', () => {
    const acc = new ClaudeStateAccumulator('inst-1', '/tmp');
    acc.addUserMessage('hi');

    acc.handleStreamEvent({
      event: { type: 'content_block_start', content_block: { type: 'text', text: '' } },
    });
    acc.handleStreamEvent({
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
    });
    acc.handleStreamEvent({
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
    });

    const snap = acc.snapshot();
    expect(snap.pending).toHaveLength(1);
    expect(snap.pending[0]).toEqual({ type: 'gemini', text: 'Hello world' });
  });

  it('should handle assistant message with tool_use', () => {
    const acc = new ClaudeStateAccumulator('inst-1', '/tmp');
    acc.addUserMessage('list files');

    acc.handleAssistantMessage({
      uuid: 'u1',
      session_id: 's1',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });

    const snap = acc.snapshot();
    expect(snap.streamingState).toBe('tool');
    // History should have user message + text
    expect(snap.history).toHaveLength(2);
    expect(snap.history[0]).toEqual({ type: 'user', text: 'list files' });
    expect(snap.history[1]).toEqual({ type: 'gemini', text: 'Let me check.' });
    // Pending should have tool group
    expect(snap.pending).toHaveLength(1);
    expect(snap.pending[0]!.type).toBe('tool_group');
  });

  it('should flush completed tools to history on tool result', () => {
    const acc = new ClaudeStateAccumulator('inst-1', '/tmp');
    acc.addUserMessage('list files');

    acc.handleAssistantMessage({
      uuid: 'u1',
      session_id: 's1',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });

    acc.handleUserToolResults({
      uuid: 'u2',
      session_id: 's1',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }] },
        ],
      },
    });

    const snap = acc.snapshot();
    expect(snap.streamingState).toBe('responding');
    // Tool group should be in history now
    const toolGroup = snap.history.find((m) => m.type === 'tool_group');
    expect(toolGroup).toBeDefined();
    if (toolGroup && toolGroup.type === 'tool_group') {
      expect(toolGroup.tools[0]!.status).toBe('success');
      expect(toolGroup.tools[0]!.resultDisplay).toContain('file1.txt');
    }
  });

  it('should return to idle on result', () => {
    const acc = new ClaudeStateAccumulator('inst-1', '/tmp');
    acc.addUserMessage('hi');
    acc.handleStreamEvent({
      event: { type: 'content_block_start', content_block: { type: 'text', text: '' } },
    });
    acc.handleStreamEvent({
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello!' } },
    });
    acc.handleResult({ subtype: 'success', session_id: 's1' });

    const snap = acc.snapshot();
    expect(snap.streamingState).toBe('idle');
    expect(snap.pending).toEqual([]);
    // Streaming text should be flushed to history
    expect(snap.history).toHaveLength(2);
    expect(snap.history[1]).toEqual({ type: 'gemini', text: 'Hello!' });
  });

  it('should set models', () => {
    const acc = new ClaudeStateAccumulator('inst-1', '/tmp');
    acc.setModels([
      { value: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', description: 'Fast' },
      { value: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', description: 'Powerful' },
    ]);
    const snap = acc.snapshot();
    expect(snap.availableModels).toHaveLength(2);
    expect(snap.currentModel).toBe('claude-sonnet-4-5-20250929');
    expect(snap.availableModels[0]!.label).toBe('Claude Sonnet 4.5');
  });

  describe('tool description formatting', () => {
    it('should format Bash command', () => {
      const acc = new ClaudeStateAccumulator('inst-1', '/tmp');
      acc.addUserMessage('do it');
      acc.handleAssistantMessage({
        uuid: 'u1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hello' } },
          ],
        },
      });
      const snap = acc.snapshot();
      const toolGroup = snap.pending.find((m) => m.type === 'tool_group');
      if (toolGroup && toolGroup.type === 'tool_group') {
        expect(toolGroup.tools[0]!.description).toBe('$ echo hello');
      }
    });

    it('should format Read file path', () => {
      const acc = new ClaudeStateAccumulator('inst-1', '/tmp');
      acc.addUserMessage('do it');
      acc.handleAssistantMessage({
        uuid: 'u1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/foo.txt' } },
          ],
        },
      });
      const snap = acc.snapshot();
      const toolGroup = snap.pending.find((m) => m.type === 'tool_group');
      if (toolGroup && toolGroup.type === 'tool_group') {
        expect(toolGroup.tools[0]!.description).toBe('Read /tmp/foo.txt');
      }
    });
  });
});
