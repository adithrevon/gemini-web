import http from 'node:http';
import crypto from 'node:crypto';
import type {
  SseEvent,
  PersistedData,
  PersistedSession,
  PersistedInstance,
} from './types.js';
import { sendSse } from './utils.js';
import { SessionPersistence } from './persistence.js';
import { createLogger } from './logger.js';

const log = createLogger('session-manager');

interface BufferedEvent {
  seq: number;
  event: SseEvent;
  timestamp: number;
}

export interface Session {
  id: string;
  instances: Set<string>; // Just instance IDs
  sseClients: Set<http.ServerResponse>;
  eventBuffer: BufferedEvent[];
  nextSeq: number;
  maxBufferSize: number;  // Keep last N events
  maxBufferAge: number;   // Keep events younger than N ms
}

/**
 * SessionManager handles session lifecycle and SSE client management.
 *
 * Responsibilities:
 * - Create and manage sessions
 * - Track SSE clients per session
 * - Broadcast events to session clients
 * - Coordinate with persistence layer
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private persistence: SessionPersistence;

  constructor(persistence: SessionPersistence) {
    this.persistence = persistence;
  }

  // --- Session CRUD ---

  createSession(): Session {
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      instances: new Set(),
      sseClients: new Set(),
      eventBuffer: [],
      nextSeq: 1,
      maxBufferSize: 1000,      // Keep last 1000 events
      maxBufferAge: 5 * 60 * 1000,  // Keep last 5 minutes
    };
    this.sessions.set(id, session);
    log.debug('Created session', { sessionId: id });
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  deleteSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    // Close all SSE clients
    for (const res of session.sseClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }

    this.sessions.delete(id);
    log.debug('Deleted session', { sessionId: id });
  }

  getAllSessions(): Map<string, Session> {
    return this.sessions;
  }

  // --- SSE Client Management ---

  addSseClient(sessionId: string, res: http.ServerResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.warn('Cannot add SSE client: session not found', { sessionId });
      return;
    }
    session.sseClients.add(res);
    log.debug('Added SSE client', { sessionId, clientCount: session.sseClients.size });
  }

  removeSseClient(sessionId: string, res: http.ServerResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.sseClients.delete(res);
    log.debug('Removed SSE client', { sessionId, clientCount: session.sseClients.size });
  }

  // --- Event Buffering & Replay ---

  /**
   * Replay buffered events since a given sequence number.
   * Returns true if replay was successful, false if buffer doesn't have requested events.
   */
  replayEvents(sessionId: string, since: number, res: http.ServerResponse): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.warn('Cannot replay: session not found', { sessionId });
      return false;
    }

    // Find events with seq > since
    const eventsToReplay = session.eventBuffer.filter((e) => e.seq > since);

    if (eventsToReplay.length === 0 && since > 0 && session.eventBuffer.length > 0) {
      // Buffer doesn't have events since requested seq (buffer was lost/trimmed)
      log.warn('Buffer unavailable for requested seq', { sessionId, since, oldestSeq: session.eventBuffer[0]?.seq });
      return false;
    }

    log.info('Replaying events', { sessionId, since, eventCount: eventsToReplay.length });

    // Send buffered events
    for (const buffered of eventsToReplay) {
      try {
        sendSse(res, buffered.event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Failed to replay event', { sessionId, seq: buffered.seq, error: msg });
        return false;
      }
    }

    return true;
  }

  /**
   * Send server restart notification (buffer lost).
   */
  sendServerRestarted(sessionId: string, res: http.ServerResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const seq = session.nextSeq++;
    const event = {
      type: 'server:restarted' as const,
      message: 'Server restarted, event buffer unavailable',
      seq,
    };

    try {
      sendSse(res, event);
      log.info('Sent server restart notification', { sessionId, seq });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('Failed to send server restart event', { sessionId, error: msg });
    }
  }

  // --- Broadcasting ---

  sendToSession(sessionId: string, payload: SseEvent | Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.warn('Cannot send to session: session not found', { sessionId });
      return;
    }

    const now = Date.now();
    const seq = session.nextSeq++;

    // Add sequence number to event (if it's a Claude event)
    let eventWithSeq: SseEvent | Record<string, unknown> = payload;
    if ('type' in payload && typeof payload.type === 'string' && payload.type.startsWith('claude:')) {
      eventWithSeq = { ...payload, seq } as SseEvent;
    }

    // Buffer the event
    const buffered: BufferedEvent = {
      seq,
      event: eventWithSeq as SseEvent,
      timestamp: now,
    };
    session.eventBuffer.push(buffered);

    // Trim buffer (by age and size)
    session.eventBuffer = session.eventBuffer
      .filter((e) => now - e.timestamp < session.maxBufferAge)
      .slice(-session.maxBufferSize);

    // Send to connected clients
    for (const res of session.sseClients) {
      try {
        sendSse(res, eventWithSeq);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Failed to send SSE, removing client', { sessionId, error: msg });
        session.sseClients.delete(res);
      }
    }
  }

  sendSessionState(
    sessionId: string,
    instanceMetadata?: Map<string, { projectPath: string; yolo: boolean }>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Build instances array: enriched objects if metadata provided, else just IDs
    let instances: Array<{ id: string; projectPath: string; yolo: boolean }>;
    if (instanceMetadata) {
      instances = Array.from(session.instances).map((id) => {
        const meta = instanceMetadata.get(id);
        return {
          id,
          projectPath: meta?.projectPath ?? '',
          yolo: meta?.yolo ?? false,
        };
      });
    } else {
      instances = Array.from(session.instances).map((id) => ({
        id,
        projectPath: '',
        yolo: false,
      }));
    }

    const event = {
      type: 'session_state' as const,
      sessionId: session.id,
      instances,
    };

    for (const res of session.sseClients) {
      try {
        sendSse(res, event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Failed to send session state, removing client', { sessionId, error: msg });
        session.sseClients.delete(res);
      }
    }
  }

  // --- Persistence ---

  /**
   * Restore a specific session from persistence (on-demand).
   * Returns the restored session or null if not found.
   */
  async restoreSession(sessionId: string): Promise<Session | null> {
    try {
      const data = await this.persistence.load();
      const sessionData = data.sessions.find((s) => s.id === sessionId);

      if (!sessionData) {
        log.debug('Session not found in persistence', { sessionId });
        return null;
      }

      log.info('Restoring session from persistence', {
        sessionId,
        instanceCount: sessionData.instances.length,
      });

      // Create session object in memory
      const session: Session = {
        id: sessionData.id,
        instances: new Set(sessionData.instances.map((i) => i.id)),
        sseClients: new Set(),
        eventBuffer: [],           // Start with empty buffer (server restarted)
        nextSeq: 1,
        maxBufferSize: 1000,
        maxBufferAge: 5 * 60 * 1000,
      };
      this.sessions.set(session.id, session);

      log.info('Session restored', {
        sessionId,
        instanceCount: session.instances.size,
      });

      return session;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to restore session', { sessionId, error: msg });
      return null;
    }
  }

  /**
   * Build persistence data from current state.
   * To be called by InstanceManager with instance data.
   */
  buildPersistedData(instances: Map<string, PersistedInstance>): PersistedData {
    const data: PersistedData = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      sessions: [],
    };

    for (const [sessionId, session] of this.sessions) {
      const sessionData: PersistedSession = {
        id: sessionId,
        instances: [],
      };

      for (const instanceId of session.instances) {
        const instData = instances.get(instanceId);
        if (instData) {
          sessionData.instances.push(instData);
        }
      }

      data.sessions.push(sessionData);
    }

    return data;
  }

  /**
   * Schedule a debounced persistence write.
   */
  schedulePersistence(data: PersistedData): void {
    this.persistence.scheduleWrite(data);
  }

  /**
   * Write persistence data immediately (for shutdown).
   */
  async persistNow(data: PersistedData): Promise<void> {
    await this.persistence.writeNow(data);
  }

  /**
   * Cleanup resources.
   */
  cleanup(): void {
    this.persistence.cleanup();

    // Close all SSE connections
    for (const session of this.sessions.values()) {
      for (const res of session.sseClients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }

    this.sessions.clear();
  }
}
