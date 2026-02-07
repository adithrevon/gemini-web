import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');

const port = Number(process.env.GEMINI_WEB_PORT ?? '7337');
const wsPath = process.env.GEMINI_WEB_WS_PATH ?? '/ws';
const spawnTimeoutMs = Number(
  process.env.GEMINI_WEB_SPAWN_TIMEOUT_MS ?? '18000',
);
const debug =
  process.env.GEMINI_WEB_DEBUG === '1' ||
  process.env.GEMINI_WEB_DEBUG === 'true';
const log = (...args) => {
  if (debug) {
    console.log('[web]', ...args);
  }
};

const readJsonBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

// Multi-instance tracking
// Map: instanceId -> { id, sessionId, cliSocket, projectPath, process, status, error, lastSnapshot, spawnTimeout }
const instances = new Map();
// Map: sessionId -> { id, activeInstanceId, instances, sseClients, lastSeenAt }
const sessions = new Map();

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

const sendSse = (res, payload) => {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // Ignore write errors; caller will clean up.
  }
};

const createSession = () => {
  const id = crypto.randomUUID();
  const session = {
    id,
    activeInstanceId: null,
    instances: new Set(),
    sseClients: new Set(),
    lastSeenAt: Date.now(),
  };
  sessions.set(id, session);
  return session;
};

const getSessionInstances = (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) return [];
  const list = [];
  for (const instanceId of session.instances) {
    const inst = instances.get(instanceId);
    if (!inst) continue;
    list.push({
      id: inst.id,
      projectPath: inst.projectPath,
      connected: inst.status === 'connected',
      status: inst.status,
      error: inst.error,
    });
  }
  return list;
};

const sendToSession = (sessionId, payload) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.lastSeenAt = Date.now();
  for (const res of session.sseClients) {
    try {
      sendSse(res, payload);
    } catch {
      session.sseClients.delete(res);
    }
  }
};

const broadcastToAllSessions = (payload) => {
  for (const session of sessions.values()) {
    sendToSession(session.id, payload);
  }
};

const sendInstanceList = (sessionId) => {
  const instancesList = getSessionInstances(sessionId);
  sendToSession(sessionId, {
    type: 'bridge:instance-list',
    instances: instancesList,
  });
};

const sendSessionState = (session, res) => {
  const instancesList = getSessionInstances(session.id);
  const snapshots = [];
  for (const instInfo of instancesList) {
    const inst = instances.get(instInfo.id);
    if (inst?.lastSnapshot) {
      snapshots.push(inst.lastSnapshot);
    }
  }
  sendSse(res, {
    type: 'session_state',
    sessionId: session.id,
    activeInstanceId: session.activeInstanceId ?? null,
    instances: instancesList,
    snapshots,
  });
};

const resolveProjectPath = (projectPath) => {
  const expandedPath = expandTilde(projectPath);
  const basePath = existsSync(expandedPath) ? expandedPath : rootDir;
  try {
    return realpathSync(basePath);
  } catch {
    return basePath;
  }
};

const markInstanceError = (instanceId, message) => {
  const inst = instances.get(instanceId);
  if (!inst) return;
  if (inst.spawnTimeout) {
    clearTimeout(inst.spawnTimeout);
    inst.spawnTimeout = null;
  }
  if (inst.cliSocket) {
    inst.cliSocket.close();
    inst.cliSocket = null;
  }
  inst.status = 'error';
  inst.error = message;
  inst.process = null;
  if (inst.sessionId) {
    sendToSession(inst.sessionId, {
      type: 'bridge:error',
      instanceId,
      error: message,
    });
    sendToSession(inst.sessionId, {
      type: 'bridge:cli-status',
      connected: false,
      instanceId,
      status: 'error',
      error: message,
    });
    sendInstanceList(inst.sessionId);
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

const spawnCliInstance = async (
  instanceId,
  projectPath,
  sessionId,
  resolvedPathOverride,
) => {
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

  const cwd = resolvedPathOverride ?? resolveProjectPath(projectPath);

  log('spawn cli', {
    instanceId,
    requestedPath: projectPath,
    resolvedPath: cwd,
    cliEntry,
  });

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

  instances.set(instanceId, {
    id: instanceId,
    sessionId,
    cliSocket: null,
    projectPath: cwd,
    process: null,
    outputBuffer,
    status: 'connecting',
    error: null,
    lastSnapshot: null,
    spawnTimeout: null,
  });

  const session = sessions.get(sessionId);
  if (session) {
    session.instances.add(instanceId);
    session.activeInstanceId = instanceId;
  }

  sendToSession(sessionId, {
    type: 'bridge:cli-status',
    connected: false,
    instanceId,
    status: 'connecting',
  });
  sendInstanceList(sessionId);

  const scheduleSpawnTimeout = () => {
    const timeout = setTimeout(() => {
      const inst = instances.get(instanceId);
      if (!inst || inst.status === 'connected') return;
      markInstanceError(instanceId, 'CLI failed to connect');
    }, spawnTimeoutMs);
    instances.get(instanceId).spawnTimeout = timeout;
  };

  scheduleSpawnTimeout();

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
      const inst = instances.get(instanceId);
      if (inst && inst.status !== 'connected') {
        markInstanceError(instanceId, 'CLI failed to start');
        return;
      }
      cleanupInstance(instanceId, 'exit');
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
      console.log(
        `[web] CLI instance ${instanceId} exited with code ${code ?? 'unknown'}.`,
      );
      if (debug && outputBuffer.length > 0) {
        console.log(`[web] CLI ${instanceId} output (tail)`);
        console.log(outputBuffer.join('').slice(-bufferLimit));
      }
      const inst = instances.get(instanceId);
      if (inst && inst.status !== 'connected') {
        markInstanceError(instanceId, 'CLI failed to start');
        return;
      }
      cleanupInstance(instanceId, 'exit');
    });
    child.on('error', (err) => {
      console.log(`[web] CLI ${instanceId} spawn error`, err);
      markInstanceError(instanceId, 'CLI failed to start');
    });
  }
};

const cleanupInstance = (instanceId, reason) => {
  const inst = instances.get(instanceId);
  if (!inst) return;
  if (inst.spawnTimeout) {
    clearTimeout(inst.spawnTimeout);
  }
  if (inst.cliSocket) {
    inst.cliSocket.close();
  }
  const sessionId = inst.sessionId;
  instances.delete(instanceId);
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      session.instances.delete(instanceId);
      if (session.activeInstanceId === instanceId) {
        session.activeInstanceId = null;
      }
    }
    sendToSession(sessionId, {
      type: 'bridge:cli-status',
      connected: false,
      instanceId,
      status: 'disconnected',
    });
    sendInstanceList(sessionId);
  } else if (reason !== 'exit') {
    broadcastToAllSessions({
      type: 'bridge:cli-status',
      connected: false,
      instanceId,
      status: 'disconnected',
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

  if (inst.spawnTimeout) {
    clearTimeout(inst.spawnTimeout);
  }

  if (inst.process) {
    if (typeof inst.process.kill === 'function') {
      inst.process.kill();
    } else if (typeof inst.process.destroy === 'function') {
      inst.process.destroy();
    }
  }

  if (inst.cliSocket) {
    inst.cliSocket.close();
  }

  cleanupInstance(instanceId, 'terminate');
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );

    // Health check endpoint for server validation
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok', timestamp: Date.now() });
      return;
    }

    // Browse directories endpoint
    if (url.pathname === '/api/browse' && req.method === 'GET') {
      const dirPath = url.searchParams.get('path') || os.homedir();
      try {
        const resolvedPath = dirPath.startsWith('~')
          ? path.join(os.homedir(), dirPath.slice(1))
          : path.resolve(dirPath);

        const { readdirSync, statSync } = await import('node:fs');
        const entries = readdirSync(resolvedPath, { withFileTypes: true });

        const directories = entries
          .filter((entry) => {
            // Filter out hidden files and only include directories
            if (entry.name.startsWith('.')) return false;
            try {
              return entry.isDirectory();
            } catch {
              return false;
            }
          })
          .map((entry) => ({
            name: entry.name,
            path: path.join(resolvedPath, entry.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        // Check if this directory is a project (has common project indicators)
        const isProject = entries.some((e) =>
          ['package.json', '.git', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Gemfile', '.xcodeproj', '.xcworkspace'].some(
            (indicator) => e.name === indicator || e.name.endsWith('.xcodeproj') || e.name.endsWith('.xcworkspace')
          )
        );

        sendJson(res, 200, {
          path: resolvedPath,
          parent: path.dirname(resolvedPath),
          directories,
          isProject,
          name: path.basename(resolvedPath),
        });
      } catch (err) {
        sendJson(res, 400, { error: err.message || 'Failed to read directory' });
      }
      return;
    }

    // Validate path endpoint
    if (url.pathname === '/api/validate-path' && req.method === 'GET') {
      const dirPath = url.searchParams.get('path');
      if (!dirPath) {
        sendJson(res, 400, { error: 'Missing path parameter' });
        return;
      }
      try {
        const resolvedPath = dirPath.startsWith('~')
          ? path.join(os.homedir(), dirPath.slice(1))
          : path.resolve(dirPath);

        const { statSync, readdirSync } = await import('node:fs');
        const stat = statSync(resolvedPath);

        if (!stat.isDirectory()) {
          sendJson(res, 400, { error: 'Path is not a directory', valid: false });
          return;
        }

        // Check if it's a project directory
        const entries = readdirSync(resolvedPath);
        const isProject = entries.some((e) =>
          ['package.json', '.git', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Gemfile'].includes(e) ||
          e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace')
        );

        sendJson(res, 200, {
          valid: true,
          path: resolvedPath,
          name: path.basename(resolvedPath),
          isProject,
        });
      } catch (err) {
        sendJson(res, 400, { error: 'Directory does not exist', valid: false });
      }
      return;
    }

    if (url.pathname === '/api/session' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const requestedId =
        body && typeof body.sessionId === 'string' ? body.sessionId : null;
      const session =
        requestedId && sessions.has(requestedId)
          ? sessions.get(requestedId)
          : createSession();
      session.lastSeenAt = Date.now();
      sendJson(res, 200, { sessionId: session.id });
      return;
    }

    if (url.pathname.startsWith('/api/session/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const rawSessionId = parts[2];
      const action = parts[3];
      const sessionId = rawSessionId ? decodeURIComponent(rawSessionId) : null;
      if (!sessionId) {
        sendJson(res, 404, { error: 'Session not found' });
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, { error: 'Session not found' });
        return;
      }

      if (action === 'events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('\n');

        session.sseClients.add(res);
        session.lastSeenAt = Date.now();
        sendSessionState(session, res);

        req.on('close', () => {
          session.sseClients.delete(res);
        });
        return;
      }

      if (action === 'command' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || typeof body.type !== 'string') {
          sendJson(res, 400, { error: 'Invalid payload' });
          return;
        }
        session.lastSeenAt = Date.now();

        if (body.type === 'spawnInstance') {
          const projectPath =
            typeof body.projectPath === 'string' ? body.projectPath : '';
          if (!projectPath) {
            sendJson(res, 400, { error: 'Missing projectPath' });
            return;
          }
          const instanceId = crypto.randomUUID();
          const resolvedPath = resolveProjectPath(projectPath);
          void spawnCliInstance(instanceId, projectPath, sessionId, resolvedPath);
          sendJson(res, 200, { instanceId, resolvedPath });
          return;
        }

        if (body.type === 'terminateInstance') {
          const instanceId =
            typeof body.instanceId === 'string' ? body.instanceId : '';
          if (!instanceId) {
            sendJson(res, 400, { error: 'Missing instanceId' });
            return;
          }
          const inst = instances.get(instanceId);
          if (!inst || inst.sessionId !== sessionId) {
            sendJson(res, 403, { error: 'Instance not found in session' });
            return;
          }
          terminateInstance(instanceId);
          sendJson(res, 200, { ok: true });
          return;
        }

        if (body.type === 'setActiveInstance') {
          const instanceId =
            typeof body.instanceId === 'string' ? body.instanceId : '';
          if (instanceId) {
            const inst = instances.get(instanceId);
            if (!inst || inst.sessionId !== sessionId) {
              sendJson(res, 403, { error: 'Instance not found in session' });
              return;
            }
          }
          session.activeInstanceId = instanceId || null;
          sendJson(res, 200, { ok: true });
          return;
        }

        if (body.type === 'interrupt') {
          const instanceId =
            typeof body.instanceId === 'string' ? body.instanceId : '';
          if (!instanceId) {
            sendJson(res, 400, { error: 'Missing instanceId' });
            return;
          }
          const inst = instances.get(instanceId);
          if (!inst || inst.sessionId !== sessionId) {
            sendJson(res, 403, { error: 'Instance not found in session' });
            return;
          }
          if (!inst.process) {
            sendJson(res, 409, { error: 'CLI process not running' });
            return;
          }

          log('interrupt instance', instanceId);

          // Send Ctrl+C (SIGINT) to interrupt the current operation
          try {
            if (typeof inst.process.write === 'function') {
              // node-pty: send Ctrl+C character
              inst.process.write('\x03');
            } else if (inst.process.stdin) {
              // spawn: write to stdin
              inst.process.stdin.write('\x03');
            } else if (typeof inst.process.kill === 'function') {
              // Fallback: send SIGINT signal
              inst.process.kill('SIGINT');
            }
            sendJson(res, 200, { ok: true });
          } catch (err) {
            log('interrupt error', err);
            sendJson(res, 500, { error: 'Failed to interrupt' });
          }
          return;
        }

        if (
          body.type === 'submit' ||
          body.type === 'confirm' ||
          body.type === 'setModel'
        ) {
          const instanceId =
            typeof body.instanceId === 'string' ? body.instanceId : '';
          if (!instanceId) {
            sendJson(res, 400, { error: 'Missing instanceId' });
            return;
          }
          const inst = instances.get(instanceId);
          if (!inst || inst.sessionId !== sessionId) {
            sendJson(res, 403, { error: 'Instance not found in session' });
            return;
          }
          if (!inst || !isSocketOpen(inst.cliSocket)) {
            sendToSession(sessionId, {
              type: 'bridge:cli-status',
              connected: false,
              instanceId,
              status: 'disconnected',
            });
            sendInstanceList(sessionId);
            sendJson(res, 409, { error: 'CLI not connected' });
            return;
          }

          const { instanceId: _, ...forwardMessage } = body;
          safeSend(inst.cliSocket, JSON.stringify(forwardMessage));
          sendJson(res, 200, { ok: true });
          return;
        }

        sendJson(res, 400, { error: 'Unsupported command' });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // No static file serving - iOS app is the only frontend
    res.writeHead(404);
    res.end('Not found');
  } catch (error) {
    res.writeHead(500);
    res.end('Internal server error');
  }
});

const wss = new WebSocketServer({ server, path: wsPath });

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
      if (role !== 'cli') {
        socket.close();
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

      if (instanceId && !boundInstanceId) {
        boundInstanceId = instanceId;
        let inst = instances.get(instanceId);
        if (inst) {
          inst.cliSocket = socket;
        } else {
          inst = {
            id: instanceId,
            sessionId: null,
            cliSocket: socket,
            projectPath: message.payload?.projectPath ?? '',
            process: null,
            outputBuffer: [],
            status: 'connected',
            error: null,
            lastSnapshot: null,
            spawnTimeout: null,
          };
          instances.set(instanceId, inst);
        }
        if (inst.spawnTimeout) {
          clearTimeout(inst.spawnTimeout);
          inst.spawnTimeout = null;
        }
        inst.status = 'connected';
        inst.error = null;

        if (inst.sessionId) {
          sendToSession(inst.sessionId, {
            type: 'bridge:cli-status',
            connected: true,
            instanceId,
            status: 'connected',
          });
          sendInstanceList(inst.sessionId);
        } else {
          broadcastToAllSessions({
            type: 'bridge:cli-status',
            connected: true,
            instanceId,
            status: 'connected',
          });
        }
      }

      const inst = instanceId ? instances.get(instanceId) : null;
      if (inst) {
        if (inst.spawnTimeout) {
          clearTimeout(inst.spawnTimeout);
          inst.spawnTimeout = null;
        }
        inst.status = 'connected';
        inst.error = null;
        inst.lastSnapshot = message.payload;
        if (message.payload?.projectPath) {
          inst.projectPath = message.payload.projectPath;
        }
        if (inst.sessionId) {
          sendToSession(inst.sessionId, message);
        } else {
          broadcastToAllSessions(message);
        }
      }
      return;
    }
  });

  socket.on('error', () => {
    // Keep server alive; connection cleanup handled by close.
  });

  socket.on('close', () => {
    log('ws close', role, boundInstanceId);
    if (role === 'cli' && boundInstanceId) {
      const inst = instances.get(boundInstanceId);
      if (inst && inst.cliSocket === socket) {
        inst.cliSocket = null;
        inst.status = inst.status === 'error' ? 'error' : 'disconnected';
        if (inst.sessionId) {
          sendToSession(inst.sessionId, {
            type: 'bridge:cli-status',
            connected: false,
            instanceId: boundInstanceId,
            status: inst.status,
            error: inst.error,
          });
          sendInstanceList(inst.sessionId);
        } else {
          broadcastToAllSessions({
            type: 'bridge:cli-status',
            connected: false,
            instanceId: boundInstanceId,
            status: inst.status,
            error: inst.error,
          });
        }
      }
    }
  });
});

wss.on('error', () => {
  // Avoid crashing on transient websocket errors.
});

server.listen(port, () => {
  console.log(`[web] API server listening on http://localhost:${port}`);
  console.log(`[web] Connect iOS app to this server to spawn CLI instances.`);
});
