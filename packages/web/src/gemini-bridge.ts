import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';

import type { Provider } from './provider.js';
import type { BridgeUpdatePayload, ServerConfig } from './types.js';
import { isSocketOpen, safeSend } from './utils.js';
import { createTaggedLogger } from './logger.js';

const log = createTaggedLogger('gemini');

// node-pty types (dynamically imported)
interface PtyProcess {
  write(data: string): void;
  kill(): void;
  destroy?(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
}

type ProcessHandle = PtyProcess | ChildProcess;

export type GeminiBridgeCallbacks = {
  onStatusChange: (status: 'connecting' | 'connected' | 'disconnected' | 'error', error?: string) => void;
  onBridgeUpdate: (payload: BridgeUpdatePayload) => void;
  onExit: () => void;
  onError: (message: string) => void;
};

export class GeminiBridge implements Provider {
  readonly name = 'gemini' as const;

  readonly instanceId: string;
  readonly projectPath: string;

  private _config: ServerConfig;
  private _callbacks: GeminiBridgeCallbacks;
  private _process: ProcessHandle | null = null;
  private _cliSocket: WebSocket | null = null;
  private _lastSnapshot: BridgeUpdatePayload | null = null;
  private _spawnTimeout: ReturnType<typeof setTimeout> | null = null;
  private _status: 'connecting' | 'connected' | 'disconnected' | 'error' = 'connecting';
  private _outputBuffer: string[] = [];
  private readonly _bufferLimit = 20000;
  private _yolo: boolean;

  constructor(opts: {
    instanceId: string;
    projectPath: string;
    config: ServerConfig;
    callbacks: GeminiBridgeCallbacks;
    yolo?: boolean;
  }) {
    this.instanceId = opts.instanceId;
    this.projectPath = opts.projectPath;
    this._config = opts.config;
    this._callbacks = opts.callbacks;
    this._yolo = opts.yolo ?? false;
  }

  async start(): Promise<void> {
    const { rootDir } = this._config;
    const defaultBundle = path.join(rootDir, 'bundle', 'gemini.js');
    const distEntry = path.join(rootDir, 'packages', 'cli', 'dist', 'index.js');
    const cliEntry =
      process.env['GEMINI_WEB_CLI_PATH'] ??
      (existsSync(distEntry) ? distEntry : defaultBundle);
    const cliArgs = process.env['GEMINI_WEB_CLI_ARGS']
      ? process.env['GEMINI_WEB_CLI_ARGS'].split(' ')
      : [];
    if (this._yolo) cliArgs.push('--yolo');

    const wsUrl = `ws://127.0.0.1:${this._config.port}${this._config.wsPath}`;
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      GEMINI_WEB_WS_URL: wsUrl,
      GEMINI_INSTANCE_ID: this.instanceId,
    };

    log.debug('spawn cli', {
      instanceId: this.instanceId,
      resolvedPath: this.projectPath,
      cliEntry,
    });

    this._scheduleSpawnTimeout();

    try {
      const ptyModule = await import('node-pty');
      const pty = ptyModule.default ?? ptyModule;
      const ptyProcess = pty.spawn(process.execPath, [cliEntry, ...cliArgs], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.projectPath,
        env,
      }) as PtyProcess;

      this._process = ptyProcess;

      ptyProcess.onData((data: string) => {
        this._recordOutput(data);
        if (this._config.cliLog) {
          process.stdout.write(data);
        }
      });

      ptyProcess.onExit((event: { exitCode: number; signal?: number }) => {
        console.log(
          `[web] CLI instance ${this.instanceId} exited with code ${event.exitCode} (signal: ${event.signal ?? 'none'}).`,
        );
        this._dumpOutputOnDebug();
        if (this._status !== 'connected') {
          this._callbacks.onError('CLI failed to start');
          return;
        }
        this._callbacks.onExit();
      });
    } catch {
      console.log('[web] node-pty not available; falling back to spawn().');
      const child = spawn(process.execPath, [cliEntry, ...cliArgs], {
        cwd: this.projectPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._process = child;

      if (this._config.cliLog) {
        child.stdout?.on('data', (data: Buffer) => process.stdout.write(data));
        child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
      }
      child.stdout?.on('data', (data: Buffer) => this._recordOutput(data.toString('utf8')));
      child.stderr?.on('data', (data: Buffer) => this._recordOutput(data.toString('utf8')));

      child.on('exit', (code: number | null) => {
        console.log(
          `[web] CLI instance ${this.instanceId} exited with code ${code ?? 'unknown'}.`,
        );
        this._dumpOutputOnDebug();
        if (this._status !== 'connected') {
          this._callbacks.onError('CLI failed to start');
          return;
        }
        this._callbacks.onExit();
      });
      child.on('error', (err: Error) => {
        console.log(`[web] CLI ${this.instanceId} spawn error`, err);
        this._callbacks.onError('CLI failed to start');
      });
    }
  }

  /** Called by ws-handler when the CLI WebSocket connects and identifies itself. */
  bindSocket(ws: WebSocket): void {
    this._cliSocket = ws;
    if (this._spawnTimeout) {
      clearTimeout(this._spawnTimeout);
      this._spawnTimeout = null;
    }
    this._status = 'connected';
    this._callbacks.onStatusChange('connected');
  }

  /** Called by ws-handler when a bridge:update message arrives from the CLI. */
  handleBridgeUpdate(payload: BridgeUpdatePayload): void {
    if (this._spawnTimeout) {
      clearTimeout(this._spawnTimeout);
      this._spawnTimeout = null;
    }
    this._status = 'connected';
    this._lastSnapshot = payload;
    if (payload.projectPath) {
      // projectPath may be updated by the CLI
      (this as { projectPath: string }).projectPath = payload.projectPath;
    }
    this._callbacks.onBridgeUpdate(payload);
  }

  /** Called by ws-handler when the CLI WebSocket disconnects. */
  handleSocketClose(): void {
    this._cliSocket = null;
    if (this._status !== 'error') {
      this._status = 'disconnected';
    }
    this._callbacks.onStatusChange(this._status as 'disconnected' | 'error');
  }

  async submitMessage(text: string): Promise<void> {
    if (!isSocketOpen(this._cliSocket)) {
      throw new Error('CLI not connected');
    }
    safeSend(this._cliSocket, JSON.stringify({ type: 'submit', text }));
  }

  async interrupt(): Promise<void> {
    if (!this._process) {
      throw new Error('CLI process not running');
    }
    // Send Ctrl+C
    if ('write' in this._process && typeof this._process.write === 'function') {
      // node-pty
      (this._process as PtyProcess).write('\x03');
    } else {
      const child = this._process as ChildProcess;
      if (child.stdin) {
        child.stdin.write('\x03');
      } else if (typeof child.kill === 'function') {
        child.kill('SIGINT');
      }
    }
  }

  async setModel(model: string): Promise<void> {
    if (!isSocketOpen(this._cliSocket)) {
      throw new Error('CLI not connected');
    }
    safeSend(this._cliSocket, JSON.stringify({ type: 'setModel', model }));
  }

  async confirm(callId: string, outcome: string, correlationId?: string): Promise<void> {
    if (!isSocketOpen(this._cliSocket)) {
      throw new Error('CLI not connected');
    }
    safeSend(this._cliSocket, JSON.stringify({ type: 'confirm', callId, outcome, correlationId }));
  }

  destroy(): void {
    if (this._spawnTimeout) {
      clearTimeout(this._spawnTimeout);
      this._spawnTimeout = null;
    }
    if (this._cliSocket) {
      this._cliSocket.close();
      this._cliSocket = null;
    }
    if (this._process) {
      if ('kill' in this._process && typeof this._process.kill === 'function') {
        try { this._process.kill(); } catch { /* ignore */ }
      }
      if ('destroy' in this._process && typeof this._process.destroy === 'function') {
        try { (this._process as PtyProcess).destroy!(); } catch { /* ignore */ }
      }
      this._process = null;
    }
  }

  getSnapshot(): BridgeUpdatePayload {
    return this._lastSnapshot ?? {
      instanceId: this.instanceId,
      projectPath: this.projectPath,
      history: [],
      pending: [],
      streamingState: 'idle',
      isTrustedFolder: true,
      currentModel: '',
      availableModels: [],
      hasPreviewAccess: false,
    };
  }

  /** Check if the CLI socket is connected. */
  get isCliConnected(): boolean {
    return isSocketOpen(this._cliSocket);
  }

  get cliSocket(): WebSocket | null {
    return this._cliSocket;
  }

  get status(): string {
    return this._status;
  }

  private _scheduleSpawnTimeout(): void {
    this._spawnTimeout = setTimeout(() => {
      if (this._status === 'connected') return;
      this._callbacks.onError('CLI failed to connect');
    }, this._config.spawnTimeoutMs);
  }

  private _recordOutput(chunk: string): void {
    if (!this._config.debug) return;
    this._outputBuffer.push(chunk);
    const joined = this._outputBuffer.join('');
    if (joined.length > this._bufferLimit) {
      this._outputBuffer.length = 0;
      this._outputBuffer.push(joined.slice(-this._bufferLimit));
    }
  }

  private _dumpOutputOnDebug(): void {
    if (this._config.debug && this._outputBuffer.length > 0) {
      console.log(`[web] CLI ${this.instanceId} output (tail)`);
      console.log(this._outputBuffer.join('').slice(-this._bufferLimit));
    }
  }
}
