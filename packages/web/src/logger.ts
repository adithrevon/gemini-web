import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import pino from 'pino';

const LOG_DIR = join(homedir(), '.claude-web', 'logs');

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {}

cleanupOldLogs(LOG_DIR, 14);

const dateStr = new Date().toISOString().slice(0, 10);
export const logFilePath = join(LOG_DIR, `server-${dateStr}.log`);

const debugEnabled = process.env['CLAUDE_WEB_DEBUG'] === '1';
const isDev = process.env['NODE_ENV'] !== 'production';

const transport = isDev
  ? pino.transport({
      targets: [
        {
          target: 'pino-pretty',
          level: 'debug',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
        {
          target: 'pino/file',
          level: 'info',
          options: { destination: logFilePath },
        },
      ],
    })
  : pino.destination({ dest: logFilePath, sync: false });

export const logger = pino(
  {
    level: debugEnabled ? 'debug' : 'info',
    serializers: { err: pino.stdSerializers.err },
    base: { service: 'claude-web', env: process.env.NODE_ENV },
  },
  transport
);

export const createLogger = (component: string) => {
  const child = logger.child({ component });
  return {
    debug: (msg: string, data?: object) => child.debug(data || {}, msg),
    info: (msg: string, data?: object) => child.info(data || {}, msg),
    warn: (msg: string, data?: object) => child.warn(data || {}, msg),
    error: (msg: string, err?: unknown, data?: object) =>
      child.error({ err, ...data }, msg),
    trace: (msg: string, data?: object) => child.trace(data || {}, msg),
  };
};

export function logCommand(sessionId: string, body: unknown, response: unknown) {
  logger.info({ component: 'command', sessionId, request: body, response }, 'Command executed');
}

function cleanupOldLogs(dir: string, days = 14) {
  const cutoff = Date.now() - days * 86400000;
  for (const file of readdirSync(dir)) {
    if (!file.startsWith('server-')) continue;
    const date = file.slice(7, 17);
    if (Date.parse(date) < cutoff) {
      try { unlinkSync(join(dir, file)); } catch {}
    }
  }
}