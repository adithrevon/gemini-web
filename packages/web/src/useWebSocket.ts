import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import type {
  Message,
  StreamingState,
  IncomingMessage,
  OutgoingMessage,
  ModelOption,
  BridgeUpdatePayload,
} from './types';

// Instance state for a single CLI connection
export interface InstanceState {
  id: string;
  projectPath: string;
  status: 'connecting' | 'connected' | 'disconnected';
  history: Message[];
  pending: Message[];
  streamingState: StreamingState;
  isTrustedFolder: boolean;
  currentModel: string;
  availableModels: ModelOption[];
}

export interface UseWebSocketReturn {
  connected: boolean;
  instances: Map<string, InstanceState>;
  activeInstanceId: string | null;
  activeInstance: InstanceState | null;
  recentProjects: string[];
  setActiveInstance: (instanceId: string | null) => void;
  sendSubmit: (text: string) => void;
  sendConfirm: (
    callId: string,
    outcome: 'proceed_once' | 'proceed_always' | 'cancel',
    correlationId?: string,
  ) => void;
  sendSetModel: (model: string) => void;
  spawnInstance: (projectPath: string) => void;
  terminateInstance: (instanceId: string) => void;
}

const RECENT_PROJECTS_KEY = 'gemini-web-recent-projects';
const MAX_RECENT_PROJECTS = 10;

const debug =
  typeof window !== 'undefined' &&
  (window.location.search.includes('debug=1') ||
    window.localStorage.getItem('geminiWebDebug') === '1');

const log = (...args: unknown[]) => {
  if (debug) {
    console.log('[web-ui]', ...args);
  }
};

const loadRecentProjects = (): string[] => {
  try {
    const stored = localStorage.getItem(RECENT_PROJECTS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

const saveRecentProjects = (projects: string[]) => {
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects));
  } catch {
    // Ignore storage errors
  }
};

const addToRecentProjects = (
  projectPath: string,
  current: string[],
): string[] => {
  const filtered = current.filter((p) => p !== projectPath);
  const updated = [projectPath, ...filtered].slice(0, MAX_RECENT_PROJECTS);
  saveRecentProjects(updated);
  return updated;
};

export function useWebSocket(): UseWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const [instances, setInstances] = useState<Map<string, InstanceState>>(
    new Map(),
  );
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<string[]>(() =>
    loadRecentProjects(),
  );

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const activeInstance = useMemo(() => {
    if (!activeInstanceId) return null;
    return instances.get(activeInstanceId) ?? null;
  }, [instances, activeInstanceId]);

  const send = useCallback((message: OutgoingMessage) => {
    const socket = socketRef.current;
    console.log(
      '[useWebSocket] send called',
      message.type,
      'readyState:',
      socket?.readyState,
    );
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      console.log('[useWebSocket] message sent:', message.type);
      return true;
    }
    console.log('[useWebSocket] send failed - socket not open');
    return false;
  }, []);

  const sendSubmit = useCallback(
    (text: string) => {
      if (!activeInstanceId) {
        log('sendSubmit: no active instance');
        return;
      }
      log('send submit', { instanceId: activeInstanceId, length: text.length });
      send({ type: 'submit', text, instanceId: activeInstanceId });
    },
    [send, activeInstanceId],
  );

  const sendConfirm = useCallback(
    (
      callId: string,
      outcome: 'proceed_once' | 'proceed_always' | 'cancel',
      correlationId?: string,
    ) => {
      if (!activeInstanceId) {
        log('sendConfirm: no active instance');
        return;
      }
      log('send confirm', {
        instanceId: activeInstanceId,
        callId,
        outcome,
        correlationId,
      });
      send({
        type: 'confirm',
        callId,
        outcome,
        correlationId,
        instanceId: activeInstanceId,
      });
    },
    [send, activeInstanceId],
  );

  const sendSetModel = useCallback(
    (model: string) => {
      if (!activeInstanceId) {
        log('sendSetModel: no active instance');
        return;
      }
      log('send setModel', { instanceId: activeInstanceId, model });
      send({ type: 'setModel', model, instanceId: activeInstanceId });
    },
    [send, activeInstanceId],
  );

  const spawnInstance = useCallback(
    (projectPath: string) => {
      console.log('[useWebSocket] spawnInstance called with:', projectPath);
      const result = send({ type: 'spawnInstance', projectPath });
      console.log('[useWebSocket] spawnInstance send result:', result);
      setRecentProjects((prev) => addToRecentProjects(projectPath, prev));
    },
    [send],
  );

  const terminateInstance = useCallback(
    (instanceId: string) => {
      log('terminate instance', instanceId);
      send({ type: 'terminateInstance', instanceId });
      // Remove from local state immediately
      setInstances((prev) => {
        const next = new Map(prev);
        next.delete(instanceId);
        return next;
      });
      // If this was the active instance, clear selection
      setActiveInstanceId((current) =>
        current === instanceId ? null : current,
      );
    },
    [send],
  );

  const setActiveInstance = useCallback(
    (instanceId: string | null) => {
      log('set active instance', instanceId);
      setActiveInstanceId(instanceId);
      if (instanceId) {
        send({ type: 'setActiveInstance', instanceId });
      }
    },
    [send],
  );

  useEffect(() => {
    let isMounted = true;
    console.log('[useWebSocket] useEffect mount - setting up connection');

    const connect = () => {
      if (!isMounted) {
        console.log('[useWebSocket] connect called but unmounted, skipping');
        return;
      }

      const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = `${wsProtocol}://${window.location.host}/ws`;
      console.log('[useWebSocket] connecting to:', wsUrl);

      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      console.log(
        '[useWebSocket] socket created, readyState:',
        socket.readyState,
      );

      socket.addEventListener('open', () => {
        console.log('[useWebSocket] socket OPEN');
        if (!isMounted) {
          console.log('[useWebSocket] opened but unmounted, closing');
          socket.close();
          return;
        }
        setConnected(true);
        socket.send(JSON.stringify({ type: 'bridge:hello', role: 'web' }));
        console.log('[useWebSocket] sent hello');
      });

      socket.addEventListener('message', (event) => {
        let message: IncomingMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        console.log('[useWebSocket] received:', message.type);

        if (message.type === 'bridge:update') {
          const payload = message.payload as BridgeUpdatePayload;
          console.log('[useWebSocket] bridge:update', {
            instanceId: payload.instanceId,
            projectPath: payload.projectPath,
          });

          setInstances((prev) => {
            const next = new Map(prev);
            const existing = next.get(payload.instanceId);
            next.set(payload.instanceId, {
              id: payload.instanceId,
              projectPath: payload.projectPath,
              status: 'connected',
              history: payload.history ?? [],
              pending: payload.pending ?? [],
              streamingState: payload.streamingState ?? 'idle',
              isTrustedFolder: Boolean(payload.isTrustedFolder),
              currentModel:
                payload.currentModel ??
                existing?.currentModel ??
                'auto-gemini-2.5',
              availableModels:
                payload.availableModels ?? existing?.availableModels ?? [],
            });
            return next;
          });

          // Auto-select first instance if none active
          setActiveInstanceId((current) => {
            if (current === null) {
              return payload.instanceId;
            }
            return current;
          });

          // Add to recent projects
          if (payload.projectPath) {
            setRecentProjects((prev) =>
              addToRecentProjects(payload.projectPath, prev),
            );
          }
        }

        if (message.type === 'bridge:cli-status') {
          console.log('[useWebSocket] cli-status', message);
          if (message.instanceId) {
            setInstances((prev) => {
              const next = new Map(prev);
              const existing = next.get(message.instanceId!);
              if (existing) {
                next.set(message.instanceId!, {
                  ...existing,
                  status: message.connected ? 'connected' : 'disconnected',
                });
              } else if (message.connected) {
                // New instance connecting
                next.set(message.instanceId!, {
                  id: message.instanceId!,
                  projectPath: '',
                  status: 'connecting',
                  history: [],
                  pending: [],
                  streamingState: 'idle',
                  isTrustedFolder: false,
                  currentModel: 'auto-gemini-2.5',
                  availableModels: [],
                });
              }
              return next;
            });
          }
        }

        if (message.type === 'bridge:instance-list') {
          console.log('[useWebSocket] instance-list', message.instances);
          setInstances((prev) => {
            const next = new Map(prev);
            for (const inst of message.instances) {
              const existing = next.get(inst.id);
              if (existing) {
                next.set(inst.id, {
                  ...existing,
                  projectPath: inst.projectPath,
                  status: inst.connected ? 'connected' : 'disconnected',
                });
              } else {
                next.set(inst.id, {
                  id: inst.id,
                  projectPath: inst.projectPath,
                  status: inst.connected ? 'connected' : 'disconnected',
                  history: [],
                  pending: [],
                  streamingState: 'idle',
                  isTrustedFolder: false,
                  currentModel: 'auto-gemini-2.5',
                  availableModels: [],
                });
              }
            }
            return next;
          });
        }
      });

      socket.addEventListener('close', (event) => {
        console.log('[useWebSocket] socket CLOSE', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        setConnected(false);
        // Mark all instances as disconnected
        setInstances((prev) => {
          const next = new Map(prev);
          for (const [id, inst] of next) {
            next.set(id, { ...inst, status: 'disconnected' });
          }
          return next;
        });

        if (isMounted) {
          console.log('[useWebSocket] scheduling reconnect in 1s');
          reconnectTimeoutRef.current = window.setTimeout(connect, 1000);
        }
      });

      socket.addEventListener('error', (event) => {
        console.log('[useWebSocket] socket ERROR', event);
      });
    };

    connect();

    return () => {
      console.log('[useWebSocket] useEffect cleanup - isMounted = false');
      isMounted = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (socketRef.current) {
        console.log(
          '[useWebSocket] closing socket, readyState:',
          socketRef.current.readyState,
        );
        socketRef.current.close();
      }
    };
  }, []);

  return {
    connected,
    instances,
    activeInstanceId,
    activeInstance,
    recentProjects,
    setActiveInstance,
    sendSubmit,
    sendConfirm,
    sendSetModel,
    spawnInstance,
    terminateInstance,
  };
}
