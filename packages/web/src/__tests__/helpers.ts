import { WebSocket } from 'ws';

import type { ServerConfig, BridgeUpdatePayload } from '../types.js';
import { GeminiWebServer } from '../server.js';
import { setDebug } from '../logger.js';

setDebug(false);

export interface TestServer {
  baseUrl: string;
  port: number;
  server: GeminiWebServer;
  cleanup: () => Promise<void>;
}

export async function startTestServer(configOverrides?: Partial<ServerConfig>): Promise<TestServer> {
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
export async function post(baseUrl: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* ignore */ }
  return { status: res.status, json };
}

/** GET a URL. */
export async function get(baseUrl: string, path: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* ignore */ }
  return { status: res.status, json };
}

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/** Collect SSE events for a given duration. */
export async function collectSseEvents(baseUrl: string, sessionId: string, durationMs: number): Promise<SseEvent[]> {
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
          } catch { /* ignore */ }
        }
      }
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timeout);
  }

  return events;
}

/**
 * MockCliClient — simulates a Gemini CLI connecting via WebSocket.
 * Sends bridge:hello + bridge:update messages.
 */
export class MockCliClient {
  private ws: WebSocket | null = null;
  private _ready: Promise<void>;
  private _resolveReady!: () => void;

  constructor() {
    this._ready = new Promise(resolve => { this._resolveReady = resolve; });
  }

  async connect(port: number, instanceId: string, projectPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws.on('open', () => {
        // Send hello
        this.ws!.send(JSON.stringify({ type: 'bridge:hello', role: 'cli' }));
        // Send initial bridge:update
        this.sendUpdate(instanceId, projectPath, 'idle', [], []);
        this._resolveReady();
        resolve();
      });
      this.ws.on('error', reject);
    });
  }

  sendUpdate(
    instanceId: string,
    projectPath: string,
    streamingState: string,
    history: unknown[],
    pending: unknown[],
  ): void {
    if (!this.ws) return;
    const payload: BridgeUpdatePayload = {
      instanceId,
      projectPath,
      history: history as BridgeUpdatePayload['history'],
      pending: pending as BridgeUpdatePayload['pending'],
      streamingState: streamingState as BridgeUpdatePayload['streamingState'],
      isTrustedFolder: true,
      currentModel: 'gemini-2.0-flash',
      availableModels: [{ value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', description: null, isAuto: false }],
      hasPreviewAccess: false,
    };
    this.ws.send(JSON.stringify({ type: 'bridge:update', payload }));
  }

  /** Wait for the connection to be ready. */
  async ready(): Promise<void> {
    return this._ready;
  }

  /** Get messages received by the CLI mock. */
  onMessage(handler: (data: Record<string, unknown>) => void): void {
    this.ws?.on('message', (raw: Buffer | string) => {
      try {
        handler(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch { /* ignore */ }
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
