import type http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { WebSocket } from 'ws';

/** Read JSON body from an incoming HTTP request. Returns null on empty/invalid. */
export async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) as unknown : null;
  } catch {
    return null;
  }
}

/** Send a JSON response. */
export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Write an SSE data frame. */
export function sendSse(res: http.ServerResponse, payload: unknown): void {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // Ignore write errors; caller will clean up.
  }
}

/** Expand ~ to user's home directory. */
export function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  if (filePath === '~') {
    return os.homedir();
  }
  return filePath;
}

/** Resolve a project path: expand tilde, check existence, resolve symlinks. */
export function resolveProjectPath(projectPath: string, rootDir: string): string {
  const expandedPath = expandTilde(projectPath);
  const basePath = existsSync(expandedPath) ? expandedPath : rootDir;
  try {
    return realpathSync(basePath);
  } catch {
    return basePath;
  }
}

/** Check if a WebSocket is open. */
export function isSocketOpen(socket: WebSocket | null): socket is WebSocket {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

/** Safely parse a JSON buffer/string. Returns null on failure. */
export function safeParse(raw: unknown): unknown {
  if (raw == null) return null;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Safely send a string over a WebSocket. Returns success. */
export function safeSend(socket: WebSocket | null, payload: string): boolean {
  if (!isSocketOpen(socket)) return false;
  try {
    socket.send(payload);
    return true;
  } catch {
    return false;
  }
}
