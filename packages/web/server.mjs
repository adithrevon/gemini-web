import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');
const publicDir = path.join(__dirname, 'public');

const port = Number(process.env.GEMINI_WEB_PORT ?? '7337');
const wsPath = process.env.GEMINI_WEB_WS_PATH ?? '/ws';
const wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
const debug =
  process.env.GEMINI_WEB_DEBUG === '1' ||
  process.env.GEMINI_WEB_DEBUG === 'true';
const log = (...args) => {
  if (debug) {
    console.log('[web]', ...args);
  }
};

const contentTypeByExt = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.normalize(path.join(publicDir, pathname));

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': contentTypeByExt.get(ext) ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (error) {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: wsPath });
let cliSocket = null;
const webSockets = new Set();

const isSocketOpen = (socket) =>
  socket && socket.readyState === WebSocket.OPEN;

const safeParse = (raw) => {
  if (raw == null) return null;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const safeSend = (socket, payload) => {
  if (!isSocketOpen(socket)) return false;
  try {
    socket.send(payload);
    return true;
  } catch {
    return false;
  }
};

const broadcast = (payload) => {
  const data = JSON.stringify(payload);
  for (const socket of webSockets) {
    if (!safeSend(socket, data)) {
      webSockets.delete(socket);
    }
  }
};

wss.on('connection', (socket) => {
  let role = 'unknown';
  log('ws connection');

  socket.on('message', (raw) => {
    const message = safeParse(raw);
    if (!message) return;

    if (message.type === 'bridge:hello') {
      role = message.role === 'cli' ? 'cli' : 'web';
      log('hello', role);
      if (role === 'cli') {
        if (isSocketOpen(cliSocket)) {
          cliSocket.close();
        }
        cliSocket = socket;
        broadcast({ type: 'bridge:cli-status', connected: true });
      } else {
        webSockets.add(socket);
        socket.send(
          JSON.stringify({
            type: 'bridge:cli-status',
            connected: Boolean(cliSocket),
          }),
        );
      }
      return;
    }

    if (role === 'cli' && message.type === 'bridge:update') {
      log('bridge:update', {
        history: message.payload?.history?.length ?? 0,
        pending: message.payload?.pending?.length ?? 0,
        streamingState: message.payload?.streamingState ?? 'unknown',
      });
      broadcast(message);
      return;
    }

    if (role === 'web' && (message.type === 'submit' || message.type === 'confirm')) {
      if (message.type === 'submit') {
        log('submit from web', { length: message.text?.length ?? 0 });
      } else {
        log('confirm from web', {
          callId: message.callId,
          outcome: message.outcome,
          correlationId: message.correlationId,
        });
      }
      if (!isSocketOpen(cliSocket)) {
        cliSocket = null;
        broadcast({ type: 'bridge:cli-status', connected: false });
        return;
      }
      safeSend(cliSocket, JSON.stringify(message));
    }
  });

  socket.on('error', () => {
    // Keep server alive; connection cleanup handled by close.
  });

  socket.on('close', () => {
    log('ws close', role);
    if (role === 'web') {
      webSockets.delete(socket);
      return;
    }

    if (role === 'cli' && cliSocket === socket) {
      cliSocket = null;
      broadcast({ type: 'bridge:cli-status', connected: false });
    }
  });
});

wss.on('error', () => {
  // Avoid crashing on transient websocket errors.
});

const startCli = async () => {
  const defaultBundle = path.join(rootDir, 'bundle', 'gemini.js');
  const distEntry = path.join(rootDir, 'packages', 'cli', 'dist', 'index.js');
  const cliEntry =
    process.env.GEMINI_WEB_CLI_PATH ??
    (existsSync(distEntry) ? distEntry : defaultBundle);
  const cliArgs = process.env.GEMINI_WEB_CLI_ARGS
    ? process.env.GEMINI_WEB_CLI_ARGS.split(' ')
    : [];

  const env = {
    ...process.env,
    GEMINI_WEB_WS_URL: wsUrl,
  };
  log('spawn cli', cliEntry, cliArgs);
  const outputBuffer = [];
  const bufferLimit = 20000;
  const recordOutput = (chunk) => {
    if (!debug) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    outputBuffer.push(text);
    const joined = outputBuffer.join('');
    if (joined.length > bufferLimit) {
      outputBuffer.length = 0;
      outputBuffer.push(joined.slice(-bufferLimit));
    }
  };

  try {
    const ptyModule = await import('node-pty');
    const pty = ptyModule.default ?? ptyModule;
    const ptyProcess = pty.spawn(process.execPath, [cliEntry, ...cliArgs], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: rootDir,
      env,
    });

    ptyProcess.onData((data) => {
      recordOutput(data);
      if (process.env.GEMINI_WEB_CLI_LOG) {
        process.stdout.write(data);
      }
    });

    ptyProcess.onExit((event) => {
      console.log(
        `[web] CLI exited with code ${event.exitCode} (signal: ${event.signal ?? 'none'}).`,
      );
      if (debug && outputBuffer.length > 0) {
        console.log('[web] CLI output (tail)');
        console.log(outputBuffer.join('').slice(-bufferLimit));
      }
    });
  } catch (error) {
    console.log('[web] node-pty not available; falling back to spawn().');
    const child = spawn(process.execPath, [cliEntry, ...cliArgs], {
      cwd: rootDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (process.env.GEMINI_WEB_CLI_LOG) {
      child.stdout.on('data', (data) => process.stdout.write(data));
      child.stderr.on('data', (data) => process.stderr.write(data));
    }
    child.stdout.on('data', recordOutput);
    child.stderr.on('data', recordOutput);

    child.on('exit', (code) => {
      console.log(`[web] CLI exited with code ${code ?? 'unknown'}.`);
      if (debug && outputBuffer.length > 0) {
        console.log('[web] CLI output (tail)');
        console.log(outputBuffer.join('').slice(-bufferLimit));
      }
    });
    child.on('error', (err) => {
      console.log('[web] CLI spawn error', err);
    });
  }
};

server.listen(port, () => {
  console.log(`[web] Listening on http://localhost:${port}`);
  startCli();
});
