import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import type {
  Message,
  StreamingState,
  IncomingMessage,
  OutgoingMessage,
  ModelOption,
  BridgeUpdatePayload,
  InstanceStatus,
  SessionStateMessage,
} from './types';

// Instance state for a single CLI connection
export interface InstanceState {
  id: string;
  projectPath: string;
  status: InstanceStatus;
  history: Message[];
  pending: Message[];
  streamingState: StreamingState;
  isTrustedFolder: boolean;
  currentModel: string;
  availableModels: ModelOption[];
  error?: string;
}

export interface UseSessionReturn {
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
  spawnInstance: (projectPath: string) => Promise<string | null>;
  terminateInstance: (instanceId: string) => void;
}

const SESSION_KEY = 'gemini-web-session-id';
const RECENT_PROJECTS_KEY = 'gemini-web-recent-projects';
const MAX_RECENT_PROJECTS = 10;

let inMemorySessionId: string | null = null;

const getDebugFlag = () => {
  try {
    return window.localStorage.getItem('geminiWebDebug') === '1';
  } catch {
    return false;
  }
};

const debug =
  typeof window !== 'undefined' &&
  (window.location.search.includes('debug=1') || getDebugFlag());

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

const loadSessionId = (): string | null => {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return inMemorySessionId;
  }
};

const saveSessionId = (sessionId: string) => {
  try {
    sessionStorage.setItem(SESSION_KEY, sessionId);
  } catch {
    inMemorySessionId = sessionId;
  }
};

export function useSession(): UseSessionReturn {
  const [connected, setConnected] = useState(false);
  const [instances, setInstances] = useState<Map<string, InstanceState>>(
    new Map(),
  );
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<string[]>(() =>
    loadRecentProjects(),
  );

  const sessionIdRef = useRef<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const activeInstance = useMemo(() => {
    if (!activeInstanceId) return null;
    return instances.get(activeInstanceId) ?? null;
  }, [instances, activeInstanceId]);

  const ensureSession = useCallback(async () => {
    const existing = loadSessionId();
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(existing ? { sessionId: existing } : {}),
    });
    if (!res.ok) {
      throw new Error('Failed to create session');
    }
    const data = (await res.json()) as { sessionId?: string };
    if (!data.sessionId) {
      throw new Error('Session id missing');
    }
    saveSessionId(data.sessionId);
    sessionIdRef.current = data.sessionId;
    return data.sessionId;
  }, []);

  const sendCommand = useCallback(async (payload: OutgoingMessage) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      return null;
    }
    const res = await fetch(`/api/session/${sessionId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return null;
    }
    try {
      return await res.json();
    } catch {
      return null;
    }
  }, []);

  const setActiveInstance = useCallback(
    (instanceId: string | null) => {
      log('set active instance', instanceId);
      setActiveInstanceId(instanceId);
      if (instanceId) {
        void sendCommand({ type: 'setActiveInstance', instanceId });
      }
    },
    [sendCommand],
  );

  const sendSubmit = useCallback(
    (text: string) => {
      if (!activeInstanceId) {
        log('sendSubmit: no active instance');
        return;
      }
      log('send submit', { instanceId: activeInstanceId, length: text.length });
      void sendCommand({ type: 'submit', text, instanceId: activeInstanceId });
    },
    [sendCommand, activeInstanceId],
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
      void sendCommand({
        type: 'confirm',
        callId,
        outcome,
        correlationId,
        instanceId: activeInstanceId,
      });
    },
    [sendCommand, activeInstanceId],
  );

  const sendSetModel = useCallback(
    (model: string) => {
      if (!activeInstanceId) {
        log('sendSetModel: no active instance');
        return;
      }
      log('send setModel', { instanceId: activeInstanceId, model });
      void sendCommand({
        type: 'setModel',
        model,
        instanceId: activeInstanceId,
      });
    },
    [sendCommand, activeInstanceId],
  );

  const spawnInstance = useCallback(
    async (projectPath: string) => {
      if (!projectPath) {
        return null;
      }
      log('spawn instance', projectPath);
      const result = (await sendCommand({
        type: 'spawnInstance',
        projectPath,
      })) as { instanceId?: string } | null;
      const instanceId = result?.instanceId ?? null;
      if (instanceId) {
        setActiveInstanceId(instanceId);
        setInstances((prev) => {
          const next = new Map(prev);
          next.set(instanceId, {
            id: instanceId,
            projectPath,
            status: 'connecting',
            history: [],
            pending: [],
            streamingState: 'idle',
            isTrustedFolder: false,
            currentModel: 'auto-gemini-2.5',
            availableModels: [],
            error: undefined,
          });
          return next;
        });
      }
      setRecentProjects((prev) => addToRecentProjects(projectPath, prev));
      return instanceId;
    },
    [sendCommand],
  );

  const terminateInstance = useCallback(
    (instanceId: string) => {
      if (!instanceId) return;
      log('terminate instance', instanceId);
      void sendCommand({ type: 'terminateInstance', instanceId });
      setInstances((prev) => {
        const next = new Map(prev);
        next.delete(instanceId);
        return next;
      });
      setActiveInstanceId((current) =>
        current === instanceId ? null : current,
      );
    },
    [sendCommand],
  );

  const applyBridgeUpdate = useCallback((payload: BridgeUpdatePayload) => {
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
          payload.currentModel ?? existing?.currentModel ?? 'auto-gemini-2.5',
        availableModels:
          payload.availableModels ?? existing?.availableModels ?? [],
        error: undefined,
      });
      return next;
    });

    setActiveInstanceId((current) => current ?? payload.instanceId);

    if (payload.projectPath) {
      setRecentProjects((prev) =>
        addToRecentProjects(payload.projectPath, prev),
      );
    }
  }, []);

  const applyCliStatus = useCallback(
    (message: Extract<IncomingMessage, { type: 'bridge:cli-status' }>) => {
      if (!message.instanceId) return;
      setInstances((prev) => {
        const next = new Map(prev);
        const existing = next.get(message.instanceId!);
        const status: InstanceStatus =
          message.status ?? (message.connected ? 'connected' : 'disconnected');
        if (existing) {
          next.set(message.instanceId!, {
            ...existing,
            status,
            error: message.error ?? existing.error,
          });
        } else if (message.connected) {
          next.set(message.instanceId!, {
            id: message.instanceId!,
            projectPath: '',
            status,
            history: [],
            pending: [],
            streamingState: 'idle',
            isTrustedFolder: false,
            currentModel: 'auto-gemini-2.5',
            availableModels: [],
            error: message.error,
          });
        }
        return next;
      });
    },
    [],
  );

  const applyInstanceList = useCallback(
    (message: Extract<IncomingMessage, { type: 'bridge:instance-list' }>) => {
      setInstances((prev) => {
        const next = new Map(prev);
        const seen = new Set<string>();
        for (const inst of message.instances) {
          const existing = next.get(inst.id);
          const status: InstanceStatus =
            inst.status ?? (inst.connected ? 'connected' : 'disconnected');
          if (existing) {
            next.set(inst.id, {
              ...existing,
              projectPath: inst.projectPath,
              status,
              error: inst.error ?? existing.error,
            });
          } else {
            next.set(inst.id, {
              id: inst.id,
              projectPath: inst.projectPath,
              status,
              history: [],
              pending: [],
              streamingState: 'idle',
              isTrustedFolder: false,
              currentModel: 'auto-gemini-2.5',
              availableModels: [],
              error: inst.error,
            });
          }
          seen.add(inst.id);
        }
        for (const id of next.keys()) {
          if (!seen.has(id)) {
            next.delete(id);
          }
        }
        return next;
      });

      setActiveInstanceId((current) => {
        if (!current) {
          return message.instances[0]?.id ?? null;
        }
        const exists = message.instances.some((inst) => inst.id === current);
        return exists ? current : (message.instances[0]?.id ?? null);
      });
    },
    [],
  );

  const applySessionState = useCallback((message: SessionStateMessage) => {
    const nextInstances = new Map<string, InstanceState>();
    for (const inst of message.instances) {
      const status: InstanceStatus =
        inst.status ?? (inst.connected ? 'connected' : 'disconnected');
      nextInstances.set(inst.id, {
        id: inst.id,
        projectPath: inst.projectPath,
        status,
        history: [],
        pending: [],
        streamingState: 'idle',
        isTrustedFolder: false,
        currentModel: 'auto-gemini-2.5',
        availableModels: [],
        error: inst.error,
      });
    }

    for (const snapshot of message.snapshots) {
      const existing = nextInstances.get(snapshot.instanceId);
      nextInstances.set(snapshot.instanceId, {
        id: snapshot.instanceId,
        projectPath: snapshot.projectPath,
        status: 'connected',
        history: snapshot.history ?? [],
        pending: snapshot.pending ?? [],
        streamingState: snapshot.streamingState ?? 'idle',
        isTrustedFolder: Boolean(snapshot.isTrustedFolder),
        currentModel:
          snapshot.currentModel ?? existing?.currentModel ?? 'auto-gemini-2.5',
        availableModels:
          snapshot.availableModels ?? existing?.availableModels ?? [],
        error: undefined,
      });
      if (snapshot.projectPath) {
        setRecentProjects((prev) =>
          addToRecentProjects(snapshot.projectPath, prev),
        );
      }
    }

    setInstances(nextInstances);

    const fallbackActive =
      message.instances[0]?.id ?? message.snapshots[0]?.instanceId ?? null;
    setActiveInstanceId(message.activeInstanceId ?? fallbackActive);
  }, []);

  const applyError = useCallback(
    (message: Extract<IncomingMessage, { type: 'bridge:error' }>) => {
      if (!message.instanceId) return;
      setInstances((prev) => {
        const next = new Map(prev);
        const existing = next.get(message.instanceId!);
        if (!existing) return next;
        next.set(message.instanceId!, {
          ...existing,
          status: 'error',
          error: message.error,
        });
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    let isMounted = true;

    const connect = async () => {
      if (!isMounted) return;
      try {
        const sessionId = await ensureSession();
        if (!isMounted) return;
        const es = new EventSource(`/api/session/${sessionId}/events`);
        eventSourceRef.current = es;

        es.onopen = () => {
          if (!isMounted) return;
          setConnected(true);
        };

        es.onmessage = (event) => {
          let message: IncomingMessage;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }

          if (message.type === 'session_state') {
            applySessionState(message);
            return;
          }
          if (message.type === 'bridge:update') {
            applyBridgeUpdate(message.payload as BridgeUpdatePayload);
            return;
          }
          if (message.type === 'bridge:cli-status') {
            applyCliStatus(message);
            return;
          }
          if (message.type === 'bridge:instance-list') {
            applyInstanceList(message);
            return;
          }
          if (message.type === 'bridge:error') {
            applyError(message);
          }
        };

        es.onerror = () => {
          if (!isMounted) return;
          setConnected(false);
          es.close();
          reconnectTimeoutRef.current = window.setTimeout(connect, 1000);
        };
      } catch (error) {
        log('connect error', error);
        if (!isMounted) return;
        setConnected(false);
        reconnectTimeoutRef.current = window.setTimeout(connect, 1000);
      }
    };

    void connect();

    return () => {
      isMounted = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [
    applyBridgeUpdate,
    applyCliStatus,
    applyError,
    applyInstanceList,
    applySessionState,
    ensureSession,
  ]);

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
