import { useEffect, useRef, useCallback, useState } from 'react';
import type {
  Message,
  StreamingState,
  IncomingMessage,
  OutgoingMessage,
  ModelOption,
} from './types';

interface UseWebSocketReturn {
  connected: boolean;
  cliConnected: boolean;
  history: Message[];
  pending: Message[];
  streamingState: StreamingState;
  isTrustedFolder: boolean;
  currentModel: string;
  availableModels: ModelOption[];
  sendSubmit: (text: string) => void;
  sendConfirm: (
    callId: string,
    outcome: 'proceed_once' | 'proceed_always' | 'cancel',
    correlationId?: string
  ) => void;
  sendSetModel: (model: string) => void;
}

const debug =
  typeof window !== 'undefined' &&
  (window.location.search.includes('debug=1') ||
    window.localStorage.getItem('geminiWebDebug') === '1');

const log = (...args: unknown[]) => {
  if (debug) {
    console.log('[web-ui]', ...args);
  }
};

export function useWebSocket(): UseWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const [cliConnected, setCliConnected] = useState(false);
  const [history, setHistory] = useState<Message[]>([]);
  const [pending, setPending] = useState<Message[]>([]);
  const [streamingState, setStreamingState] = useState<StreamingState>('idle');
  const [isTrustedFolder, setIsTrustedFolder] = useState(false);
  const [currentModel, setCurrentModel] = useState('auto-gemini-2.5');
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([
    // Default models shown before CLI sends the actual list
    { value: 'auto-gemini-2.5', label: 'Auto (Gemini 2.5)', description: 'Let CLI decide', isAuto: true },
    { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro', isAuto: false },
    { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash', isAuto: false },
    { value: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite', isAuto: false },
  ]);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const send = useCallback((message: OutgoingMessage) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }, []);

  const sendSubmit = useCallback(
    (text: string) => {
      log('send submit', text);
      send({ type: 'submit', text });
    },
    [send]
  );

  const sendConfirm = useCallback(
    (
      callId: string,
      outcome: 'proceed_once' | 'proceed_always' | 'cancel',
      correlationId?: string
    ) => {
      log('send confirm', { callId, outcome, correlationId });
      send({
        type: 'confirm',
        callId,
        outcome,
        correlationId,
      });
    },
    [send]
  );

  const sendSetModel = useCallback(
    (model: string) => {
      log('send setModel', model);
      send({ type: 'setModel', model });
    },
    [send]
  );

  useEffect(() => {
    const connect = () => {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = `${wsProtocol}://${window.location.host}/ws`;
      log('connecting', wsUrl);

      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        log('open');
        setConnected(true);
        socket.send(JSON.stringify({ type: 'bridge:hello', role: 'web' }));
      });

      socket.addEventListener('message', (event) => {
        let message: IncomingMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (message.type === 'bridge:update') {
          log('bridge:update', message.payload);
          setHistory(message.payload?.history ?? []);
          setPending(message.payload?.pending ?? []);
          setStreamingState(message.payload?.streamingState ?? 'idle');
          setIsTrustedFolder(Boolean(message.payload?.isTrustedFolder));
          if (message.payload?.currentModel) {
            setCurrentModel(message.payload.currentModel);
          }
          if (message.payload?.availableModels) {
            setAvailableModels(message.payload.availableModels);
          }
        }

        if (message.type === 'bridge:cli-status') {
          log('cli-status', message.connected);
          setCliConnected(Boolean(message.connected));
        }
      });

      socket.addEventListener('close', () => {
        log('close');
        setConnected(false);
        setCliConnected(false);
        reconnectTimeoutRef.current = window.setTimeout(connect, 1000);
      });

      socket.addEventListener('error', (event) => {
        log('error', event);
      });
    };

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      socketRef.current?.close();
    };
  }, []);

  return {
    connected,
    cliConnected,
    history,
    pending,
    streamingState,
    isTrustedFolder,
    currentModel,
    availableModels,
    sendSubmit,
    sendConfirm,
    sendSetModel,
  };
}
