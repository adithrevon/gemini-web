import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ServerConfig } from './types.js';
import { GeminiWebServer } from './server.js';
import { setDebug } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// In dev (tsx): src/ → ../../..  In dist: dist/ → ../../..
const rootDir = path.resolve(__dirname, '..', '..', '..');

const config: ServerConfig = {
  port: Number(process.env['GEMINI_WEB_PORT'] ?? '7337'),
  wsPath: process.env['GEMINI_WEB_WS_PATH'] ?? '/ws',
  spawnTimeoutMs: Number(process.env['GEMINI_WEB_SPAWN_TIMEOUT_MS'] ?? '18000'),
  debug:
    process.env['GEMINI_WEB_DEBUG'] === '1' ||
    process.env['GEMINI_WEB_DEBUG'] === 'true',
  cliLog: !!process.env['GEMINI_WEB_CLI_LOG'],
  rootDir,
};

setDebug(config.debug);

const server = new GeminiWebServer(config);
try {
  await server.listen();
} catch {
  process.exit(1);
}
