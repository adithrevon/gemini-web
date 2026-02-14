import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import pino from 'pino';

const LOG_DIR = join(homedir(), '.claude-web', 'logs');
mkdirSync(LOG_DIR, { recursive: true });

const dateStr = new Date().toISOString().slice(0, 10);
export const logFilePath = join(LOG_DIR, `server-${dateStr}.log`);

const debugEnabled = process.env['CLAUDE_WEB_DEBUG'] === '1';
const isDev = process.env['NODE_ENV'] !== 'production';

const streams: pino.StreamEntry[] = [
  { stream: pino.destination({ dest: logFilePath, sync: false }) },
];

if (isDev) {
  streams.push({
    stream: pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }),
  });
}

export const logger = pino(
  {
    level: debugEnabled ? 'debug' : 'info',
    serializers: { err: pino.stdSerializers.err },
  },
  pino.multistream(streams)
);

export const createLogger = (component: string) => {
  const child = logger.child({ component });
  return {
    debug: (msg: string, data?: object) => child.debug(data || {}, msg),
    info: (msg: string, data?: object) => child.info(data || {}, msg),
    warn: (msg: string, data?: object) => child.warn(data || {}, msg),
    error: (msg: string, data?: object) => child.error(data || {}, msg),
    trace: (msg: string, data?: object) => child.trace(data || {}, msg),
  };
};

export function logCommand(sessionId: string, body: unknown, response: unknown) {
  logger.info(
    { component: 'command', sessionId, request: body, response },
    'Command executed'
  );
}
