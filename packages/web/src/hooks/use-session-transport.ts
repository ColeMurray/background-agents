"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { serverMessageSchema } from "@open-inspect/shared";
import type { ServerMessage } from "@open-inspect/shared";

// WebSocket URL (should come from env in production)
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8787";

// WebSocket close codes
const WS_CLOSE_AUTH_REQUIRED = 4001;
const WS_CLOSE_SESSION_EXPIRED = 4002;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const PING_INTERVAL_MS = 30000;

function parseWsMessage(raw: unknown): ServerMessage | null {
  const result = serverMessageSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export interface SessionTransportHandlers {
  /** A schema-validated server message arrived. */
  onMessage: (message: ServerMessage) => void;
  /** The socket closed (any reason), before reconnection is scheduled. */
  onClose?: () => void;
}

export interface UseSessionTransportReturn {
  connected: boolean;
  connecting: boolean;
  authError: string | null;
  connectionError: string | null;
  /** Whether the socket is currently open. */
  isOpen: () => boolean;
  /** Send a JSON payload; drops it silently when the socket is not open. */
  send: (payload: Record<string, unknown>) => void;
  /** Drop the connection and token, then connect fresh. */
  reconnect: () => void;
}

/**
 * Owns the WebSocket transport for a session: auth-token fetch, the
 * subscribe handshake, keepalive pings, close-code handling, and
 * exponential-backoff reconnection. Protocol semantics (what the messages
 * mean) belong to the caller via `onMessage`.
 */
export function useSessionTransport(
  sessionId: string,
  handlers: SessionTransportHandlers
): UseSessionTransportReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const wsTokenRef = useRef<string | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);
  // Monotonic id for connection attempts. reconnect() and unmount bump it so
  // a connect() that resumes after awaiting its token can tell it has been
  // superseded and must not open a socket.
  const connectEpochRef = useRef(0);
  // Epoch of the connect() currently between entry and socket creation, or
  // null when none is in flight. Recording the owner (rather than a boolean)
  // lets a superseded connect release the flag without clobbering a newer
  // attempt's.
  const connectingEpochRef = useRef<number | null>(null);

  // Latest-handler ref so connect() stays stable across renders.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const fetchWsToken = useCallback(async (): Promise<string | null> => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/ws-token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          setAuthError("Please sign in to connect");
          return null;
        }
        const error = await response.text();
        console.error("Failed to fetch WS token:", error);
        setAuthError("Failed to authenticate");
        return null;
      }

      const data = await response.json();
      return data.token;
    } catch (error) {
      console.error("Failed to fetch WS token:", error);
      setAuthError("Failed to authenticate");
      return null;
    }
  }, [sessionId]);

  const connect = useCallback(async () => {
    // Use refs to avoid race conditions with React StrictMode
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log("WebSocket already open");
      return;
    }
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
      console.log("WebSocket already connecting");
      return;
    }
    if (connectingEpochRef.current !== null) {
      console.log("Connection in progress (ref)");
      return;
    }

    const epoch = connectEpochRef.current;
    connectingEpochRef.current = epoch;
    setConnecting(true);
    setAuthError(null);

    // Fetch a WebSocket auth token first
    if (!wsTokenRef.current) {
      const token = await fetchWsToken();
      if (epoch !== connectEpochRef.current) {
        // Superseded by reconnect() or unmount while awaiting the token.
        // Release the in-flight flag only if this attempt still owns it, and
        // never store or use a token fetched for a stale attempt.
        if (connectingEpochRef.current === epoch) {
          connectingEpochRef.current = null;
          setConnecting(false);
        }
        return;
      }
      if (!token) {
        connectingEpochRef.current = null;
        setConnecting(false);
        return;
      }
      wsTokenRef.current = token;
    }

    const wsUrl = `${WS_URL}/sessions/${sessionId}/ws`;
    console.log("WebSocket connecting to:", wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws || !mountedRef.current) {
        ws.close();
        return;
      }
      console.log("WebSocket connected!");
      connectingEpochRef.current = null;
      setConnected(true);
      setConnecting(false);
      reconnectAttempts.current = 0;

      // Subscribe to session with the auth token
      ws.send(
        JSON.stringify({
          type: "subscribe",
          token: wsTokenRef.current,
          clientId: crypto.randomUUID(),
        })
      );
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return;
      try {
        const data = parseWsMessage(JSON.parse(event.data));
        if (!data) return;
        handlersRef.current.onMessage(data);
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    ws.onclose = (event) => {
      // Browsers deliver close events asynchronously: a socket discarded by
      // reconnect() or cleanup can close after its replacement exists. Only
      // the current socket may mutate shared connection state.
      if (wsRef.current !== ws) return;

      console.log("WebSocket closed:", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      connectingEpochRef.current = null;
      setConnected(false);
      setConnecting(false);
      wsRef.current = null;
      handlersRef.current.onClose?.();

      // Handle authentication errors
      if (event.code === WS_CLOSE_AUTH_REQUIRED) {
        setAuthError("Authentication failed. Please sign in again.");
        // Clear the token so we fetch a new one on reconnect
        wsTokenRef.current = null;
        return;
      }

      // Handle session expired (e.g., after server hibernation)
      if (event.code === WS_CLOSE_SESSION_EXPIRED) {
        setConnectionError("Session expired. Please reconnect.");
        wsTokenRef.current = null;
        return;
      }

      // Only reconnect if mounted and not a clean close
      if (mountedRef.current && !event.wasClean) {
        if (reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts.current),
            MAX_RECONNECT_DELAY_MS
          );
          reconnectAttempts.current++;
          console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);

          reconnectTimeoutRef.current = setTimeout(() => {
            if (mountedRef.current) {
              connect();
            }
          }, delay);
        } else {
          // Exhausted reconnection attempts
          console.error(`WebSocket reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
          setConnectionError("Connection lost. Please check your network and try reconnecting.");
        }
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error event:", error);
    };
  }, [sessionId, fetchWsToken]);

  // Bump the epoch so a connect() awaiting its token bails instead of opening
  // a socket for an attempt that reconnect() or unmount has abandoned.
  const invalidateInFlightConnect = useCallback(() => {
    connectEpochRef.current++;
    connectingEpochRef.current = null;
  }, []);

  const isOpen = useCallback(() => wsRef.current?.readyState === WebSocket.OPEN, []);

  const send = useCallback((payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(JSON.stringify(payload));
  }, []);

  const reconnect = useCallback(() => {
    // A connect() still awaiting its token must not open a second socket
    // alongside the one this call creates.
    invalidateInFlightConnect();
    const discarded = wsRef.current;
    if (discarded) {
      wsRef.current = null;
      discarded.close();
      // The discarded socket's close event is ignored by the identity guard
      // (and may arrive late), so notify the protocol layer directly.
      handlersRef.current.onClose?.();
      setConnected(false);
    }
    reconnectAttempts.current = 0;
    wsTokenRef.current = null; // Clear token to fetch fresh one
    setAuthError(null);
    setConnectionError(null);
    connect();
  }, [connect, invalidateInFlightConnect]);

  // Connect on mount
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      invalidateInFlightConnect();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const discarded = wsRef.current;
      if (discarded) {
        wsRef.current = null;
        discarded.close();
      }
    };
  }, [connect, invalidateInFlightConnect]);

  // Ping periodically to keep connection alive.
  useEffect(() => {
    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);

    return () => clearInterval(pingInterval);
  }, []);

  return { connected, connecting, authError, connectionError, isOpen, send, reconnect };
}
