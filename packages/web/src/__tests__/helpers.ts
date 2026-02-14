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
    if (e instanceof Error && e.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timeout);
  }

  return events;
}

