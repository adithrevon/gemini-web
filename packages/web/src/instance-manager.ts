import crypto from 'node:crypto';
import type { PersistedInstance } from './types.js';
import { ClaudeBridge } from './claude-bridge/index.js';
import { SessionManager } from './session-manager.js';
import { createLogger } from './logger.js';
import { logger } from './logger.js';

const log = createLogger('instance-manager');

export interface Instance {
  id: string;
  sessionId: string;
  bridge: ClaudeBridge;
  projectPath: string;
}

/**
 * InstanceManager handles instance lifecycle and bridge coordination.
 *
 * Responsibilities:
 * - Spawn and restore Claude bridge instances
 * - Set up event handlers for bridge events
 * - Route commands to appropriate instances
 * - Coordinate with SessionManager for broadcasting
 * - Build persistence data for instances
 */
export class InstanceManager {
  private instances = new Map<string, Instance>();
  private sessionManager: SessionManager;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  // --- Instance CRUD ---

  async spawnInstance(
    sessionId: string,
    projectPath: string,
    yolo = false,
  ): Promise<string> {
    const instanceId = crypto.randomUUID();

    log.debug('Spawning instance', {
      instanceId,
      sessionId,
      projectPath,
      yolo,
    });

    const bridge = new ClaudeBridge({
      instanceId,
      projectPath,
      yolo,
    });

    const inst: Instance = {
      id: instanceId,
      sessionId,
      bridge,
      projectPath,
    };
    this.instances.set(instanceId, inst);

    // Set up event handlers
    this._setupEventHandlers(bridge, instanceId, sessionId);

    // Add to session
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      session.instances.add(instanceId);
    }

    try {
      await bridge.start();
      logger.info(
        `spawn claude instance ${instanceId.slice(0, 8)}… at ${projectPath}${yolo ? ' (yolo)' : ''}`,
      );
      return instanceId;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Claude spawn failed', { instanceId, error: msg });
      this.sessionManager.sendToSession(sessionId, {
        type: 'bridge:error',
        instanceId,
        error: msg || 'Claude SDK not available',
      });
      throw err;
    }
  }

  async restoreInstance(sessionId: string, instData: PersistedInstance): Promise<void> {
    log.debug('Restoring instance', {
      instanceId: instData.id,
      claudeSessionId: instData.claudeSessionId,
    });

    const bridge = new ClaudeBridge({
      instanceId: instData.id,
      projectPath: instData.projectPath,
      yolo: instData.yolo,
    });

    // CRITICAL: Restore Claude SDK session ID
    if (instData.claudeSessionId) {
      (bridge as unknown as { _sessionId: string })._sessionId =
        instData.claudeSessionId;
      log.debug('Restored Claude SDK session ID', {
        instanceId: instData.id,
        sessionId: instData.claudeSessionId,
      });
    }

    const inst: Instance = {
      id: instData.id,
      sessionId,
      bridge,
      projectPath: instData.projectPath,
    };
    this.instances.set(instData.id, inst);

    // Set up event handlers
    this._setupEventHandlers(bridge, instData.id, sessionId);

    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      session.instances.add(instData.id);
    }

    try {
      await bridge.start();
      log.debug('Instance restored successfully', { instanceId: instData.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Instance restoration failed', {
        instanceId: instData.id,
        error: msg,
      });
      this.sessionManager.sendToSession(sessionId, {
        type: 'bridge:error',
        instanceId: instData.id,
        error: msg,
      });
    }
  }

  getInstance(id: string): Instance | undefined {
    return this.instances.get(id);
  }

  terminateInstance(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) {
      log.debug('Terminate failed: instance not found', { instanceId });
      return;
    }

    logger.info(`terminate claude instance ${instanceId.slice(0, 8)}…`);
    log.debug('Terminating instance', { instanceId });

    inst.bridge.destroy();

    const sessionId = inst.sessionId;
    this.instances.delete(instanceId);

    if (sessionId) {
      const session = this.sessionManager.getSession(sessionId);
      if (session) {
        session.instances.delete(instanceId);
      }
    }
  }

  terminateAll(): void {
    for (const instanceId of [...this.instances.keys()]) {
      this.terminateInstance(instanceId);
    }
  }

  // --- Commands ---

  async submitMessage(instanceId: string, text: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) {
      throw new Error('Instance not found');
    }
    log.debug('Submit message', {
      instanceId,
      textLen: text.length,
    });
    await inst.bridge.submitMessage(text);
  }

  async interrupt(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) {
      throw new Error('Instance not found');
    }
    log.debug('Interrupt instance', { instanceId });
    await inst.bridge.interrupt();
  }

  async setModel(instanceId: string, model: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) {
      throw new Error('Instance not found');
    }
    log.debug('Set model', { instanceId, model });
    await inst.bridge.setModel(model);
  }

  async confirm(instanceId: string, callId: string, outcome: string, correlationId?: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) {
      throw new Error('Instance not found');
    }
    log.debug('Confirm tool', { instanceId, callId });
    await inst.bridge.confirm(callId, outcome, correlationId);
  }

  async togglePlanMode(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) {
      throw new Error('Instance not found');
    }
    log.debug('Toggle plan mode', { instanceId });
    await inst.bridge.togglePlanMode();
  }

  async toggleYolo(instanceId: string, yolo: boolean): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) {
      throw new Error('Instance not found');
    }
    log.debug('Toggle yolo', { instanceId, yolo });
    await inst.bridge.setYolo(yolo);
  }

  // --- Persistence Support ---

  buildPersistedInstances(): Map<string, PersistedInstance> {
    const persistedInstances = new Map<string, PersistedInstance>();

    for (const [instanceId, inst] of this.instances) {
      const instData: PersistedInstance = {
        id: inst.id,
        sessionId: inst.sessionId,
        projectPath: inst.projectPath,
        yolo: inst.bridge.yolo,
        claudeSessionId:
          (inst.bridge as unknown as { _sessionId: string | null })._sessionId ?? undefined,
      };
      persistedInstances.set(instanceId, instData);
    }

    return persistedInstances;
  }

  // --- Private Methods ---

  private _setupEventHandlers(
    bridge: ClaudeBridge,
    instanceId: string,
    sessionId: string,
  ): void {
    // Text events
    bridge.on('text_delta', ({ text }: { text: string }) => {
      this.sessionManager.sendToSession(sessionId, {
        type: 'claude:text_delta',
        instanceId,
        text,
      });
    });

    bridge.on('text_complete', ({ text }: { text: string }) => {
      this.sessionManager.sendToSession(sessionId, {
        type: 'claude:text_complete',
        instanceId,
        text,
      });
    });

    // Tool events
    bridge.on('tool_added', ({ tool, confirmationDetails }: { tool: any; confirmationDetails?: any }) => {
      this.sessionManager.sendToSession(sessionId, {
        type: 'claude:tool_added',
        instanceId,
        tool,
        confirmationDetails,
      });
    });

    bridge.on('tool_status', ({ toolId, status }: { toolId: string; status: string }) => {
      this.sessionManager.sendToSession(sessionId, {
        type: 'claude:tool_status',
        instanceId,
        toolId,
        status,
      });
    });

    bridge.on('tool_result', ({ toolId, result }: { toolId: string; result: any }) => {
      this.sessionManager.sendToSession(sessionId, {
        type: 'claude:tool_result',
        instanceId,
        toolId,
        result,
      });
    });

    // Streaming state
    bridge.on('streaming_state', ({ state }: { state: any }) => {
      this.sessionManager.sendToSession(sessionId, {
        type: 'claude:streaming_state',
        instanceId,
        state,
      });
    });

    // Models available
    bridge.on('models_available', ({ models }: { models: any[] }) => {
      log.debug('models_available event', { instanceId, sessionId, modelCount: models.length });
      this.sessionManager.sendToSession(sessionId, {
        type: 'claude:models_available',
        instanceId,
        models,
      });
    });

    // Session complete
    bridge.on('session_complete', ({ sessionId: claudeSessionId }: { sessionId: string }) => {
      this.sessionManager.sendToSession(sessionId, {
        type: 'claude:session_complete',
        instanceId,
        sessionId: claudeSessionId,
      });
    });
  }
}
