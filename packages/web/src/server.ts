import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

import type { ServerConfig } from './types.js';
import { SessionManager } from './session-manager.js';
import { InstanceManager } from './instance-manager.js';
import { BrowseManager } from './browse-manager.js';
import {
  readJsonBody,
  sendJson,
  resolveProjectPath,
} from './utils.js';
import { logger, logCommand, logFilePath, createLogger } from './logger.js';
import { SessionPersistence } from './persistence.js';
import { UsageLimitsTracker } from './usage-limits.js';

const serverLog = createLogger('server');

/**
 * ClaudeWebServer - HTTP server for Claude web bridge.
 *
 * Responsibilities:
 * - HTTP server lifecycle (listen, close)
 * - Route incoming requests to appropriate handlers
 * - Coordinate SessionManager and InstanceManager
 * - Persistence on startup/shutdown
 */
export class GeminiWebServer {
  private config: ServerConfig;
  private httpServer: http.Server;
  private sessionManager: SessionManager;
  private instanceManager: InstanceManager;
  private browseManager: BrowseManager;
  private persistence: SessionPersistence;
  private usageLimitsTracker: UsageLimitsTracker | null = null;

  constructor(config: ServerConfig) {
    this.config = config;

    // Initialize persistence
    const persistDir = path.join(os.homedir(), '.claude-web');
    if (!existsSync(persistDir)) {
      mkdirSync(persistDir, { recursive: true });
    }
    const persistFile = path.join(persistDir, 'sessions.json');
    this.persistence = new SessionPersistence(persistFile);

    // Initialize managers
    this.sessionManager = new SessionManager(this.persistence);
    this.instanceManager = new InstanceManager(this.sessionManager);
    this.browseManager = new BrowseManager();

    // Initialize usage limits tracker
    this._initializeUsageLimitsTracker();

    // Create HTTP server
    this.httpServer = http.createServer((req, res) => {
      void this._handleRequest(req, res);
    });
  }

  async listen(port?: number): Promise<number> {
    const p = port ?? this.config.port;

    return new Promise((resolve, reject) => {
      this.httpServer.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[web] ERROR: Port ${p} is already in use.`);
          console.error(
            `[web] Kill the existing process: lsof -ti :${p} | xargs kill`,
          );
        } else {
          console.error(`[web] ERROR: Failed to start server: ${err.message}`);
        }
        reject(err);
      });
      this.httpServer.listen(p, () => {
        const addr = this.httpServer.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : p;
        console.log(
          `[web] API server listening on http://localhost:${actualPort}`,
        );
        console.log(
          `[web] Connect iOS app to this server to spawn CLI instances.`,
        );
        console.log(`[web] Logs → ${logFilePath}`);
        if (!this.config.debug) {
          console.log(
            `[web] Set CLAUDE_WEB_DEBUG=1 for verbose console output.`,
          );
        }
        resolve(actualPort);
      });
    });
  }

  async close(): Promise<void> {
    serverLog.debug('Server shutting down');

    // Persist final state immediately (bypass debounce)
    try {
      const persistedInstances = this.instanceManager.buildPersistedInstances();
      const data = this.sessionManager.buildPersistedData(persistedInstances);
      await this.sessionManager.persistNow(data);
      serverLog.debug('Persisted final state on shutdown');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      serverLog.debug('Failed to persist on shutdown', { error: msg });
    }

    // Clean up instances and sessions
    this.instanceManager.terminateAll();
    this.sessionManager.cleanup();

    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  /** Expose for testing */
  get server(): http.Server {
    return this.httpServer;
  }

  // --- Private Methods ---

  private _initializeUsageLimitsTracker(): void {
    try {
      // Try ANTHROPIC_API_KEY environment variable first
      let credentials = process.env['ANTHROPIC_API_KEY'];

      if (credentials) {
        serverLog.info('Using credentials from ANTHROPIC_API_KEY');
      }

      // If not set, try to get from macOS Keychain (same as Claude SDK)
      if (!credentials && process.platform === 'darwin') {
        serverLog.info('Attempting to retrieve credentials from macOS Keychain');
        try {
          const command = 'security find-generic-password -s "Claude Code-credentials" -w';

          // Capture both stdout and stderr
          const result = execSync(command, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'], // capture stderr instead of ignoring
          });

          credentials = result.trim();
        } catch (err: any) {
          serverLog.warn('Keychain access failed');
        }
      } else if (!credentials && process.platform !== 'darwin') {
        serverLog.info('Skipping keychain access (not on macOS)');
      }

      if (credentials) {
        this.usageLimitsTracker = new UsageLimitsTracker(credentials);
        serverLog.info('Usage limits tracker initialized');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      serverLog.warn('Failed to initialize usage limits tracker', { error: msg });
    }
  }

  private _buildInstanceMetadata(
    sessionId: string,
  ): Map<string, { projectPath: string; yolo: boolean }> {
    const metadata = new Map<string, { projectPath: string; yolo: boolean }>();
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      for (const instanceId of session.instances) {
        const inst = this.instanceManager.getInstance(instanceId);
        if (inst) {
          metadata.set(instanceId, {
            projectPath: inst.projectPath,
            yolo: inst.bridge.yolo,
          });
        }
      }
    }
    return metadata;
  }

  private _persistState(): void {
    const persistedInstances = this.instanceManager.buildPersistedInstances();
    const data = this.sessionManager.buildPersistedData(persistedInstances);
    this.sessionManager.schedulePersistence(data);
  }

  // --- HTTP Request Handling ---

  private async _handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      // Set CORS headers for all requests
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      // Handle preflight OPTIONS requests
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(
        req.url ?? '/',
        `http://${req.headers.host ?? 'localhost'}`,
      );

      // Route to appropriate handler
      if (url.pathname === '/health' && req.method === 'GET') {
        this._handleHealth(res);
        return;
      }

      if (url.pathname === '/api/usage-limits' && req.method === 'GET') {
        await this._handleUsageLimits(res);
        return;
      }

      if (url.pathname === '/api/browse' && req.method === 'GET') {
        this._handleBrowse(url, res);
        return;
      }

      if (url.pathname === '/api/validate-path' && req.method === 'GET') {
        this._handleValidatePath(url, res);
        return;
      }

      if (url.pathname === '/api/session' && req.method === 'POST') {
        await this._handleCreateSession(req, res);
        return;
      }

      if (url.pathname.startsWith('/api/session/')) {
        await this._handleSessionRoute(url, req, res);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Internal server error';
      serverLog.error('Request handler error', { error: msg });
      res.writeHead(500);
      res.end('Internal server error');
    }
  }

  private _handleHealth(res: http.ServerResponse): void {
    serverLog.debug('HTTP GET /health');
    sendJson(res, 200, { status: 'ok', timestamp: Date.now() });
  }

  private async _handleUsageLimits(res: http.ServerResponse): Promise<void> {
    serverLog.debug('HTTP GET /api/usage-limits');
    if (!this.usageLimitsTracker) {
      sendJson(res, 503, {
        error: 'Usage tracking not available (ANTHROPIC_API_KEY not set)',
      });
      return;
    }
    const limits = await this.usageLimitsTracker.getUsageLimits();
    if (!limits) {
      sendJson(res, 500, { error: 'Failed to fetch usage limits' });
      return;
    }
    sendJson(res, 200, limits);
  }

  private _handleBrowse(url: URL, res: http.ServerResponse): void {
    const dirPath = url.searchParams.get('path') || undefined;
    try {
      const listing = this.browseManager.browse(dirPath);
      sendJson(res, 200, listing);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to read directory';
      sendJson(res, 400, { error: msg });
    }
  }

  private _handleValidatePath(url: URL, res: http.ServerResponse): void {
    const dirPath = url.searchParams.get('path');
    if (!dirPath) {
      sendJson(res, 400, { error: 'Missing path parameter', valid: false });
      return;
    }

    const validation = this.browseManager.validatePath(dirPath);
    const statusCode = validation.valid ? 200 : 400;
    sendJson(res, statusCode, validation);
  }

  private async _handleCreateSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const requestedId =
      body && typeof body['sessionId'] === 'string' ? body['sessionId'] : null;

    let session = requestedId ? this.sessionManager.getSession(requestedId) : null;

    // Try restoring from persistence if not in memory
    if (!session && requestedId) {
      const restored = await this.sessionManager.restoreSession(requestedId);
      if (restored) {
        const data = await this.persistence.load();
        const sessionData = data.sessions.find((s) => s.id === requestedId);
        if (sessionData) {
          for (const instData of sessionData.instances) {
            await this.instanceManager.restoreInstance(requestedId, instData);
          }
        }
        session = restored;
      }
    }

    if (!session) {
      session = this.sessionManager.createSession();
      this._persistState();
    }

    logger.info(
      `session ${session.id.slice(0, 8)}… (${requestedId ? 'resumed' : 'new'})`,
    );
    sendJson(res, 200, { sessionId: session.id });
  }

  private async _handleSessionRoute(
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean);
    const rawSessionId = parts[2];
    const action = parts[3];
    const sessionId = rawSessionId ? decodeURIComponent(rawSessionId) : null;

    if (!sessionId) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    let session = this.sessionManager.getSession(sessionId);

    // On-demand session restoration
    if (!session) {
      serverLog.debug('Session not in memory, attempting restore from persistence', {
        sessionId,
      });

      const restored = await this.sessionManager.restoreSession(sessionId);
      if (!restored) {
        sendJson(res, 404, { error: 'Session not found' });
        return;
      }

      // Restore instances for this session
      const data = await this.persistence.load();
      const sessionData = data.sessions.find((s) => s.id === sessionId);
      if (sessionData) {
        for (const instData of sessionData.instances) {
          await this.instanceManager.restoreInstance(sessionId, instData);
        }
      }

      session = restored;
    }

    if (action === 'events' && req.method === 'GET') {
      this._handleSseEvents(session.id, url, req, res);
      return;
    }

    if (action === 'command' && req.method === 'POST') {
      await this._handleCommand(session.id, req, res);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  private _handleSseEvents(
    sessionId: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('\n');

    // Parse 'since' parameter for event replay
    const sinceParam = url.searchParams.get('since');
    const since = sinceParam ? parseInt(sinceParam, 10) : 0;

    // Try to replay buffered events if 'since' is provided
    if (since > 0) {
      const replaySuccess = this.sessionManager.replayEvents(sessionId, since, res);

      if (!replaySuccess) {
        // Buffer unavailable (server restarted or events too old)
        this.sessionManager.sendServerRestarted(sessionId, res);
      }
    }

    // Add client for live streaming
    this.sessionManager.addSseClient(sessionId, res);

    // Send current session state with instance metadata
    this.sessionManager.sendSessionState(
      sessionId,
      this._buildInstanceMetadata(sessionId),
    );

    req.on('close', () => {
      this.sessionManager.removeSseClient(sessionId, res);
    });
  }

  private async _handleCommand(
    sessionId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    if (!body || typeof body['type'] !== 'string') {
      sendJson(res, 400, { error: 'Invalid payload' });
      return;
    }

    const cmdType = body['type'] as string;

    try {
      if (cmdType === 'spawnInstance') {
        await this._handleSpawnInstance(sessionId, body, res);
        return;
      }

      if (cmdType === 'terminateInstance') {
        await this._handleTerminateInstance(sessionId, body, res);
        return;
      }

      if (cmdType === 'interrupt') {
        await this._handleInterrupt(sessionId, body, res);
        return;
      }

      if (
        cmdType === 'submit' ||
        cmdType === 'confirm' ||
        cmdType === 'setModel' ||
        cmdType === 'togglePlanMode' ||
        cmdType === 'toggleYolo'
      ) {
        await this._handleInstanceCommand(sessionId, cmdType, body, res);
        return;
      }

      sendJson(res, 400, { error: 'Unsupported command' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      serverLog.error('Command error', { cmdType, error: msg });
      logCommand(sessionId, body, { status: 500, error: msg });
      sendJson(res, 500, { error: msg });
    }
  }

  private async _handleSpawnInstance(
    sessionId: string,
    body: Record<string, unknown>,
    res: http.ServerResponse,
  ): Promise<void> {
    const projectPath =
      typeof body['projectPath'] === 'string' ? body['projectPath'] : '';
    if (!projectPath) {
      logCommand(sessionId, body, { status: 400, error: 'Missing projectPath' });
      sendJson(res, 400, { error: 'Missing projectPath' });
      return;
    }

    const yolo = body['yolo'] === true;
    const resolved = resolveProjectPath(projectPath, this.config.rootDir);

    try {
      const instanceId = await this.instanceManager.spawnInstance(
        sessionId,
        resolved,
        yolo,
      );
      this._persistState();

      const resp = { instanceId, resolvedPath: resolved };
      logCommand(sessionId, body, { status: 200, ...resp });
      sendJson(res, 200, resp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logCommand(sessionId, body, { status: 500, error: msg });
      sendJson(res, 500, { error: msg });
    }
  }

  private async _handleTerminateInstance(
    sessionId: string,
    body: Record<string, unknown>,
    res: http.ServerResponse,
  ): Promise<void> {
    const instanceId =
      typeof body['instanceId'] === 'string' ? body['instanceId'] : '';
    if (!instanceId) {
      logCommand(sessionId, body, { status: 400, error: 'Missing instanceId' });
      sendJson(res, 400, { error: 'Missing instanceId' });
      return;
    }

    const inst = this.instanceManager.getInstance(instanceId);
    if (!inst || inst.sessionId !== sessionId) {
      logCommand(sessionId, body, {
        status: 403,
        error: 'Instance not found in session',
      });
      sendJson(res, 403, { error: 'Instance not found in session' });
      return;
    }

    this.instanceManager.terminateInstance(instanceId);
    this._persistState();

    logCommand(sessionId, body, { status: 200, ok: true });
    sendJson(res, 200, { ok: true });
  }

  private async _handleInterrupt(
    sessionId: string,
    body: Record<string, unknown>,
    res: http.ServerResponse,
  ): Promise<void> {
    const instanceId =
      typeof body['instanceId'] === 'string' ? body['instanceId'] : '';
    if (!instanceId) {
      sendJson(res, 400, { error: 'Missing instanceId' });
      return;
    }

    const inst = this.instanceManager.getInstance(instanceId);
    if (!inst || inst.sessionId !== sessionId) {
      sendJson(res, 403, { error: 'Instance not found in session' });
      return;
    }

    try {
      await this.instanceManager.interrupt(instanceId);
      logCommand(sessionId, body, { status: 200, ok: true });
      sendJson(res, 200, { ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      serverLog.error('Interrupt error', { error: msg });
      logCommand(sessionId, body, {
        status: 500,
        error: 'Failed to interrupt',
      });
      sendJson(res, 500, { error: 'Failed to interrupt' });
    }
  }

  private async _handleInstanceCommand(
    sessionId: string,
    cmdType: string,
    body: Record<string, unknown>,
    res: http.ServerResponse,
  ): Promise<void> {
    const instanceId =
      typeof body['instanceId'] === 'string' ? body['instanceId'] : '';
    if (!instanceId) {
      sendJson(res, 400, { error: 'Missing instanceId' });
      return;
    }

    const inst = this.instanceManager.getInstance(instanceId);
    if (!inst || inst.sessionId !== sessionId) {
      sendJson(res, 403, { error: 'Instance not found in session' });
      return;
    }

    if (cmdType === 'submit') {
      const text = typeof body['text'] === 'string' ? body['text'] : '';
      await this.instanceManager.submitMessage(instanceId, text);
    } else if (cmdType === 'setModel') {
      const model = typeof body['model'] === 'string' ? body['model'] : '';
      await this.instanceManager.setModel(instanceId, model);
    } else if (cmdType === 'togglePlanMode') {
      await this.instanceManager.togglePlanMode(instanceId);
    } else if (cmdType === 'toggleYolo') {
      const yolo = typeof body['yolo'] === 'boolean' ? body['yolo'] : undefined;
      if (yolo === undefined) {
        throw new Error('Missing yolo parameter');
      }
      await this.instanceManager.toggleYolo(instanceId, yolo);
      this._persistState();
    } else if (cmdType === 'confirm') {
      const callId = typeof body['callId'] === 'string' ? body['callId'] : '';
      const outcome = typeof body['outcome'] === 'string' ? body['outcome'] : '';
      const correlationId =
        typeof body['correlationId'] === 'string'
          ? body['correlationId']
          : undefined;
      await this.instanceManager.confirm(instanceId, callId, outcome, correlationId);
    }

    logCommand(sessionId, body, { status: 200, ok: true });
    sendJson(res, 200, { ok: true });
  }
}
