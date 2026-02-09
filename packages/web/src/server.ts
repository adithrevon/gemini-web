import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';

import type { Provider } from './provider.js';
import type {
  ServerConfig,
  InstanceStatus,
  ProviderName,
  BridgeUpdatePayload,
  SessionInstanceInfo,
  SseEvent,
} from './types.js';
import { GeminiBridge } from './gemini-bridge.js';
import { ClaudeBridge } from './claude-bridge.js';
import { handleWsConnection } from './ws-handler.js';
import { readJsonBody, sendJson, sendSse, resolveProjectPath } from './utils.js';
import { log, logInfo, logCommand, fileLog, logFilePath } from './logger.js';

// --- Internal types ---

interface Instance {
  id: string;
  sessionId: string | null;
  provider: Provider;
  providerName: ProviderName;
  projectPath: string;
  status: InstanceStatus;
  error: string | null;
  lastSnapshot: BridgeUpdatePayload | null;
}

interface Session {
  id: string;
  activeInstanceId: string | null;
  instances: Set<string>;
  sseClients: Set<http.ServerResponse>;
  lastSeenAt: number;
}

// --- Server ---

export class GeminiWebServer {
  private config: ServerConfig;
  private sessions = new Map<string, Session>();
  private instances = new Map<string, Instance>();
  private httpServer: http.Server;
  private wss: WebSocketServer;

  constructor(config: ServerConfig) {
    this.config = config;
    this.httpServer = http.createServer((req, res) => {
      void this._handleRequest(req, res);
    });
    this.wss = new WebSocketServer({ server: this.httpServer, path: config.wsPath });
    this._setupWss();
  }

  listen(port?: number): Promise<number> {
    const p = port ?? this.config.port;
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[web] ERROR: Port ${p} is already in use.`);
          console.error(`[web] Kill the existing process: lsof -ti :${p} | xargs kill`);
        } else {
          console.error(`[web] ERROR: Failed to start server: ${err.message}`);
        }
        reject(err);
      });
      this.httpServer.listen(p, () => {
        const addr = this.httpServer.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : p;
        console.log(`[web] API server listening on http://localhost:${actualPort}`);
        console.log(`[web] Connect iOS app to this server to spawn CLI instances.`);
        console.log(`[web] Logs → ${logFilePath}`);
        if (!this.config.debug) {
          console.log(`[web] Set GEMINI_WEB_DEBUG=1 for verbose console output.`);
        }
        resolve(actualPort);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      // Clean up all instances
      for (const instanceId of [...this.instances.keys()]) {
        this._terminateInstance(instanceId);
      }
      // Close all SSE connections
      for (const session of this.sessions.values()) {
        for (const res of session.sseClients) {
          try { res.end(); } catch { /* ignore */ }
        }
      }
      this.wss.close(() => {
        this.httpServer.close(() => resolve());
      });
    });
  }

  /** Expose for testing */
  get server(): http.Server {
    return this.httpServer;
  }

  // --- Session management ---

  private _createSession(): Session {
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      activeInstanceId: null,
      instances: new Set(),
      sseClients: new Set(),
      lastSeenAt: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  private _getSessionInstances(sessionId: string): SessionInstanceInfo[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const list: SessionInstanceInfo[] = [];
    for (const instanceId of session.instances) {
      const inst = this.instances.get(instanceId);
      if (!inst) continue;
      list.push({
        id: inst.id,
        projectPath: inst.projectPath,
        connected: inst.status === 'connected',
        status: inst.status,
        error: inst.error,
        provider: inst.providerName,
      });
    }
    return list;
  }

  private _sendToSession(sessionId: string, payload: SseEvent | Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastSeenAt = Date.now();
    for (const res of session.sseClients) {
      try {
        sendSse(res, payload);
      } catch {
        session.sseClients.delete(res);
      }
    }
  }

  private _broadcastToAllSessions(payload: SseEvent | Record<string, unknown>): void {
    for (const session of this.sessions.values()) {
      this._sendToSession(session.id, payload);
    }
  }

  private _sendInstanceList(sessionId: string): void {
    const instancesList = this._getSessionInstances(sessionId);
    this._sendToSession(sessionId, {
      type: 'bridge:instance-list',
      instances: instancesList,
    });
  }

  private _sendSessionState(session: Session, res: http.ServerResponse): void {
    const instancesList = this._getSessionInstances(session.id);
    const snapshots: BridgeUpdatePayload[] = [];
    for (const instInfo of instancesList) {
      const inst = this.instances.get(instInfo.id);
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
  }

  // --- Instance lifecycle ---

  private _markInstanceError(instanceId: string, message: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    inst.status = 'error';
    inst.error = message;
    if (inst.sessionId) {
      this._sendToSession(inst.sessionId, {
        type: 'bridge:error',
        instanceId,
        error: message,
      });
      this._sendToSession(inst.sessionId, {
        type: 'bridge:cli-status',
        connected: false,
        instanceId,
        status: 'error' as const,
        error: message,
      });
      this._sendInstanceList(inst.sessionId);
    }
  }

  private async _spawnGeminiInstance(
    instanceId: string,
    projectPath: string,
    sessionId: string,
    resolvedPath: string,
    yolo = false,
  ): Promise<void> {
    const callbacks = {
      onStatusChange: (status: 'connecting' | 'connected' | 'disconnected' | 'error', error?: string) => {
        const inst = this.instances.get(instanceId);
        if (!inst) return;
        inst.status = status;
        if (error) inst.error = error;
        else if (status === 'connected') inst.error = null;

        if (status === 'connected') {
          logInfo(`gemini CLI connected for instance ${instanceId.slice(0, 8)}…`);
        } else if (status === 'error') {
          logInfo(`gemini instance ${instanceId.slice(0, 8)}… error: ${error ?? 'unknown'}`);
        }

        if (inst.sessionId) {
          this._sendToSession(inst.sessionId, {
            type: 'bridge:cli-status',
            connected: status === 'connected',
            instanceId,
            status,
            error: error ?? null,
          });
          this._sendInstanceList(inst.sessionId);
        } else {
          this._broadcastToAllSessions({
            type: 'bridge:cli-status',
            connected: status === 'connected',
            instanceId,
            status,
            error: error ?? null,
          });
        }
      },
      onBridgeUpdate: (payload: BridgeUpdatePayload) => {
        const inst = this.instances.get(instanceId);
        if (!inst) return;
        inst.lastSnapshot = payload;
        if (payload.projectPath) {
          inst.projectPath = payload.projectPath;
        }
        const event = { type: 'bridge:update' as const, payload };
        if (inst.sessionId) {
          this._sendToSession(inst.sessionId, event);
        } else {
          this._broadcastToAllSessions(event);
        }
      },
      onExit: () => {
        this._cleanupInstance(instanceId, 'exit');
      },
      onError: (message: string) => {
        this._markInstanceError(instanceId, message);
      },
    };

    const bridge = new GeminiBridge({
      instanceId,
      projectPath: resolvedPath,
      config: this.config,
      callbacks,
      yolo,
    });

    const inst: Instance = {
      id: instanceId,
      sessionId,
      provider: bridge,
      providerName: 'gemini',
      projectPath: resolvedPath,
      status: 'connecting',
      error: null,
      lastSnapshot: null,
    };
    this.instances.set(instanceId, inst);

    const session = this.sessions.get(sessionId);
    if (session) {
      session.instances.add(instanceId);
      session.activeInstanceId = instanceId;
    }

    this._sendToSession(sessionId, {
      type: 'bridge:cli-status',
      connected: false,
      instanceId,
      status: 'connecting' as const,
    });
    this._sendInstanceList(sessionId);

    await bridge.start();
  }

  private async _spawnClaudeInstance(
    instanceId: string,
    projectPath: string,
    sessionId: string,
    resolvedPath: string,
    yolo = false,
  ): Promise<void> {
    log('spawn claude', { instanceId, requestedPath: projectPath, resolvedPath });

    const emitUpdate = (snapshot: { type: 'bridge:update'; payload: BridgeUpdatePayload }) => {
      const inst = this.instances.get(instanceId);
      if (!inst) return;
      inst.lastSnapshot = snapshot.payload;
      this._sendToSession(sessionId, snapshot);
    };

    const bridge = new ClaudeBridge({ instanceId, projectPath: resolvedPath, emitUpdate, yolo });

    const inst: Instance = {
      id: instanceId,
      sessionId,
      provider: bridge,
      providerName: 'claude',
      projectPath: resolvedPath,
      status: 'connecting',
      error: null,
      lastSnapshot: null,
    };
    this.instances.set(instanceId, inst);

    const session = this.sessions.get(sessionId);
    if (session) {
      session.instances.add(instanceId);
      session.activeInstanceId = instanceId;
    }

    this._sendToSession(sessionId, {
      type: 'bridge:cli-status',
      connected: false,
      instanceId,
      status: 'connecting' as const,
    });
    this._sendInstanceList(sessionId);

    try {
      await bridge.start();
      inst.status = 'connected';
      inst.error = null;

      this._sendToSession(sessionId, {
        type: 'bridge:cli-status',
        connected: true,
        instanceId,
        status: 'connected' as const,
      });
      this._sendInstanceList(sessionId);

      // Emit initial empty snapshot
      emitUpdate({ type: 'bridge:update', payload: bridge.accumulator.snapshot() });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('Claude spawn error:', msg);
      this._markInstanceError(instanceId, msg || 'Claude SDK not available');
    }
  }

  private _cleanupInstance(instanceId: string, reason: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    inst.provider.destroy();
    const sessionId = inst.sessionId;
    this.instances.delete(instanceId);
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.instances.delete(instanceId);
        if (session.activeInstanceId === instanceId) {
          session.activeInstanceId = null;
        }
      }
      this._sendToSession(sessionId, {
        type: 'bridge:cli-status',
        connected: false,
        instanceId,
        status: 'disconnected' as const,
      });
      this._sendInstanceList(sessionId);
    } else if (reason !== 'exit') {
      this._broadcastToAllSessions({
        type: 'bridge:cli-status',
        connected: false,
        instanceId,
        status: 'disconnected' as const,
      });
    }
  }

  private _terminateInstance(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) {
      log('terminate: instance not found', instanceId);
      return;
    }
    log('terminate instance', instanceId);
    inst.provider.destroy();
    this._cleanupInstance(instanceId, 'terminate');
  }

  // --- WebSocket setup ---

  private _setupWss(): void {
    this.wss.on('connection', (socket: WebSocket) => {
      handleWsConnection(socket, {
        getGeminiBridge: (instanceId: string): GeminiBridge | null => {
          const inst = this.instances.get(instanceId);
          if (!inst || inst.providerName !== 'gemini') return null;
          return inst.provider as GeminiBridge;
        },
        onOrphanCliConnect: (instanceId: string, socket: WebSocket, payload: BridgeUpdatePayload) => {
          // CLI connected but we didn't spawn it — create orphan instance entry
          const bridge = new GeminiBridge({
            instanceId,
            projectPath: payload.projectPath ?? '',
            config: this.config,
            callbacks: {
              onStatusChange: (status, error) => {
                const inst = this.instances.get(instanceId);
                if (!inst) return;
                inst.status = status;
                if (error) inst.error = error;
                this._broadcastToAllSessions({
                  type: 'bridge:cli-status',
                  connected: status === 'connected',
                  instanceId,
                  status,
                  error: error ?? null,
                });
              },
              onBridgeUpdate: (p) => {
                const inst = this.instances.get(instanceId);
                if (!inst) return;
                inst.lastSnapshot = p;
                this._broadcastToAllSessions({ type: 'bridge:update', payload: p });
              },
              onExit: () => this._cleanupInstance(instanceId, 'exit'),
              onError: (msg) => this._markInstanceError(instanceId, msg),
            },
          });
          bridge.bindSocket(socket);
          const inst: Instance = {
            id: instanceId,
            sessionId: null,
            provider: bridge,
            providerName: 'gemini',
            projectPath: payload.projectPath ?? '',
            status: 'connected',
            error: null,
            lastSnapshot: payload,
          };
          this.instances.set(instanceId, inst);
          this._broadcastToAllSessions({
            type: 'bridge:cli-status',
            connected: true,
            instanceId,
            status: 'connected' as const,
          });
        },
      });
    });

    this.wss.on('error', () => {
      // Avoid crashing on transient websocket errors.
    });
  }

  // --- HTTP request handling ---

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(
        req.url ?? '/',
        `http://${req.headers.host ?? 'localhost'}`,
      );

      // Health check
      if (url.pathname === '/health' && req.method === 'GET') {
        fileLog('INFO', 'http', 'GET /health');
        sendJson(res, 200, { status: 'ok', timestamp: Date.now() });
        return;
      }

      // Browse directories
      if (url.pathname === '/api/browse' && req.method === 'GET') {
        this._handleBrowse(url, res);
        return;
      }

      // Validate path
      if (url.pathname === '/api/validate-path' && req.method === 'GET') {
        this._handleValidatePath(url, res);
        return;
      }

      // Create/resume session
      if (url.pathname === '/api/session' && req.method === 'POST') {
        const body = await readJsonBody(req) as Record<string, unknown> | null;
        const requestedId =
          body && typeof body['sessionId'] === 'string' ? body['sessionId'] : null;
        const session =
          requestedId && this.sessions.has(requestedId)
            ? this.sessions.get(requestedId)!
            : this._createSession();
        session.lastSeenAt = Date.now();
        logInfo(`session ${session.id.slice(0, 8)}… (${requestedId ? 'resumed' : 'new'})`);
        sendJson(res, 200, { sessionId: session.id });
        return;
      }

      // Session routes
      if (url.pathname.startsWith('/api/session/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        const rawSessionId = parts[2];
        const action = parts[3];
        const sessionId = rawSessionId ? decodeURIComponent(rawSessionId) : null;
        if (!sessionId) {
          sendJson(res, 404, { error: 'Session not found' });
          return;
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        if (action === 'events' && req.method === 'GET') {
          this._handleSseEvents(session, req, res);
          return;
        }

        if (action === 'command' && req.method === 'POST') {
          await this._handleCommand(session, req, res);
          return;
        }

        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch {
      res.writeHead(500);
      res.end('Internal server error');
    }
  }

  private _handleBrowse(url: URL, res: http.ServerResponse): void {
    const dirPath = url.searchParams.get('path') || os.homedir();
    try {
      const resolvedPath = dirPath.startsWith('~')
        ? path.join(os.homedir(), dirPath.slice(1))
        : path.resolve(dirPath);

      const entries = readdirSync(resolvedPath, { withFileTypes: true });

      const directories = entries
        .filter((entry) => {
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

      const projectIndicators = [
        'package.json', '.git', 'Cargo.toml', 'go.mod',
        'pyproject.toml', 'Gemfile', '.xcodeproj', '.xcworkspace',
      ];
      const isProject = entries.some((e) =>
        projectIndicators.some(
          (indicator) => e.name === indicator || e.name.endsWith('.xcodeproj') || e.name.endsWith('.xcworkspace'),
        ),
      );

      sendJson(res, 200, {
        path: resolvedPath,
        parent: path.dirname(resolvedPath),
        directories,
        isProject,
        name: path.basename(resolvedPath),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to read directory';
      sendJson(res, 400, { error: msg });
    }
  }

  private _handleValidatePath(url: URL, res: http.ServerResponse): void {
    const dirPath = url.searchParams.get('path');
    if (!dirPath) {
      sendJson(res, 400, { error: 'Missing path parameter' });
      return;
    }
    try {
      const resolvedPath = dirPath.startsWith('~')
        ? path.join(os.homedir(), dirPath.slice(1))
        : path.resolve(dirPath);

      const stat = statSync(resolvedPath);
      if (!stat.isDirectory()) {
        sendJson(res, 400, { error: 'Path is not a directory', valid: false });
        return;
      }

      const entries = readdirSync(resolvedPath);
      const projectIndicators = [
        'package.json', '.git', 'Cargo.toml', 'go.mod',
        'pyproject.toml', 'Gemfile',
      ];
      const isProject = entries.some((e) =>
        projectIndicators.includes(e) || e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'),
      );

      sendJson(res, 200, {
        valid: true,
        path: resolvedPath,
        name: path.basename(resolvedPath),
        isProject,
      });
    } catch {
      sendJson(res, 400, { error: 'Directory does not exist', valid: false });
    }
  }

  private _handleSseEvents(session: Session, req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('\n');

    session.sseClients.add(res);
    session.lastSeenAt = Date.now();
    this._sendSessionState(session, res);

    req.on('close', () => {
      session.sseClients.delete(res);
    });
  }

  private async _handleCommand(session: Session, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJsonBody(req) as Record<string, unknown> | null;
    if (!body || typeof body['type'] !== 'string') {
      sendJson(res, 400, { error: 'Invalid payload' });
      return;
    }
    session.lastSeenAt = Date.now();
    const sessionId = session.id;
    const cmdType = body['type'] as string;

    // --- spawnInstance ---
    if (cmdType === 'spawnInstance') {
      const projectPath = typeof body['projectPath'] === 'string' ? body['projectPath'] : '';
      if (!projectPath) {
        logCommand(sessionId, body, { status: 400, error: 'Missing projectPath' });
        sendJson(res, 400, { error: 'Missing projectPath' });
        return;
      }
      const providerStr = typeof body['provider'] === 'string' ? body['provider'] : 'gemini';
      const yolo = body['yolo'] === true;
      const instanceId = crypto.randomUUID();
      const resolved = resolveProjectPath(projectPath, this.config.rootDir);
      logInfo(`spawn ${providerStr} instance ${instanceId.slice(0, 8)}… at ${resolved}${yolo ? ' (yolo)' : ''}`);

      if (providerStr === 'claude') {
        void this._spawnClaudeInstance(instanceId, projectPath, sessionId, resolved, yolo);
      } else {
        void this._spawnGeminiInstance(instanceId, projectPath, sessionId, resolved, yolo);
      }
      const resp = { instanceId, resolvedPath: resolved };
      logCommand(sessionId, body, { status: 200, ...resp });
      sendJson(res, 200, resp);
      return;
    }

    // --- terminateInstance ---
    if (cmdType === 'terminateInstance') {
      const instanceId = typeof body['instanceId'] === 'string' ? body['instanceId'] : '';
      if (!instanceId) {
        logCommand(sessionId, body, { status: 400, error: 'Missing instanceId' });
        sendJson(res, 400, { error: 'Missing instanceId' });
        return;
      }
      const inst = this.instances.get(instanceId);
      if (!inst || inst.sessionId !== sessionId) {
        logCommand(sessionId, body, { status: 403, error: 'Instance not found in session' });
        sendJson(res, 403, { error: 'Instance not found in session' });
        return;
      }
      logInfo(`terminate ${inst.providerName} instance ${instanceId.slice(0, 8)}…`);
      this._terminateInstance(instanceId);
      logCommand(sessionId, body, { status: 200, ok: true });
      sendJson(res, 200, { ok: true });
      return;
    }

    // --- setActiveInstance ---
    if (cmdType === 'setActiveInstance') {
      const instanceId = typeof body['instanceId'] === 'string' ? body['instanceId'] : '';
      if (instanceId) {
        const inst = this.instances.get(instanceId);
        if (!inst || inst.sessionId !== sessionId) {
          logCommand(sessionId, body, { status: 403, error: 'Instance not found in session' });
          sendJson(res, 403, { error: 'Instance not found in session' });
          return;
        }
      }
      session.activeInstanceId = instanceId || null;
      logCommand(sessionId, body, { status: 200, ok: true });
      sendJson(res, 200, { ok: true });
      return;
    }

    // --- interrupt ---
    if (cmdType === 'interrupt') {
      const instanceId = typeof body['instanceId'] === 'string' ? body['instanceId'] : '';
      if (!instanceId) {
        sendJson(res, 400, { error: 'Missing instanceId' });
        return;
      }
      const inst = this.instances.get(instanceId);
      if (!inst || inst.sessionId !== sessionId) {
        sendJson(res, 403, { error: 'Instance not found in session' });
        return;
      }
      log('interrupt instance', { instanceId, provider: inst.providerName });
      try {
        await inst.provider.interrupt();
        logCommand(sessionId, body, { status: 200, ok: true, provider: inst.providerName });
        sendJson(res, 200, { ok: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log('interrupt error', msg);
        // For Gemini: if process not running, return 409
        if (inst.providerName === 'gemini' && msg === 'CLI process not running') {
          sendJson(res, 409, { error: 'CLI process not running' });
        } else if (inst.providerName === 'gemini' && msg === 'CLI not connected') {
          this._sendToSession(sessionId, {
            type: 'bridge:cli-status',
            connected: false,
            instanceId,
            status: 'disconnected' as const,
          });
          this._sendInstanceList(sessionId);
          sendJson(res, 409, { error: 'CLI not connected' });
        } else {
          logCommand(sessionId, body, { status: 500, error: 'Failed to interrupt', provider: inst.providerName });
          sendJson(res, 500, { error: 'Failed to interrupt' });
        }
      }
      return;
    }

    // --- submit / confirm / setModel ---
    if (cmdType === 'submit' || cmdType === 'confirm' || cmdType === 'setModel') {
      const instanceId = typeof body['instanceId'] === 'string' ? body['instanceId'] : '';
      if (!instanceId) {
        sendJson(res, 400, { error: 'Missing instanceId' });
        return;
      }
      const inst = this.instances.get(instanceId);
      if (!inst || inst.sessionId !== sessionId) {
        sendJson(res, 403, { error: 'Instance not found in session' });
        return;
      }

      try {
        if (cmdType === 'submit') {
          const text = typeof body['text'] === 'string' ? body['text'] : '';
          log('submit', { instanceId, textLen: text.length, provider: inst.providerName });
          await inst.provider.submitMessage(text);
        } else if (cmdType === 'setModel') {
          const model = typeof body['model'] === 'string' ? body['model'] : '';
          log('setModel', { instanceId, model, provider: inst.providerName });
          await inst.provider.setModel(model);
        } else if (cmdType === 'confirm') {
          const callId = typeof body['callId'] === 'string' ? body['callId'] : '';
          const outcome = typeof body['outcome'] === 'string' ? body['outcome'] : '';
          const correlationId = typeof body['correlationId'] === 'string' ? body['correlationId'] : undefined;
          log('confirm', { instanceId, callId, provider: inst.providerName });
          await inst.provider.confirm(callId, outcome, correlationId);
        }
        logCommand(sessionId, body, { status: 200, ok: true, provider: inst.providerName });
        sendJson(res, 200, { ok: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Gemini: CLI not connected → 409
        if (inst.providerName === 'gemini' && msg === 'CLI not connected') {
          this._sendToSession(sessionId, {
            type: 'bridge:cli-status',
            connected: false,
            instanceId,
            status: 'disconnected' as const,
          });
          this._sendInstanceList(sessionId);
          logCommand(sessionId, body, { status: 409, error: 'CLI not connected', provider: 'gemini' });
          sendJson(res, 409, { error: 'CLI not connected' });
        } else {
          log('command error:', msg);
          logCommand(sessionId, body, { status: 500, error: msg, provider: inst.providerName });
          sendJson(res, 500, { error: msg });
        }
      }
      return;
    }

    sendJson(res, 400, { error: 'Unsupported command' });
  }
}
