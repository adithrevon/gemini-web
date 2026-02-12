import type { Provider } from './provider.js';
import type {
  BridgeUpdatePayload,
  ConfirmationDetails,
  HistoryMessage,
  ToolCallInfo,
  ModelOption,
  TodoList,
} from './types.js';
import { createTaggedLogger } from './logger.js';

const log = createTaggedLogger('claude');

// ---------------------------------------------------------------------------
// AsyncPushQueue — push-based async iterable for multi-turn streaming input
// ---------------------------------------------------------------------------

type QueueResult<T> =
  | { value: T; done: false }
  | { value: undefined; done: true };

export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private _buffer: T[] = [];
  private _resolve: ((result: QueueResult<T>) => void) | null = null;
  private _done = false;

  push(value: T): void {
    if (this._done) return;
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve({ value, done: false });
    } else {
      this._buffer.push(value);
    }
  }

  end(): void {
    this._done = true;
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  next(): Promise<QueueResult<T>> {
    if (this._buffer.length > 0) {
      return Promise.resolve({ value: this._buffer.shift()!, done: false });
    }
    if (this._done) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this._resolve = resolve;
    });
  }
}

// ---------------------------------------------------------------------------
// ClaudeStateAccumulator — translates SDK messages → bridge:update snapshots
// ---------------------------------------------------------------------------

// We use `any` sparingly for SDK message interop since the SDK types are complex
// and we import them dynamically. The accumulator validates shape at runtime.
/* eslint-disable @typescript-eslint/no-explicit-any */

interface PendingToolUse {
  callId: string;
  name: string;
  description: string;
  status: string;
  input: unknown;
  resultDisplay: string | null;
}

export class ClaudeStateAccumulator {
  instanceId: string;
  projectPath: string;
  history: HistoryMessage[] = [];
  pending: HistoryMessage[] = [];
  streamingState: 'idle' | 'responding' | 'tool' | 'waiting_for_confirmation' =
    'idle';
  currentModel = '';
  availableModels: ModelOption[] = [];

  // Usage metrics removed - will be fetched from API instead
  // No longer accumulating tokens/costs locally

  todos: TodoList = {
    items: [],
    lastUpdated: new Date().toISOString(),
  };

  private _streamingText = '';
  private _pendingToolUses = new Map<string, PendingToolUse>();
  private _toolCallCounter = 0;

  constructor(instanceId: string, projectPath: string) {
    this.instanceId = instanceId;
    this.projectPath = projectPath;
  }

  snapshot(): BridgeUpdatePayload {
    return {
      instanceId: this.instanceId,
      projectPath: this.projectPath,
      history: [...this.history],
      pending: [...this.pending],
      streamingState: this.streamingState,
      isTrustedFolder: true,
      currentModel: this.currentModel,
      availableModels: [...this.availableModels],
      hasPreviewAccess: false,
      // usageMetrics removed - fetched from API instead
      todos: this.todos.items.length > 0 ? this.todos : undefined,
    };
  }

  setModels(
    models: Array<{ value: string; displayName: string; description?: string }>,
  ): void {
    this.availableModels = models.map((m) => ({
      value: m.value,
      label: m.displayName,
      description: m.description ?? null,
      isAuto: false,
    }));
    if (!this.currentModel && models.length > 0) {
      this.currentModel = models[0]!.value;
    }
  }

  setCurrentModel(model: string): void {
    this.currentModel = model;
  }

  addUserMessage(text: string): void {
    this.history.push({ type: 'user', text });
    this.streamingState = 'responding';
    this.pending = [];
    this._streamingText = '';
    this._pendingToolUses.clear();
    log.debug('accumulator.addUserMessage', {
      instanceId: this.instanceId,
      textLen: text.length,
      historyLen: this.history.length,
    });
  }

  handleStreamEvent(event: any): void {
    const evt = event.event;
    if (!evt) return;

    if (evt.type === 'content_block_start') {
      if (evt.content_block?.type === 'text') {
        this._streamingText = (evt.content_block.text as string) || '';
        this.streamingState = 'responding';
        log.debug('stream: content_block_start text');
      } else if (evt.content_block?.type === 'tool_use') {
        this.streamingState = 'tool';
        log.debug('stream: content_block_start tool_use', {
          name: evt.content_block?.name,
          id: evt.content_block?.id,
        });
      }
      this._updatePending();
      return;
    }

    if (evt.type === 'content_block_delta') {
      const delta = evt.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        this._streamingText += delta.text as string;
        this._updatePending();
      } else if (delta?.type === 'input_json_delta') {
        log.debug('stream: input_json_delta (tool input streaming)');
      }
      return;
    }

    if (evt.type === 'content_block_stop') {
      log.debug('stream: content_block_stop', { index: evt.index });
      return;
    }

    if (
      evt.type === 'message_start' ||
      evt.type === 'message_delta' ||
      evt.type === 'message_stop'
    ) {
      log.debug(
        'stream:',
        evt.type,
        evt.type === 'message_delta'
          ? { stop_reason: evt.delta?.stop_reason }
          : '',
      );
      return;
    }

    log.debug('stream: unhandled event', evt.type);
  }

  private _updatePending(): void {
    const pending: HistoryMessage[] = [];
    if (this._streamingText) {
      pending.push({ type: 'gemini', text: this._streamingText });
    }
    if (this._pendingToolUses.size > 0) {
      const tools: ToolCallInfo[] = [...this._pendingToolUses.values()].map(
        (t) => ({
          callId: t.callId,
          name: t.name,
          description: t.description,
          status: t.status,
          resultDisplay: t.resultDisplay ?? null,
          confirmationDetails: null,
          correlationId: null,
        }),
      );
      pending.push({ type: 'tool_group', tools });
    }
    this.pending = pending;
  }

  handleAssistantMessage(msg: any): void {
    const content = msg.message?.content;
    if (!content || !Array.isArray(content)) {
      log.debug('handleAssistantMessage: no content array', { uuid: msg.uuid });
      return;
    }

    const blockSummary = (content as any[])
      .map(
        (b: any) =>
          (b.type as string) +
          (b.type === 'tool_use' ? `:${b.name as string}` : ''),
      )
      .join(', ');
    log.debug('handleAssistantMessage', {
      uuid: msg.uuid,
      session_id: msg.session_id,
      blocks: blockSummary,
      parent_tool_use_id: msg.parent_tool_use_id,
    });

    // Flush any streaming text into history
    if (this._streamingText) {
      log.debug('flushing streaming text to history', {
        len: this._streamingText.length,
      });
      this.history.push({ type: 'gemini', text: this._streamingText });
      this._streamingText = '';
    }

    const textParts: string[] = [];

    for (const block of content as any[]) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text as string);
      } else if (block.type === 'tool_use') {
        const callId: string =
          (block.id as string) || `claude-tool-${++this._toolCallCounter}`;
        const description = this._describeToolInput(
          block.name as string,
          block.input,
        );
        const toolInfo: PendingToolUse = {
          callId,
          name: block.name as string,
          description,
          status: 'running',
          input: block.input,
          resultDisplay: null,
        };
        this._pendingToolUses.set(callId, toolInfo);
        log.debug('tool_use registered', {
          callId,
          name: block.name,
          description,
        });
      }
    }

    // If there was text, add to history (only if not already flushed from streaming)
    const fullText = textParts.join('');
    if (
      fullText &&
      !this.history.some((m) => m.type === 'gemini' && m.text === fullText)
    ) {
      this.history.push({ type: 'gemini', text: fullText });
    }

    // If there were tool uses, set state to tool
    if (
      this._pendingToolUses.size > 0 &&
      [...this._pendingToolUses.values()].some((t) => t.status === 'running')
    ) {
      this.streamingState = 'tool';
    }

    this.pending = [];
    this._updatePending();
  }

  handleUserToolResults(msg: any): void {
    const content = msg.message?.content;
    if (!content || !Array.isArray(content)) {
      log.debug('handleUserToolResults: no content array', { uuid: msg.uuid });
      return;
    }

    const resultSummary = (content as any[])
      .filter((b: any) => b.type === 'tool_result')
      .map((b: any) => ({ tool_use_id: b.tool_use_id, is_error: b.is_error }));
    log.debug('handleUserToolResults', {
      uuid: msg.uuid,
      session_id: msg.session_id,
      results: resultSummary,
      parent_tool_use_id: msg.parent_tool_use_id,
    });

    for (const block of content as any[]) {
      if (block.type === 'tool_result') {
        const toolId = block.tool_use_id as string;
        const toolInfo = this._pendingToolUses.get(toolId);
        if (toolInfo) {
          toolInfo.status = block.is_error ? 'error' : 'success';
          let resultLen = 0;
          if (Array.isArray(block.content)) {
            const texts = (block.content as any[])
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text as string);
            if (texts.length > 0) {
              toolInfo.resultDisplay = texts.join('\n');
              resultLen = toolInfo.resultDisplay.length;
            }
          } else if (typeof block.content === 'string') {
            toolInfo.resultDisplay = block.content;
            resultLen = block.content.length;
          }
          log.debug('tool_result matched', {
            callId: toolId,
            name: toolInfo.name,
            status: toolInfo.status,
            resultLen,
          });

          // Extract TODOs from TodoWrite tool
          if (toolInfo.name === 'TodoWrite' && !block.is_error) {
            try {
              const content =
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content);

              const parsed = JSON.parse(content);
              if (parsed.tasks && Array.isArray(parsed.tasks)) {
                this.todos.items = parsed.tasks.map(
                  (task: any, idx: number) => ({
                    id: `todo-${Date.now()}-${idx}`,
                    status: task.status || 'pending',
                    description: task.description || task.subject || '',
                    createdAt: new Date().toISOString(),
                  }),
                );
                this.todos.lastUpdated = new Date().toISOString();
              }
            } catch (err) {
              log.debug('Failed to parse TodoWrite result', err);
            }
          }
        } else {
          log.debug('tool_result unmatched', { tool_use_id: toolId });
        }
      }
    }

    this._flushCompletedTools();
    this.streamingState = 'responding';
    this._streamingText = '';
    this._updatePending();
  }

  private _flushCompletedTools(): void {
    const allDone = [...this._pendingToolUses.values()].every(
      (t) => t.status === 'success' || t.status === 'error',
    );
    if (allDone && this._pendingToolUses.size > 0) {
      const tools: ToolCallInfo[] = [...this._pendingToolUses.values()].map(
        (t) => ({
          callId: t.callId,
          name: t.name,
          description: t.description,
          status: t.status,
          resultDisplay: t.resultDisplay ?? null,
          confirmationDetails: null,
          correlationId: null,
        }),
      );
      this.history.push({ type: 'tool_group', tools });
      this._pendingToolUses.clear();
    }
  }

  handleResult(msg: any): void {
    log.debug('handleResult', {
      subtype: msg.subtype,
      session_id: msg.session_id,
      is_error: msg.is_error,
      num_turns: msg.num_turns,
      total_cost_usd: msg.total_cost_usd,
      duration_ms: msg.duration_ms,
      result:
        typeof msg.result === 'string' ? msg.result.slice(0, 200) : undefined,
    });

    // Usage metrics removed - will be fetched from API instead
    // No longer tracking tokens, costs, turns, or duration locally

    // Flush any remaining streaming text
    if (this._streamingText) {
      this.history.push({ type: 'gemini', text: this._streamingText });
      this._streamingText = '';
    }
    // Flush any remaining tools
    if (this._pendingToolUses.size > 0) {
      const tools: ToolCallInfo[] = [...this._pendingToolUses.values()].map(
        (t) => ({
          callId: t.callId,
          name: t.name,
          description: t.description,
          status: t.status === 'running' ? 'error' : t.status,
          resultDisplay: t.resultDisplay ?? null,
          confirmationDetails: null,
          correlationId: null,
        }),
      );
      this.history.push({ type: 'tool_group', tools });
      this._pendingToolUses.clear();
    }
    this.pending = [];
    this.streamingState = 'idle';
    log.debug('handleResult done', {
      historyLen: this.history.length,
      streamingState: this.streamingState,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addToolConfirmation(
    callId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: { decisionReason?: string },
  ): void {
    const details: ConfirmationDetails = {
      type: toolName.includes('Bash') ? 'exec' : 'edit',
      title: options.decisionReason ?? `Use ${toolName}`,
      command: toolName === 'Bash' ? String(input['command'] ?? '') : undefined,
      toolDisplayName: toolName,
      toolName: toolName.toLowerCase(),
      fileName: input['file_path']
        ? String(input['file_path']).split('/').pop()
        : undefined,
      filePath: input['file_path'] ? String(input['file_path']) : undefined,
      fileDiff:
        input['old_string'] != null
          ? `-${String(input['old_string'])}\n+${String(input['new_string'])}`
          : undefined,
    };

    const toolInfo: PendingToolUse = {
      callId,
      name: toolName,
      description: this._describeToolInput(toolName, input),
      status: 'confirming',
      input,
      resultDisplay: null,
    };

    this._pendingToolUses.set(callId, toolInfo);
    this.streamingState = 'waiting_for_confirmation';

    // Build pending output with confirmation details
    this._updatePendingWithConfirmation(details, callId);
  }

  resolveToolConfirmation(callId: string, allowed: boolean): void {
    const tool = this._pendingToolUses.get(callId);
    if (tool) {
      tool.status = allowed ? 'running' : 'cancelled';
    }
    this.streamingState = allowed ? 'tool' : 'responding';
    this._updatePending();
  }

  private _updatePendingWithConfirmation(
    details: ConfirmationDetails,
    callId: string,
  ): void {
    const pending: HistoryMessage[] = [];
    if (this._streamingText) {
      pending.push({ type: 'gemini', text: this._streamingText });
    }
    if (this._pendingToolUses.size > 0) {
      const tools: ToolCallInfo[] = [...this._pendingToolUses.values()].map(
        (t) => ({
          callId: t.callId,
          name: t.name,
          description: t.description,
          status: t.status,
          resultDisplay: t.resultDisplay ?? null,
          confirmationDetails: t.callId === callId ? details : null,
          correlationId: null,
        }),
      );
      pending.push({ type: 'tool_group', tools });
    }
    this.pending = pending;
  }

  private _describeToolInput(toolName: string, input: any): string {
    if (!input) return toolName;
    switch (toolName) {
      case 'Bash':
        return input.command
          ? `$ ${String(input.command).slice(0, 120)}`
          : toolName;
      case 'Read':
        return input.file_path ? `Read ${input.file_path as string}` : toolName;
      case 'Write':
        return input.file_path
          ? `Write ${input.file_path as string}`
          : toolName;
      case 'Edit':
        return input.file_path ? `Edit ${input.file_path as string}` : toolName;
      case 'Glob':
        return input.pattern ? `Glob ${input.pattern as string}` : toolName;
      case 'Grep':
        return input.pattern ? `Grep ${input.pattern as string}` : toolName;
      case 'WebSearch':
        return input.query ? `Search: ${input.query as string}` : toolName;
      case 'WebFetch':
        return input.url
          ? `Fetch: ${String(input.url).slice(0, 80)}`
          : toolName;
      case 'Task':
        return input.description
          ? `Task: ${input.description as string}`
          : toolName;
      default:
        return toolName;
    }
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// ClaudeBridge — orchestrates a single Claude SDK instance
// ---------------------------------------------------------------------------

export type EmitUpdateFn = (snapshot: {
  type: 'bridge:update';
  payload: BridgeUpdatePayload;
}) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: any[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

interface PendingConfirmation {
  resolve: (result: PermissionResult) => void;
  toolUseID: string;
  input: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suggestions?: any[];
}

export class ClaudeBridge implements Provider {
  readonly name = 'claude' as const;

  readonly instanceId: string;
  readonly projectPath: string;
  readonly accumulator: ClaudeStateAccumulator;

  private _emitUpdate: EmitUpdateFn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _query: any = null;
  private _inputQueue: AsyncPushQueue<{
    type: 'user';
    message: { role: 'user'; content: Array<{ type: 'text'; text: string }> };
  }> | null = null;
  private _sessionId: string | null = null;
  private _abortController = new AbortController();
  private _processing = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _queryFn: ((...args: any[]) => any) | null = null;
  private _yolo: boolean;
  private _planModeActive = false;
  private _pendingConfirmations = new Map<string, PendingConfirmation>();

  constructor(opts: {
    instanceId: string;
    projectPath: string;
    emitUpdate: EmitUpdateFn;
    yolo?: boolean;
  }) {
    this.instanceId = opts.instanceId;
    this.projectPath = opts.projectPath;
    this._emitUpdate = opts.emitUpdate;
    this._yolo = opts.yolo ?? false;
    this.accumulator = new ClaudeStateAccumulator(
      opts.instanceId,
      opts.projectPath,
    );
  }

  async start(): Promise<void> {
    log.debug('start()', {
      instanceId: this.instanceId,
      projectPath: this.projectPath,
    });
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      this._queryFn = sdk.query;
      log.debug('Claude SDK loaded successfully', {
        instanceId: this.instanceId,
        exports: Object.keys(sdk).join(', '),
      });
      // SDK loaded successfully
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      log.error('FATAL: Failed to load Claude SDK', { error: msg, stack });
      throw new Error('Claude SDK not installed');
    }
  }

  async submitMessage(text: string): Promise<void> {
    if (!this._queryFn) {
      log.debug('submitMessage: bridge not started');
      throw new Error('Claude bridge not started');
    }

    log.debug('submitMessage()', {
      instanceId: this.instanceId,
      textLen: text.length,
      textPreview: text.slice(0, 100),
      hasActiveQuery: !!this._query,
      resumeSessionId: this._sessionId,
    });

    this.accumulator.addUserMessage(text);
    this._emit();

    if (!this._query) {
      // First message — create new query with streaming input
      this._inputQueue = new AsyncPushQueue();
      this._inputQueue.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      });

      const options: Record<string, unknown> = {
        cwd: this.projectPath,
        tools: { type: 'preset', preset: 'claude_code' },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project', 'user'],
        includePartialMessages: true,
        abortController: this._abortController,
      };

      if (this._yolo) {
        options['permissionMode'] = 'bypassPermissions';
        options['allowDangerouslySkipPermissions'] = true;
      } else if (this._planModeActive) {
        options['permissionMode'] = 'plan';
        options['canUseTool'] = this._canUseTool.bind(this);
      } else {
        options['permissionMode'] = 'default';
        options['canUseTool'] = this._canUseTool.bind(this);
      }

      if (this._sessionId) {
        options['resume'] = this._sessionId;
      }

      log.debug('creating new query', {
        cwd: options['cwd'],
        resume: this._sessionId ?? null,
      });
      this._query = this._queryFn({
        prompt: this._inputQueue,
        options,
      });

      // Fetch models in background
      void this._fetchModels();

      // Start processing messages
      void this._processMessages();
    } else {
      log.debug('pushing to existing query input queue');
      // Subsequent message — push into existing queue
      this._inputQueue!.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      });
    }
  }

  async interrupt(): Promise<void> {
    log.debug('interrupt()', {
      instanceId: this.instanceId,
      hasQuery: !!this._query,
      processing: this._processing,
    });
    if (this._query) {
      try {
        await this._query.interrupt();
        log.debug('interrupt succeeded', { instanceId: this.instanceId });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.debug('interrupt error', {
          error: msg,
          instanceId: this.instanceId,
        });
      }
    } else {
      log.debug('interrupt: no active query to interrupt');
    }
  }

  async setModel(model: string): Promise<void> {
    log.debug('setModel()', {
      instanceId: this.instanceId,
      model,
      hasQuery: !!this._query,
    });
    if (this._query) {
      try {
        await this._query.setModel(model);
        this.accumulator.setCurrentModel(model);
        this._emit();
        log.debug('setModel succeeded', { model });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.debug('setModel error', { error: msg, model });
      }
    } else {
      // No active query, just store the preference
      this.accumulator.setCurrentModel(model);
      this._emit();
      log.debug('setModel: stored preference (no active query)', { model });
    }
  }

  async togglePlanMode(): Promise<void> {
    this._planModeActive = !this._planModeActive;
    log.debug('togglePlanMode()', {
      instanceId: this.instanceId,
      planModeActive: this._planModeActive,
    });
    // Plan mode only affects the next query, not the current one
    // The permission mode is set when creating the query in submitMessage
  }

  getPlanModeActive(): boolean {
    return this._planModeActive;
  }

  async confirm(
    callId: string,
    outcome: string,
    _correlationId?: string,
  ): Promise<void> {
    const pending = this._pendingConfirmations.get(callId);
    if (!pending) {
      log.debug('confirm: no pending confirmation found', { callId });
      return;
    }

    this._pendingConfirmations.delete(callId);
    log.debug('confirm', { callId, outcome, instanceId: this.instanceId });

    if (outcome === 'cancel') {
      this.accumulator.resolveToolConfirmation(callId, false);
      pending.resolve({
        behavior: 'deny',
        message: 'User denied',
        toolUseID: pending.toolUseID,
      });
    } else if (outcome === 'proceed_always') {
      this.accumulator.resolveToolConfirmation(callId, true);
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        updatedPermissions: pending.suggestions,
        toolUseID: pending.toolUseID,
      });
    } else {
      this.accumulator.resolveToolConfirmation(callId, true);
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        toolUseID: pending.toolUseID,
      });
    }
    this._emit();
  }

  destroy(): void {
    log.debug('destroy()', {
      instanceId: this.instanceId,
      hasQueue: !!this._inputQueue,
      hasQuery: !!this._query,
      processing: this._processing,
      pendingConfirmations: this._pendingConfirmations.size,
    });
    // Reject pending confirmations
    for (const [, pending] of this._pendingConfirmations) {
      pending.resolve({
        behavior: 'deny',
        message: 'Session terminated',
        toolUseID: pending.toolUseID,
      });
    }
    this._pendingConfirmations.clear();
    if (this._inputQueue) {
      this._inputQueue.end();
    }
    this._abortController.abort();
    this._query = null;
    this._inputQueue = null;
    log.debug('destroy complete', { instanceId: this.instanceId });
  }

  getSnapshot(): BridgeUpdatePayload {
    const snapshot = this.accumulator.snapshot();
    return {
      ...snapshot,
      planModeActive: this._planModeActive,
    };
  }

  private async _fetchModels(): Promise<void> {
    if (!this._query) return;
    try {
      log.debug('fetching supported models...');
      const models = await this._query.supportedModels();
      log.debug('supportedModels() returned', {
        count: models?.length,
        models: models?.map((m: { value: string }) => m.value),
      });
      if (models && (models as unknown[]).length > 0) {
        this.accumulator.setModels(
          models as Array<{
            value: string;
            displayName: string;
            description?: string;
          }>,
        );
        this._emit();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug('Failed to fetch models', { error: msg });
    }
  }

  private async _processMessages(): Promise<void> {
    if (this._processing) return;
    this._processing = true;
    let msgCount = 0;

    log.debug('_processMessages started', { instanceId: this.instanceId });

    try {
      for await (const message of this._query) {
        msgCount++;
        const msgMeta: Record<string, unknown> = {
          n: msgCount,
          type: (message as { type: string }).type,
        };
        const msg = message as Record<string, unknown>;
        if (msg['type'] === 'stream_event')
          msgMeta['event'] = (
            msg['event'] as Record<string, unknown> | undefined
          )?.['type'];
        if (msg['uuid']) msgMeta['uuid'] = msg['uuid'];
        if (msg['session_id']) msgMeta['session_id'] = msg['session_id'];
        log.debug('SDK message received', msgMeta);

        switch (msg['type']) {
          case 'stream_event':
            this.accumulator.handleStreamEvent(msg);
            this._emit();
            break;

          case 'assistant':
            this.accumulator.handleAssistantMessage(msg);
            this._emit();
            break;

          case 'user':
            // User messages from SDK contain tool results
            this.accumulator.handleUserToolResults(msg);
            this._emit();
            break;

          case 'result':
            this._sessionId = msg['session_id'] as string;
            this.accumulator.handleResult(msg);
            this._emit();
            log.debug('Query complete', {
              subtype: msg['subtype'],
              session_id: msg['session_id'],
              cost: msg['total_cost_usd'],
              turns: msg['num_turns'],
              duration_ms: msg['duration_ms'],
            });
            break;

          case 'system':
            log.debug('SDK system message', {
              subtype: msg['subtype'],
              text:
                typeof msg['text'] === 'string'
                  ? (msg['text'] as string).slice(0, 200)
                  : undefined,
            });
            break;

          default:
            log.debug('Unhandled message type', {
              type: msg['type'],
              keys: Object.keys(msg).join(', '),
            });
            break;
        }
      }
      log.debug('_processMessages loop ended normally', {
        totalMessages: msgCount,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.debug('Query aborted', {
          instanceId: this.instanceId,
          messagesProcessed: msgCount,
        });
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        const stack =
          err instanceof Error
            ? err.stack?.split('\n').slice(0, 3).join(' | ')
            : undefined;
        log.debug('Query error', {
          error: errMsg,
          stack,
          messagesProcessed: msgCount,
        });
      }
      this.accumulator.handleResult({ subtype: 'error' });
      this._emit();
    } finally {
      this._processing = false;
      this._query = null;
      this._inputQueue = null;
      log.debug('_processMessages finished', {
        instanceId: this.instanceId,
        totalMessages: msgCount,
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: any[];
      decisionReason?: string;
      toolUseID: string;
    },
  ): Promise<PermissionResult> {
    const callId = options.toolUseID;
    log.debug('canUseTool', {
      toolName,
      callId,
      decisionReason: options.decisionReason,
    });

    // Emit a confirmation request to the iOS app via the accumulator
    this.accumulator.addToolConfirmation(callId, toolName, input, options);
    this._emit();

    // Wait for the iOS app to respond
    return new Promise<PermissionResult>((resolve) => {
      this._pendingConfirmations.set(callId, {
        resolve,
        toolUseID: callId,
        input,
        suggestions: options.suggestions,
      });
    });
  }

  private _emit(): void {
    const snapshot = this.accumulator.snapshot();
    const event = { type: 'bridge:update' as const, payload: snapshot };
    log.trace(
      JSON.stringify({
        instanceId: this.instanceId,
        streamingState: snapshot.streamingState,
        historyLen: snapshot.history.length,
        pendingLen: snapshot.pending.length,
        currentModel: snapshot.currentModel,
        availableModelsCount: snapshot.availableModels.length,
      }),
    );
    this._emitUpdate(event);
  }
}
