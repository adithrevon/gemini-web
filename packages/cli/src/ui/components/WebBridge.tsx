/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { WebSocket } from 'undici';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useToolActions } from '../contexts/ToolActionsContext.js';
import type {
  HistoryItem,
  HistoryItemWithoutId,
  HistoryItemToolGroup,
  IndividualToolCallDisplay,
  StreamingState,
  ToolCallStatus,
} from '../types.js';
import {
  MessageBusType,
  ToolConfirmationOutcome,
  type SerializableConfirmationDetails,
  type ToolConfirmationPayload,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_MODEL_AUTO,
  getDisplayString,
} from '@google/gemini-cli-core';
import type { ToolResultDisplay } from '@google/gemini-cli-core';

const DEFAULT_WS_URL = 'ws://127.0.0.1:7337/ws';

type BridgeToolCall = {
  callId: string;
  name: string;
  description: string;
  status: ToolCallStatus;
  resultDisplay: ToolResultDisplay | undefined;
  renderOutputAsMarkdown?: boolean;
  outputFile?: string;
  ptyId?: number;
  correlationId?: string;
  confirmationDetails?: SerializableConfirmationDetails;
};

type BridgeHistoryItem =
  | {
      id?: number;
      type: 'user' | 'gemini' | 'gemini_content';
      text: string;
    }
  | {
      id?: number;
      type: 'tool_group';
      tools: BridgeToolCall[];
    };

type BridgeModelOption = {
  value: string;
  label: string;
  description?: string;
  isAuto: boolean;
};

type BridgeSnapshot = {
  instanceId: string;
  projectPath: string;
  history: BridgeHistoryItem[];
  pending: BridgeHistoryItem[];
  streamingState: StreamingState;
  isTrustedFolder: boolean | undefined;
  currentModel: string;
  availableModels: BridgeModelOption[];
  hasPreviewAccess: boolean;
};

const sanitizeConfirmationDetails = (
  details: IndividualToolCallDisplay['confirmationDetails'],
): SerializableConfirmationDetails | undefined => {
  if (!details) return undefined;
  switch (details.type) {
    case 'edit':
      return {
        type: 'edit',
        title: details.title,
        fileName: details.fileName,
        filePath: details.filePath,
        fileDiff: details.fileDiff,
        originalContent: details.originalContent,
        newContent: details.newContent,
        isModifying: details.isModifying,
      };
    case 'exec':
      return {
        type: 'exec',
        title: details.title,
        command: details.command,
        rootCommand: details.rootCommand,
        rootCommands: details.rootCommands,
        commands: details.commands,
      };
    case 'mcp':
      return {
        type: 'mcp',
        title: details.title,
        serverName: details.serverName,
        toolName: details.toolName,
        toolDisplayName: details.toolDisplayName,
      };
    case 'info':
      return {
        type: 'info',
        title: details.title,
        prompt: details.prompt,
        urls: details.urls,
      };
    case 'ask_user':
      return {
        type: 'ask_user',
        title: details.title,
        questions: details.questions,
      };
    case 'exit_plan_mode':
      return {
        type: 'exit_plan_mode',
        title: details.title,
        planPath: details.planPath,
      };
    default:
      return undefined;
  }
};

const sanitizeToolCall = (tool: IndividualToolCallDisplay): BridgeToolCall => ({
  callId: tool.callId,
  name: tool.name,
  description: tool.description,
  status: tool.status,
  resultDisplay: tool.resultDisplay,
  renderOutputAsMarkdown: tool.renderOutputAsMarkdown,
  outputFile: tool.outputFile,
  ptyId: tool.ptyId,
  correlationId: tool.correlationId,
  confirmationDetails: sanitizeConfirmationDetails(tool.confirmationDetails),
});

const serializeHistoryItem = (
  item: HistoryItem | HistoryItemWithoutId,
  includeId: boolean,
): BridgeHistoryItem | null => {
  if (item.type === 'user') {
    return {
      id: includeId && 'id' in item ? item.id : undefined,
      type: 'user',
      text: item.text,
    };
  }
  if (item.type === 'gemini' || item.type === 'gemini_content') {
    return {
      id: includeId && 'id' in item ? item.id : undefined,
      type: item.type,
      text: item.text,
    };
  }
  if (item.type === 'tool_group') {
    const toolGroup = item as HistoryItemToolGroup;
    return {
      id: includeId ? (item as HistoryItem).id : undefined,
      type: 'tool_group',
      tools: toolGroup.tools.map(sanitizeToolCall),
    };
  }
  return null;
};

const getAvailableModels = (hasPreviewAccess: boolean): BridgeModelOption[] => {
  const models: BridgeModelOption[] = [];

  // Auto options first
  if (hasPreviewAccess) {
    models.push({
      value: PREVIEW_GEMINI_MODEL_AUTO,
      label: getDisplayString(PREVIEW_GEMINI_MODEL_AUTO),
      description: 'Let CLI decide: gemini-3-pro or gemini-3-flash',
      isAuto: true,
    });
  }
  models.push({
    value: DEFAULT_GEMINI_MODEL_AUTO,
    label: getDisplayString(DEFAULT_GEMINI_MODEL_AUTO),
    description: 'Let CLI decide: gemini-2.5-pro or gemini-2.5-flash',
    isAuto: true,
  });

  // Manual options
  if (hasPreviewAccess) {
    models.push(
      {
        value: PREVIEW_GEMINI_MODEL,
        label: PREVIEW_GEMINI_MODEL,
        isAuto: false,
      },
      {
        value: PREVIEW_GEMINI_FLASH_MODEL,
        label: PREVIEW_GEMINI_FLASH_MODEL,
        isAuto: false,
      },
    );
  }
  models.push(
    { value: DEFAULT_GEMINI_MODEL, label: DEFAULT_GEMINI_MODEL, isAuto: false },
    {
      value: DEFAULT_GEMINI_FLASH_MODEL,
      label: DEFAULT_GEMINI_FLASH_MODEL,
      isAuto: false,
    },
    {
      value: DEFAULT_GEMINI_FLASH_LITE_MODEL,
      label: DEFAULT_GEMINI_FLASH_LITE_MODEL,
      isAuto: false,
    },
  );

  return models;
};

const safeParseMessage = (raw: unknown): Record<string, unknown> | null => {
  let text: string | null = null;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString('utf8');
  } else if (raw instanceof Uint8Array) {
    text = Buffer.from(raw).toString('utf8');
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString('utf8');
  } else if (
    raw &&
    typeof (raw as { toString?: () => string }).toString === 'function'
  ) {
    text = (raw as { toString: () => string }).toString();
  }

  if (text === null) {
    return null;
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const WebBridge = () => {
  const uiState = useUIState();
  const uiActions = useUIActions();
  const config = useConfig();
  const toolActions = useToolActions();
  const wsRef = useRef<WebSocket | null>(null);
  const snapshotRef = useRef<BridgeSnapshot | null>(null);
  const lastPayloadRef = useRef<string>('');
  const url = process.env['GEMINI_WEB_WS_URL'] ?? DEFAULT_WS_URL;
  const debug =
    process.env['GEMINI_WEB_DEBUG'] === '1' ||
    process.env['GEMINI_WEB_DEBUG'] === 'true';
  const log = (...args: unknown[]) => {
    if (debug) {
      console.log('[web-bridge]', ...args);
    }
  };

  const hasPreviewAccess = Boolean(
    config?.getPreviewFeatures() && config?.getHasAccessToPreviewModel(),
  );
  const [currentModel, setCurrentModel] = useState(
    () => config?.getModel() ?? DEFAULT_GEMINI_MODEL_AUTO,
  );
  const availableModels = useMemo(
    () => getAvailableModels(hasPreviewAccess),
    [hasPreviewAccess],
  );

  const snapshot = useMemo<BridgeSnapshot>(() => {
    const history = uiState.history
      .map((item) => serializeHistoryItem(item, true))
      .filter((item): item is BridgeHistoryItem => item !== null);
    const pending = uiState.pendingHistoryItems
      .map((item) => serializeHistoryItem(item, false))
      .filter((item): item is BridgeHistoryItem => item !== null);
    return {
      instanceId: process.env['GEMINI_INSTANCE_ID'] ?? 'default',
      projectPath: process.cwd(),
      history,
      pending,
      streamingState: uiState.streamingState,
      isTrustedFolder: uiState.isTrustedFolder,
      currentModel,
      availableModels,
      hasPreviewAccess,
    };
  }, [
    uiState.history,
    uiState.pendingHistoryItems,
    uiState.streamingState,
    uiState.isTrustedFolder,
    currentModel,
    availableModels,
    hasPreviewAccess,
  ]);

  const findToolInfo = (
    callId: string,
  ): { correlationId?: string; source: 'pending' | 'history' } | null => {
    const search = (
      items: Array<HistoryItem | HistoryItemWithoutId>,
      source: 'pending' | 'history',
    ) => {
      for (const item of items) {
        if (item.type !== 'tool_group') continue;
        const tool = item.tools.find((t) => t.callId === callId);
        if (tool) {
          return { correlationId: tool.correlationId, source };
        }
      }
      return null;
    };
    return (
      search(uiState.pendingHistoryItems, 'pending') ??
      search(uiState.history, 'history')
    );
  };

  snapshotRef.current = snapshot;

  useEffect(() => {
    let closed = false;
    let retryTimer: NodeJS.Timeout | undefined;

    const connect = () => {
      if (closed) return;
      log('connecting', url);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        log('open');
        ws.send(JSON.stringify({ type: 'bridge:hello', role: 'cli' }));
        const initial = snapshotRef.current;
        if (initial) {
          const payload = JSON.stringify({
            type: 'bridge:update',
            payload: initial,
          });
          lastPayloadRef.current = payload;
          log('send initial snapshot', {
            history: initial.history.length,
            pending: initial.pending.length,
            streamingState: initial.streamingState,
          });
          ws.send(payload);
        }
      };

      ws.onmessage = (event) => {
        const message = safeParseMessage(event.data);
        if (!message) return;
        const messageType =
          typeof message['type'] === 'string' ? message['type'] : '';
        log('message', messageType);
        if (messageType === 'submit') {
          const text =
            typeof message['text'] === 'string' ? message['text'] : '';
          const trimmed = text.trim();
          if (trimmed.length === 0) {
            return;
          }
          log('submit', { length: trimmed.length });
          uiActions.handleFinalSubmit(trimmed);
          return;
        }
        if (messageType === 'confirm') {
          const callId =
            typeof message['callId'] === 'string' ? message['callId'] : '';
          const outcomeRaw =
            typeof message['outcome'] === 'string' ? message['outcome'] : '';
          const payload =
            message['payload'] && typeof message['payload'] === 'object'
              ? (message['payload'] as ToolConfirmationPayload)
              : undefined;
          const correlationId =
            typeof message['correlationId'] === 'string'
              ? message['correlationId']
              : undefined;
          const lookup = callId ? findToolInfo(callId) : null;
          const outcome = (
            Object.values(ToolConfirmationOutcome) as string[]
          ).includes(outcomeRaw)
            ? (outcomeRaw as ToolConfirmationOutcome)
            : ToolConfirmationOutcome.Cancel;
          log('confirm', {
            callId,
            outcome,
            correlationId,
            lookupSource: lookup?.source,
          });
          const resolvedCorrelationId = correlationId ?? lookup?.correlationId;

          if (callId && lookup?.source === 'pending') {
            void toolActions
              .confirm(callId, outcome, payload)
              .catch((error: unknown) => {
                log('confirm error', error);
              });
            return;
          }

          if (resolvedCorrelationId) {
            void config
              .getMessageBus()
              .publish({
                type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
                correlationId: resolvedCorrelationId,
                confirmed: outcome !== ToolConfirmationOutcome.Cancel,
                requiresUserConfirmation: false,
                outcome,
                payload,
              })
              .catch((error: unknown) => {
                log('confirm publish error', error);
              });
            return;
          }

          if (!callId) {
            log('confirm missing callId');
            return;
          }

          void toolActions
            .confirm(callId, outcome, payload)
            .catch((error: unknown) => {
              log('confirm error', error);
            });
          return;
        }
        if (messageType === 'stdin') {
          log('stdin ignored (submit-only mode)');
        }
        if (messageType === 'setModel') {
          const model =
            typeof message['model'] === 'string' ? message['model'] : '';
          if (model && config) {
            log('setModel', { model });
            config.setModel(model, true); // temporary = true (session only)
            setCurrentModel(model); // Update React state to trigger snapshot update
          }
          return;
        }
      };

      ws.onerror = (event) => {
        log('error', event);
      };

      ws.onclose = () => {
        log('close');
        if (closed) return;
        retryTimer = setTimeout(connect, 1000);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      wsRef.current?.close();
    };
  }, [url]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify({
      type: 'bridge:update',
      payload: snapshot,
    });
    if (payload === lastPayloadRef.current) return;
    lastPayloadRef.current = payload;
    log('send update', {
      history: snapshot.history.length,
      pending: snapshot.pending.length,
      streamingState: snapshot.streamingState,
    });
    ws.send(payload);
  }, [snapshot]);

  return null;
};
