import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');
// Serve from Vite build output (dist) or fallback to public for dev
const distDir = path.join(__dirname, 'dist');
const publicDir = existsSync(distDir) ? distDir : path.join(__dirname, 'public');

const port = Number(process.env.GEMINI_WEB_PORT ?? '7337');
const wsPath = process.env.GEMINI_WEB_WS_PATH ?? '/ws';
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

// Multi-instance tracking
// Map: instanceId -> { cliSocket, projectPath, process }
const instances = new Map();
// Set of connected web clients
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

// Expand ~ to user's home directory
const expandTilde = (filePath) => {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  if (filePath === '~') {
    return os.homedir();
  }
  return filePath;
};

const broadcastInstanceList = () => {
  const instanceList = [];
  for (const [id, inst] of instances) {
    instanceList.push({
      id,
      projectPath: inst.projectPath,
      connected: isSocketOpen(inst.cliSocket),
    });
  }
  broadcast({ type: 'bridge:instance-list', instances: instanceList });
};

const spawnCliInstance = async (instanceId, projectPath) => {
  const defaultBundle = path.join(rootDir, 'bundle', 'gemini.js');
  const distEntry = path.join(rootDir, 'packages', 'cli', 'dist', 'index.js');
  const cliEntry =
    process.env.GEMINI_WEB_CLI_PATH ??
    (existsSync(distEntry) ? distEntry : defaultBundle);
  const cliArgs = process.env.GEMINI_WEB_CLI_ARGS
    ? process.env.GEMINI_WEB_CLI_ARGS.split(' ')
    : [];

  const wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
  const env = {
    ...process.env,
    GEMINI_WEB_WS_URL: wsUrl,
    GEMINI_INSTANCE_ID: instanceId,
  };

  // Expand and validate project path
  const expandedPath = expandTilde(projectPath);
  const cwd = existsSync(expandedPath) ? expandedPath : rootDir;
  
  log('spawn cli', { instanceId, requestedPath: projectPath, resolvedPath: cwd, cliEntry });
  
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

  // Store instance info before spawning
  instances.set(instanceId, {
    cliSocket: null,
    projectPath: cwd,
    process: null,
    outputBuffer,
  });

  // Notify web clients about new instance
  broadcast({ type: 'bridge:cli-status', connected: false, instanceId });

  try {
    const ptyModule = await import('node-pty');
    const pty = ptyModule.default ?? ptyModule;
    const ptyProcess = pty.spawn(process.execPath, [cliEntry, ...cliArgs], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env,
    });

    instances.get(instanceId).process = ptyProcess;

    ptyProcess.onData((data) => {
      recordOutput(data);
      if (process.env.GEMINI_WEB_CLI_LOG) {
        process.stdout.write(data);
      }
    });

    ptyProcess.onExit((event) => {
      console.log(
        `[web] CLI instance ${instanceId} exited with code ${event.exitCode} (signal: ${event.signal ?? 'none'}).`,
      );
      if (debug && outputBuffer.length > 0) {
        console.log(`[web] CLI ${instanceId} output (tail)`);
        console.log(outputBuffer.join('').slice(-bufferLimit));
      }
      // Cleanup instance
      const inst = instances.get(instanceId);
      if (inst?.cliSocket) {
        inst.cliSocket.close();
      }
      instances.delete(instanceId);
      broadcast({ type: 'bridge:cli-status', connected: false, instanceId });
      broadcastInstanceList();
    });
  } catch (error) {
    console.log('[web] node-pty not available; falling back to spawn().');
    const child = spawn(process.execPath, [cliEntry, ...cliArgs], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    instances.get(instanceId).process = child;

    if (process.env.GEMINI_WEB_CLI_LOG) {
      child.stdout.on('data', (data) => process.stdout.write(data));
      child.stderr.on('data', (data) => process.stderr.write(data));
    }
    child.stdout.on('data', recordOutput);
    child.stderr.on('data', recordOutput);

    child.on('exit', (code) => {
      console.log(`[web] CLI instance ${instanceId} exited with code ${code ?? 'unknown'}.`);
      if (debug && outputBuffer.length > 0) {
        console.log(`[web] CLI ${instanceId} output (tail)`);
        console.log(outputBuffer.join('').slice(-bufferLimit));
      }
      // Cleanup instance
      const inst = instances.get(instanceId);
      if (inst?.cliSocket) {
        inst.cliSocket.close();
      }
      instances.delete(instanceId);
      broadcast({ type: 'bridge:cli-status', connected: false, instanceId });
      broadcastInstanceList();
    });
    child.on('error', (err) => {
      console.log(`[web] CLI ${instanceId} spawn error`, err);
    });
  }
};

const terminateInstance = (instanceId) => {
  const inst = instances.get(instanceId);
  if (!inst) {
    log('terminate: instance not found', instanceId);
    return;
  }
  log('terminate instance', instanceId);
  
  // Kill the process
  if (inst.process) {
    if (typeof inst.process.kill === 'function') {
      inst.process.kill();
    } else if (typeof inst.process.destroy === 'function') {
      inst.process.destroy();
    }
  }
  
  // Close the socket
  if (inst.cliSocket) {
    inst.cliSocket.close();
  }
  
  instances.delete(instanceId);
  broadcast({ type: 'bridge:cli-status', connected: false, instanceId });
  broadcastInstanceList();
};

wss.on('connection', (socket) => {
  let role = 'unknown';
  let boundInstanceId = null;
  log('ws connection');

  socket.on('message', (raw) => {
    const message = safeParse(raw);
    if (!message) return;

    if (message.type === 'bridge:hello') {
      role = message.role === 'cli' ? 'cli' : 'web';
      log('hello', role);
      
      if (role === 'cli') {
        // CLI connecting - need to find which instance this is
        // The CLI will send GEMINI_INSTANCE_ID in its first update
        // For now, store socket temporarily
        boundInstanceId = null;
      } else {
        webSockets.add(socket);
        // Send current instance list to new web client
        broadcastInstanceList();
      }
      return;
    }

    if (role === 'cli' && message.type === 'bridge:update') {
      const instanceId = message.payload?.instanceId;
      log('bridge:update', {
        instanceId,
        history: message.payload?.history?.length ?? 0,
        pending: message.payload?.pending?.length ?? 0,
        streamingState: message.payload?.streamingState ?? 'unknown',
      });
      
      // Bind this socket to the instance
      if (instanceId && !boundInstanceId) {
        boundInstanceId = instanceId;
        const inst = instances.get(instanceId);
        if (inst) {
          inst.cliSocket = socket;
          broadcast({ type: 'bridge:cli-status', connected: true, instanceId });
        } else {
          // Instance started externally (e.g., for development)
          instances.set(instanceId, {
            cliSocket: socket,
            projectPath: message.payload?.projectPath ?? '',
            process: null,
            outputBuffer: [],
          });
          broadcast({ type: 'bridge:cli-status', connected: true, instanceId });
        }
        broadcastInstanceList();
      }
      
      broadcast(message);
      return;
    }

    // Messages from web clients
    if (role === 'web') {
      if (message.type === 'spawnInstance') {
        const instanceId = crypto.randomUUID();
        log('spawn request', { instanceId, projectPath: message.projectPath });
        spawnCliInstance(instanceId, message.projectPath);
        return;
      }

      if (message.type === 'terminateInstance') {
        log('terminate request', message.instanceId);
        terminateInstance(message.instanceId);
        return;
      }

      if (message.type === 'setActiveInstance') {
        // Just acknowledgement, no action needed server-side
        log('setActiveInstance', message.instanceId);
        return;
      }

      // Route messages to specific instance
      if (message.type === 'submit' || message.type === 'confirm' || message.type === 'setModel') {
        const instanceId = message.instanceId;
        const inst = instances.get(instanceId);
        
        if (message.type === 'submit') {
          log('submit from web', { instanceId, length: message.text?.length ?? 0 });
        } else if (message.type === 'confirm') {
          log('confirm from web', {
            instanceId,
            callId: message.callId,
            outcome: message.outcome,
            correlationId: message.correlationId,
          });
        } else if (message.type === 'setModel') {
          log('setModel from web', { instanceId, model: message.model });
        }
        
        if (!inst || !isSocketOpen(inst.cliSocket)) {
          log('instance not connected', instanceId);
          broadcast({ type: 'bridge:cli-status', connected: false, instanceId });
          return;
        }
        
        // Forward to CLI (remove instanceId from message as CLI doesn't need it)
        const { instanceId: _, ...forwardMessage } = message;
        safeSend(inst.cliSocket, JSON.stringify(forwardMessage));
      }
    }
  });

  socket.on('error', () => {
    // Keep server alive; connection cleanup handled by close.
  });

  socket.on('close', () => {
    log('ws close', role, boundInstanceId);
    if (role === 'web') {
      webSockets.delete(socket);
      return;
    }

    if (role === 'cli' && boundInstanceId) {
      const inst = instances.get(boundInstanceId);
      if (inst && inst.cliSocket === socket) {
        inst.cliSocket = null;
        broadcast({ type: 'bridge:cli-status', connected: false, instanceId: boundInstanceId });
        broadcastInstanceList();
      }
    }
  });
});

wss.on('error', () => {
  // Avoid crashing on transient websocket errors.
});

server.listen(port, () => {
  console.log(`[web] Listening on http://localhost:${port}`);
  console.log(`[web] Multi-instance mode enabled. Use web UI to spawn instances.`);
});
