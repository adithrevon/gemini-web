/**
 * ClaudeBridge — Event-based proxy for Claude SDK
 *
 * This bridge emits events directly from the SDK with minimal transformation.
 * The iOS app owns all conversation state and builds it from events.
 */

import { query, type Query, type Options, type PermissionResult, type CanUseTool, type PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';
import { MessageParser } from './message-parser.js';
import { SDKMessageBuilder } from './sdk-message-builder.js';
import { ConfirmationBuilder } from './confirmation-builder.js';
import { AsyncPushQueue } from './async-queue.js';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ModelFetchError, SessionNotInitializedError } from './errors.js';
import { createLogger } from '../logger.js';
import type { StreamingState, ModelOption, ToolInfo } from '../types.js';

const log = createLogger('claude');

interface PendingConfirmation {
  resolve: (result: PermissionResult) => void;
  toolUseID: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
}

export class ClaudeBridge extends EventEmitter {
  readonly instanceId: string;
  readonly projectPath: string;

  private _query: Query | null = null;
  private _inputQueue: AsyncPushQueue<SDKUserMessage> | null = null;
  private _sessionId: string | null = null;
  private _abortController = new AbortController();
  private _processing = false;
  private _yolo: boolean;
  private _planModeActive = false;
  private _pendingConfirmations = new Map<string, PendingConfirmation>();
  private _parser = new MessageParser();
  private _confirmationBuilder = new ConfirmationBuilder();

  // Minimal state for SDK operations
  private _availableModels: ModelOption[] = [];

  constructor(opts: { instanceId: string; projectPath: string; yolo?: boolean }) {
    super();
    this.instanceId = opts.instanceId;
    this.projectPath = opts.projectPath;
    this._yolo = opts.yolo ?? false;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get yolo(): boolean {
    return this._yolo;
  }

  setYolo(value: boolean): void {
    this._yolo = value;
    log.debug('yolo mode changed', { instanceId: this.instanceId, yolo: value });
  }

  async start(): Promise<void> {
    log.debug('start()', {
      instanceId: this.instanceId,
      projectPath: this.projectPath,
    });

    this._inputQueue = new AsyncPushQueue();

    const options = this._buildQueryOptions();

    log.debug('creating query session with empty queue', {
      cwd: options.cwd,
      resume: this._sessionId ?? null,
    });

    this._query = query({
      prompt: this._inputQueue,
      options,
    });

    // Fetch models and emit
    try {
      const models = await this._query.supportedModels();
      if (models.length > 0) {
        this._availableModels = models.map((m) => ({
          value: m.value,
          label: m.displayName,
          description: m.description ?? null,
          isAuto: m.value === 'auto',
        }));
        this.emit('models_available', { models: this._availableModels });
      }
    } catch (err: unknown) {
      throw new ModelFetchError(err as Error);
    }

    // Start background processing (non-blocking)
    void this._processMessages();
  }

  async submitMessage(text: string): Promise<void> {
    if (!this._query || !this._inputQueue) {
      throw new SessionNotInitializedError();
    }

    log.debug('submitMessage()', {
      instanceId: this.instanceId,
      textLen: text.length,
      textPreview: text.slice(0, 100),
    });

    const message = SDKMessageBuilder.userMessage(text, this._sessionId || '');
    this._inputQueue.push(message);
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
        log.debug('interrupt error', { error: msg, instanceId: this.instanceId });
      }
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
        log.debug('setModel succeeded', { model });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.debug('setModel error', { error: msg, model });
      }
    }
  }

  async togglePlanMode(): Promise<void> {
    this._planModeActive = !this._planModeActive;
    log.debug('togglePlanMode()', {
      instanceId: this.instanceId,
      planModeActive: this._planModeActive,
    });
  }

  getPlanModeActive(): boolean {
    return this._planModeActive;
  }

  async confirm(
    callId: string,
    outcome: string,
    _correlationId?: string
  ): Promise<void> {
    const pending = this._pendingConfirmations.get(callId);
    if (!pending) {
      log.debug('confirm: no pending confirmation found', { callId });
      return;
    }

    this._pendingConfirmations.delete(callId);
    log.debug('confirm', { callId, outcome, instanceId: this.instanceId });

    if (outcome === 'cancel') {
      this.emit('tool_status', { toolId: callId, status: 'denied' });
      pending.resolve({
        behavior: 'deny',
        message: 'User denied',
        toolUseID: pending.toolUseID,
      });
    } else if (outcome === 'proceed_always') {
      this.emit('tool_status', { toolId: callId, status: 'approved' });
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        updatedPermissions: pending.suggestions,
        toolUseID: pending.toolUseID,
      });
    } else {
      this.emit('tool_status', { toolId: callId, status: 'approved' });
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        toolUseID: pending.toolUseID,
      });
    }
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

  private _buildQueryOptions(): Options {
    const options: Options = {
      cwd: this.projectPath,
      tools: { type: 'preset', preset: 'claude_code' },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'user'],
      includePartialMessages: true,
      abortController: this._abortController,
    };

    if (this._yolo) {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
    } else if (this._planModeActive) {
      options.permissionMode = 'plan';
      options.canUseTool = this._canUseTool.bind(this) as CanUseTool;
    } else {
      options.permissionMode = 'default';
      options.canUseTool = this._canUseTool.bind(this) as CanUseTool;
    }

    if (this._sessionId) {
      options.resume = this._sessionId;
    }

    return options;
  }

  private async _processMessages(): Promise<void> {
    if (this._processing) return;
    this._processing = true;
    let msgCount = 0;

    log.debug('_processMessages started', { instanceId: this.instanceId });

    try {
      for await (const message of this._query!) {
        msgCount++;
        const msgMeta: Record<string, unknown> = {
          n: msgCount,
          type: message.type,
        };
        if (message.type === 'stream_event') {
          msgMeta['event'] = message['event']?.type;
        }
        if ('uuid' in message) msgMeta['uuid'] = message['uuid'];
        if ('session_id' in message) msgMeta['session_id'] = message['session_id'];
        log.debug('SDK message received', msgMeta);

        this._handleMessage(message);
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
      this.emit('streaming_state', { state: 'idle' as StreamingState });
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

  private _handleMessage(message: any): void {
    switch (message.type) {
      case 'stream_event':
        this._handleStreamEvent(message);
        break;

      case 'assistant':
        this._handleAssistantMessage(message);
        break;

      case 'user':
        this._handleToolResults(message);
        break;

      case 'result':
        this._handleResult(message);
        break;

      case 'system':
        log.debug('SDK system message', { subtype: message.subtype });
        break;

      default:
        log.debug('Unhandled message type', {
          type: (message as { type: string }).type,
        });
        break;
    }
  }

  private _handleStreamEvent(message: any): void {
    const parsed = this._parser.parseStreamEvent(message);
    if (!parsed) return;

    switch (parsed.type) {
      case 'text_start':
        this.emit('streaming_state', { state: 'responding' as StreamingState });
        break;
      case 'text_delta':
        if (parsed.text) {
          this.emit('text_delta', { text: parsed.text });
        }
        break;
      case 'tool_start':
        this.emit('streaming_state', { state: 'tool' as StreamingState });
        break;
    }
  }

  private _handleAssistantMessage(message: any): void {
    const parsed = this._parser.parseAssistantMessage(message);

    // Emit complete text parts
    for (const text of parsed.textParts) {
      this.emit('text_complete', { text });
    }

    // Emit tool uses
    for (const tool of parsed.toolUses) {
      const toolInfo: ToolInfo = {
        callId: tool.id,
        name: tool.name,
        input: tool.input,
        description: `${tool.name}(${JSON.stringify(tool.input).slice(0, 50)}...)`,
      };
      this.emit('tool_added', { tool: toolInfo });
    }
  }

  private _handleToolResults(message: any): void {
    const results = this._parser.parseToolResults(message);

    for (const result of results) {
      this.emit('tool_result', { toolId: result.toolId, result });
    }

    this.emit('streaming_state', { state: 'responding' as StreamingState });
  }

  private _handleResult(message: any): void {
    this._sessionId = message.session_id;
    this.emit('streaming_state', { state: 'idle' as StreamingState });
    this.emit('session_complete', { sessionId: message.session_id });
    log.debug('Query complete', {
      subtype: message.subtype,
      session_id: message.session_id,
      cost: message.total_cost_usd,
      turns: message.num_turns,
      duration_ms: message.duration_ms,
    });
  }

  private async _canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      decisionReason?: string;
      toolUseID: string;
    }
  ): Promise<PermissionResult> {
    const callId = options.toolUseID;
    log.debug('🔍 canUseTool CALLED', {
      toolName,
      callId,
      decisionReason: options.decisionReason,
    });

    const details = this._confirmationBuilder.build(toolName, input as any, options);

    // Emit tool with confirmation details
    const toolInfo: ToolInfo = {
      callId,
      name: toolName,
      input,
      description: details.title || `${toolName}(...)`,
    };

    this.emit('tool_added', { tool: toolInfo, confirmationDetails: details });
    this.emit('streaming_state', { state: 'waiting_for_confirmation' as StreamingState });

    // Wait for iOS app to respond
    return new Promise<PermissionResult>((resolve) => {
      this._pendingConfirmations.set(callId, {
        resolve,
        toolUseID: callId,
        input,
        suggestions: options.suggestions,
      });
    });
  }
}

// Re-export types for convenience
export type { ToolInput, KnownToolInput, ToolStatus, StreamingState } from './types.js';
export { AsyncPushQueue } from './async-queue.js';
export { ClaudeError, ModelFetchError, SessionNotInitializedError, QueryAbortedError } from './errors.js';
