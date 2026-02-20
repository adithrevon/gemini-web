import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerConfig } from '../types.js';
import { GeminiWebServer } from '../server.js';

export interface TestServer {
  baseUrl: string;
  port: number;
  server: GeminiWebServer;
  cleanup: () => Promise<void>;
}

export async function startTestServer(
  configOverrides?: Partial<ServerConfig>,
): Promise<TestServer> {
  const config: ServerConfig = {
    port: 0, // random port
    wsPath: '/ws',
    spawnTimeoutMs: 5000,
    debug: false,
    cliLog: false,
    rootDir: '/tmp',
    ...configOverrides,
  };

  const server = new GeminiWebServer(config);
  const actualPort = await server.listen(0);
  const baseUrl = `http://127.0.0.1:${actualPort}`;

  return {
    baseUrl,
    port: actualPort,
    server,
    cleanup: () => server.close(),
  };
}

/** POST JSON to a URL. */
export async function post(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

/** GET a URL. */
export async function get(
  baseUrl: string,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

export type MockAnthropicEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop';

export interface MockAnthropicSseEvent {
  event: MockAnthropicEventType;
  data: Record<string, unknown>;
  delayMs?: number;
}

export interface MockAnthropicRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  body: unknown;
}

export interface MockAnthropicScenarioContext {
  request: MockAnthropicRequest;
  requestCount: number;
  hitCount: number;
}

export type MockAnthropicScenarioMatcher = (
  request: MockAnthropicRequest,
  requestCount: number,
) => boolean;

export type MockAnthropicScenarioResponse =
  | MockAnthropicSseEvent[]
  | ((
      ctx: MockAnthropicScenarioContext,
    ) => MockAnthropicSseEvent[] | null | undefined);

export interface MockAnthropicScenario {
  name?: string;
  match?: MockAnthropicScenarioMatcher;
  response: MockAnthropicScenarioResponse;
  once?: boolean;
}

export interface MockAnthropicServer {
  baseUrl: string;
  port: number;
  requests: MockAnthropicRequest[];
  setScenarios: (scenarios: MockAnthropicScenario[]) => void;
  addScenario: (scenario: MockAnthropicScenario) => void;
  enqueueResponse: (events: MockAnthropicSseEvent[]) => void;
  setResponseResolver: (resolver: MockAnthropicResponseResolver | null) => void;
  reset: () => void;
  cleanup: () => Promise<void>;
}

export type MockAnthropicResponseResolver = (
  request: MockAnthropicRequest,
  requestCount: number,
) => MockAnthropicSseEvent[] | null | undefined;

export interface MockAnthropicTextResponseOptions {
  text: string;
  chunks?: string[];
  messageId?: string;
  model?: string;
  index?: number;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string | null;
  delayMs?: number;
}

export interface MockAnthropicToolUseResponseOptions {
  toolUseId: string;
  toolName?: string;
  input?: Record<string, unknown>;
  inputJsonChunks?: string[];
  messageId?: string;
  model?: string;
  index?: number;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string | null;
  delayMs?: number;
}

const DEFAULT_MOCK_MODEL = 'claude-3-5-sonnet-20241022';

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let rawBody = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      rawBody += chunk;
    });
    req.on('end', () => resolve(rawBody));
    req.on('error', reject);
  });
}

function isExpectedAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name =
    typeof (error as { name?: unknown }).name === 'string'
      ? ((error as { name: string }).name as string)
      : '';
  const message =
    typeof (error as { message?: unknown }).message === 'string'
      ? ((error as { message: string }).message as string).toLowerCase()
      : '';
  return (
    name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('terminated')
  );
}

function writeSseEvent(
  res: ServerResponse<IncomingMessage>,
  event: MockAnthropicSseEvent,
): void {
  res.write(`event: ${event.event}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

export const anthropicSse = {
  event(
    event: MockAnthropicEventType,
    data: Record<string, unknown>,
    delayMs?: number,
  ): MockAnthropicSseEvent {
    return { event, data, delayMs };
  },

  messageStart(opts?: {
    messageId?: string;
    model?: string;
    role?: string;
    content?: unknown[];
    inputTokens?: number;
    outputTokens?: number;
  }): MockAnthropicSseEvent {
    return {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: opts?.messageId ?? 'msg_mock',
          type: 'message',
          role: opts?.role ?? 'assistant',
          model: opts?.model ?? DEFAULT_MOCK_MODEL,
          content: opts?.content ?? [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: opts?.inputTokens ?? 1,
            output_tokens: opts?.outputTokens ?? 0,
          },
        },
      },
    };
  },

  contentBlockStart(
    index: number,
    contentBlock: Record<string, unknown>,
  ): MockAnthropicSseEvent {
    return {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: contentBlock,
      },
    };
  },

  contentBlockDelta(
    index: number,
    delta: Record<string, unknown>,
    delayMs?: number,
  ): MockAnthropicSseEvent {
    return {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index,
        delta,
      },
      delayMs,
    };
  },

  contentBlockStop(index: number): MockAnthropicSseEvent {
    return {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index },
    };
  },

  messageDelta(opts?: {
    stopReason?: string | null;
    stopSequence?: string | null;
    outputTokens?: number;
  }): MockAnthropicSseEvent {
    return {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: opts?.stopReason ?? 'end_turn',
          stop_sequence: opts?.stopSequence ?? null,
        },
        usage: { output_tokens: opts?.outputTokens ?? 1 },
      },
    };
  },

  messageStop(): MockAnthropicSseEvent {
    return {
      event: 'message_stop',
      data: { type: 'message_stop' },
    };
  },

  textResponse(
    opts: MockAnthropicTextResponseOptions,
  ): MockAnthropicSseEvent[] {
    const chunks = opts.chunks ?? [opts.text];
    const index = opts.index ?? 0;

    return [
      anthropicSse.messageStart({
        messageId: opts.messageId,
        model: opts.model,
        inputTokens: opts.inputTokens ?? 3,
      }),
      anthropicSse.contentBlockStart(index, { type: 'text', text: '' }),
      ...chunks.map((chunk) =>
        anthropicSse.contentBlockDelta(
          index,
          { type: 'text_delta', text: chunk },
          opts.delayMs,
        ),
      ),
      anthropicSse.contentBlockStop(index),
      anthropicSse.messageDelta({
        stopReason: opts.stopReason ?? 'end_turn',
        outputTokens: opts.outputTokens ?? Math.max(1, opts.text.length),
      }),
      anthropicSse.messageStop(),
    ];
  },

  toolUseResponse(
    opts: MockAnthropicToolUseResponseOptions,
  ): MockAnthropicSseEvent[] {
    const index = opts.index ?? 0;
    const chunks = opts.inputJsonChunks ?? [JSON.stringify(opts.input ?? {})];

    return [
      anthropicSse.messageStart({
        messageId: opts.messageId,
        model: opts.model,
        inputTokens: opts.inputTokens ?? 4,
      }),
      anthropicSse.contentBlockStart(index, {
        type: 'tool_use',
        id: opts.toolUseId,
        name: opts.toolName ?? 'Bash',
        input: {},
      }),
      ...chunks.map((chunk) =>
        anthropicSse.contentBlockDelta(
          index,
          { type: 'input_json_delta', partial_json: chunk },
          opts.delayMs,
        ),
      ),
      anthropicSse.contentBlockStop(index),
      anthropicSse.messageDelta({
        stopReason: opts.stopReason ?? 'tool_use',
        outputTokens: opts.outputTokens ?? 1,
      }),
      anthropicSse.messageStop(),
    ];
  },
};

export function bodyContainsMatcher(
  snippet: string,
): MockAnthropicScenarioMatcher {
  return (request) => request.rawBody.includes(snippet);
}

function buildDefaultTextEvents(
  requestNumber: number,
): MockAnthropicSseEvent[] {
  return anthropicSse.textResponse({
    messageId: `msg_mock_${requestNumber}`,
    text: 'mock response',
    inputTokens: 1,
  });
}

/** Start a local mock Anthropic API server that streams SSE for /v1/messages. */
export async function startMockAnthropicServer(): Promise<MockAnthropicServer> {
  const requests: MockAnthropicRequest[] = [];
  const responseQueue: MockAnthropicSseEvent[][] = [];
  let scenarios: MockAnthropicScenario[] = [];
  const scenarioHits = new Map<number, number>();
  let responseResolver: MockAnthropicResponseResolver | null = null;
  let requestCount = 0;

  const resolveScenarioResponse = (
    request: MockAnthropicRequest,
    currentRequestCount: number,
  ): MockAnthropicSseEvent[] | null => {
    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i]!;
      const hitCount = scenarioHits.get(i) ?? 0;
      if (scenario.once && hitCount > 0) continue;

      const matches = scenario.match
        ? scenario.match(request, currentRequestCount)
        : true;
      if (!matches) continue;

      const response = Array.isArray(scenario.response)
        ? scenario.response
        : scenario.response({
            request,
            requestCount: currentRequestCount,
            hitCount: hitCount + 1,
          });

      if (response == null) continue;
      scenarioHits.set(i, hitCount + 1);
      return response;
    }

    return null;
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');

        if (req.method === 'POST' && url.pathname === '/v1/messages') {
          const rawBody = await readRequestBody(req);
          let parsedBody: unknown = null;
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            /* ignore */
          }

          requests.push({
            method: req.method,
            path: url.pathname,
            headers: req.headers,
            rawBody,
            body: parsedBody,
          });

          requestCount += 1;
          const request = requests[requests.length - 1]!;
          const scenarioResponse = resolveScenarioResponse(
            request,
            requestCount,
          );
          const resolverResponse = responseResolver?.(request, requestCount);
          const events =
            scenarioResponse ??
            resolverResponse ??
            responseQueue.shift() ??
            buildDefaultTextEvents(requestCount);

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          for (const event of events) {
            writeSseEvent(res, event);
            if ((event.delayMs ?? 0) > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, event.delayMs),
              );
            }
          }

          res.end();
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'mock_server_error' }));
      }
    })();
  });

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve mock server address'));
        return;
      }
      resolve((address as AddressInfo).port);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    setScenarios: (nextScenarios: MockAnthropicScenario[]) => {
      scenarios = [...nextScenarios];
      scenarioHits.clear();
    },
    addScenario: (scenario: MockAnthropicScenario) => {
      scenarios = [...scenarios, scenario];
    },
    enqueueResponse: (events: MockAnthropicSseEvent[]) => {
      responseQueue.push(events);
    },
    setResponseResolver: (resolver: MockAnthropicResponseResolver | null) => {
      responseResolver = resolver;
    },
    reset: () => {
      requests.length = 0;
      responseQueue.length = 0;
      scenarios = [];
      scenarioHits.clear();
      responseResolver = null;
      requestCount = 0;
    },
    cleanup: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/** Collect SSE events for a given duration. */
export async function collectSseEvents(
  baseUrl: string,
  sessionId: string,
  durationMs: number,
): Promise<SseEvent[]> {
  const controller = new AbortController();
  const events: SseEvent[] = [];
  const timeout = setTimeout(() => controller.abort(), durationMs);

  try {
    const res = await fetch(`${baseUrl}/api/session/${sessionId}/events`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            events.push(JSON.parse(line.slice(6)) as SseEvent);
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch (e: unknown) {
    if (!isExpectedAbortError(e)) throw e;
  } finally {
    clearTimeout(timeout);
  }

  return events;
}
