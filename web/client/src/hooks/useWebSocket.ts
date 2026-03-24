import { useEffect, useRef, useState, useCallback } from "react";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface WSMessage {
  type: string;
  payload?: unknown;
  timestamp?: string;
}

type MessageHandler = (msg: WSMessage) => void;

export function useWebSocket() {
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<MessageHandler>>>(new Map());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws`;

    setStatus("connecting");
    const ws = new WebSocket(url);

    ws.onopen = () => setStatus("connected");

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        setLastMessage(msg);
        const handlers = handlersRef.current.get(msg.type);
        if (handlers) {
          handlers.forEach((h) => h(msg));
        }
        // Also fire wildcard handlers
        const wildcardHandlers = handlersRef.current.get("*");
        if (wildcardHandlers) {
          wildcardHandlers.forEach((h) => h(msg));
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      wsRef.current = null;
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribe = useCallback(
    (type: string, handler: MessageHandler): (() => void) => {
      if (!handlersRef.current.has(type)) {
        handlersRef.current.set(type, new Set());
      }
      handlersRef.current.get(type)!.add(handler);
      return () => {
        handlersRef.current.get(type)?.delete(handler);
      };
    },
    [],
  );

  return { lastMessage, status, subscribe };
}
