import type { WebSocket } from 'ws';
import type { GeminiBridge } from './gemini-bridge.js';
import type { BridgeUpdatePayload } from './types.js';
import { safeParse } from './utils.js';
import { log } from './logger.js';

/**
 * Callback to look up a GeminiBridge by instanceId.
 * Returns null if the instance is not a Gemini provider or doesn't exist.
 */
export type GetGeminiBridge = (instanceId: string) => GeminiBridge | null;

/**
 * Callback when a new CLI instance connects via WS but no matching instance exists.
 * The server can choose to create an orphan entry.
 */
export type OnOrphanCliConnect = (
  instanceId: string,
  socket: WebSocket,
  payload: BridgeUpdatePayload,
) => void;

export interface WsHandlerCallbacks {
  getGeminiBridge: GetGeminiBridge;
  onOrphanCliConnect: OnOrphanCliConnect;
}

/**
 * Handle a new WebSocket connection from a Gemini CLI instance.
 */
export function handleWsConnection(
  socket: WebSocket,
  callbacks: WsHandlerCallbacks,
): void {
  let role: 'unknown' | 'cli' | 'web' = 'unknown';
  let boundInstanceId: string | null = null;

  log('ws connection');

  socket.on('message', (raw: Buffer | string) => {
    const message = safeParse(raw) as Record<string, unknown> | null;
    if (!message) return;

    if (message['type'] === 'bridge:hello') {
      role = message['role'] === 'cli' ? 'cli' : 'web';
      log('hello', role);
      if (role !== 'cli') {
        socket.close();
      }
      return;
    }

    if (role === 'cli' && message['type'] === 'bridge:update') {
      const payload = message['payload'] as BridgeUpdatePayload | undefined;
      const instanceId = payload?.instanceId;

      log('bridge:update', {
        instanceId,
        history: payload?.history?.length ?? 0,
        pending: payload?.pending?.length ?? 0,
        streamingState: payload?.streamingState ?? 'unknown',
      });

      if (instanceId && !boundInstanceId) {
        boundInstanceId = instanceId;
        const bridge = callbacks.getGeminiBridge(instanceId);
        if (bridge) {
          bridge.bindSocket(socket);
        } else if (payload) {
          // Orphan CLI — server wasn't expecting this instance
          callbacks.onOrphanCliConnect(instanceId, socket, payload);
        }
      }

      if (instanceId && payload) {
        const bridge = callbacks.getGeminiBridge(instanceId);
        if (bridge) {
          bridge.handleBridgeUpdate(payload);
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
      const bridge = callbacks.getGeminiBridge(boundInstanceId);
      if (bridge) {
        bridge.handleSocketClose();
      }
    }
  });
}
