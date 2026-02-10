import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'cmd' | 'trace';

const LOG_DIR = join(homedir(), '.gemini-web', 'logs');
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  /* ignore */
}

const dateStr = new Date().toISOString().slice(0, 10);
const LOG_FILE = join(LOG_DIR, `server-${dateStr}.log`);

/** Path to the current log file (for startup messages). */
export const logFilePath = LOG_FILE;

const fmtTs = (): string => new Date().toISOString();

function formatArg(a: unknown): string {
  if (typeof a === 'object' && a !== null) {
    try {
      return JSON.stringify(a, null, 2);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

export function fileLog(level: string, tag: string, ...args: unknown[]): void {
  const line = `${fmtTs()} [${level}] [${tag}] ${args.map(formatArg).join(' ')}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    /* ignore */
  }
}

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Debug-level log: always to file, console only with GEMINI_WEB_DEBUG. */
export function log(...args: unknown[]): void {
  fileLog('DEBUG', 'web', ...args);
  if (debugEnabled) {
    console.log('[web]', ...args);
  }
}

/** Info-level log: always to file AND console. Use for important operational events. */
export function logInfo(...args: unknown[]): void {
  fileLog('INFO', 'web', ...args);
  console.log('[web]', ...args);
}

export function logCommand(
  sessionId: string,
  body: unknown,
  response: unknown,
): void {
  fileLog(
    'CMD',
    'command',
    JSON.stringify({
      ts: fmtTs(),
      sessionId,
      request: body,
      response,
    }),
  );
}

/** Logger scoped to a tag (e.g. 'claude', 'gemini') */
export function createTaggedLogger(tag: string) {
  return {
    debug(...args: unknown[]): void {
      fileLog('DEBUG', tag, ...args);
      if (debugEnabled) console.log(`[${tag}]`, ...args);
    },
    info(...args: unknown[]): void {
      fileLog('INFO', tag, ...args);
      console.log(`[${tag}]`, ...args);
    },
    warn(...args: unknown[]): void {
      fileLog('WARN', tag, ...args);
      console.warn(`[${tag}]`, ...args);
    },
    error(...args: unknown[]): void {
      fileLog('ERROR', tag, ...args);
      console.error(`[${tag}]`, ...args);
    },
    trace(...args: unknown[]): void {
      fileLog('TRACE', tag, ...args);
    },
  };
}
