"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  serverMessageSchema,
  type ServerMessage,
} from "@open-inspect/shared/types/server-messages";
import {
  WS_CLOSE_AUTHORIZATION_REVOKED,
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_INTERNAL_ERROR,
  WS_CLOSE_SERVICE_RESTART,
  WS_CLOSE_TRY_AGAIN_LATER,
} from "@open-inspect/shared/types/websocket";

function parseWsMessage(raw: unknown): ServerMessage | null {
  const result = serverMessageSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// WebSocket URL (should come from env in production)
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8787";

// WebSocket close codes
const WS_CLOSE_AUTH_REQUIRED = 4001;
const WS_CLOSE_SESSION_EXPIRED = 4002;
const WS_CLOSE_INVALID_MESSAGE = 4004;

// How long any *transient* cause may keep the socket down before the client
// stops trying: `MAX_RECONNECT_ATTEMPTS` on the backoff below spans ~3
// minutes, which covers a host restart, a redeploy behind a proxy, or a
// network blip. The cause decides whether to retry; this decides for how long.
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
// RFC 6455 registers 1012 with a randomized 5-30s reconnect. A restart closes
// every tab at once, so the randomization spreads the return; and a host that
// is restarting is not listening again a second later anyway.
const RESTART_MIN_DELAY_MS = 5000;
const RESTART_MAX_DELAY_MS = 30000;
const PING_INTERVAL_MS = 30000;
// Only one WebSocket credential is stored per participant, so another tab
// opening the session invalidates this one's. A single automatic reissue per
// healthy connection recovers from that without turning a genuine auth
// failure into a refresh loop.
const MAX_CREDENTIAL_REFRESHES = 1;

function reconnectDelayMs(attemptsSoFar: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attemptsSoFar), MAX_RECONNECT_DELAY_MS);
}

function restartDelayMs(): number {
  return RESTART_MIN_DELAY_MS + Math.random() * (RESTART_MAX_DELAY_MS - RESTART_MIN_DELAY_MS);
}

/** Where the transport is in its connection lifecycle; states are exclusive. */
type ConnectionPhase = "idle" | "connecting" | "connected" | "reconnecting";

/** What a close event calls for, decided as data; the caller applies effects. */
type CloseDirective =
  | { action: "auth_required" }
  | { action: "refresh_credential" }
  | { action: "refresh_authorization" }
  | { action: "session_expired" }
  | { action: "authorization_revoked"; delayMs?: number }
  | { action: "retry"; delayMs: number }
  | { action: "await_user"; message: string }
  | { action: "give_up" }
  | { action: "none" };

function closeDirective(
  event: Pick<CloseEvent, "code" | "wasClean">,
  attemptsSoFar: number,
  refreshesSoFar: number
): CloseDirective {
  if (event.code === WS_CLOSE_AUTH_REQUIRED) {
    // A rejected credential is more often stale than revoked: reissue once
    // before telling a signed-in user to sign in again.
    return refreshesSoFar < MAX_CREDENTIAL_REFRESHES
      ? { action: "refresh_credential" }
      : { action: "auth_required" };
  }
  if (event.code === WS_CLOSE_AUTHORIZATION_REVOKED) {
    return { action: "refresh_authorization" };
  }
  if (event.code === WS_CLOSE_SESSION_EXPIRED) {
    return { action: "session_expired" };
  }
  const budget = (delayMs: number): CloseDirective =>
    attemptsSoFar < MAX_RECONNECT_ATTEMPTS ? { action: "retry", delayMs } : { action: "give_up" };

  if (event.code === WS_CLOSE_SERVICE_RESTART) {
    return budget(restartDelayMs());
  }
  if (event.code === WS_CLOSE_TRY_AGAIN_LATER) {
    // Overload, and the only sender here closes a peer for exhausting its own
    // delivery backlog. Coming back on a timer would repeat what the host just
    // refused, so RFC 6455 asks for a reconnect on user action instead - the
    // banner's button, which needs `connectionError` set to appear.
    return {
      action: "await_user",
      message: "The server is too busy to accept the connection. Try reconnecting in a moment.",
    };
  }
  if (
    // Transient: the peer expects the client back as soon as it can manage.
    !event.wasClean ||
    event.code === WS_CLOSE_INVALID_MESSAGE ||
    event.code === WS_CLOSE_INTERNAL_ERROR ||
    event.code === WS_CLOSE_GOING_AWAY
  ) {
    return budget(reconnectDelayMs(attemptsSoFar));
  }
  return { action: "none" };
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
  /** A reconnect is scheduled and has not started yet. */
  reconnecting: boolean;
  authError: string | null;
  connectionError: string | null;
  /** Whether the socket is currently open. */
  isOpen: () => boolean;
  /** Send a JSON payload; drops it silently when the socket is not open. */
  send: (payload: Record<string, unknown>) => void;
  /** Drop the connection and token, then connect fresh. */
  reconnect: () => void;
  /** Mark synchronization complete so future network retries start fresh. */
  markHealthy: () => void;
}

/**
 * Owns the WebSocket transport for a session: auth-token fetch, the
 * subscribe handshake, keepalive pings, close-code handling, and
 * exponential-backoff reconnection. Protocol semantics (what the messages
 * mean) belong to the caller via `onMessage`.
 */
export function useSessionTransport(
  sessionId: string,
  handlers: SessionTransportHandlers,
  enabled = true
): UseSessionTransportReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const wsTokenRef = useRef<string | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);
  // Automatic credential reissues spent since the last healthy connection.
  const credentialRefreshes = useRef(0);
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
  const { onMessage, onClose } = handlers;
  const handlersRef = useRef({ onMessage, onClose });

  useEffect(() => {
    handlersRef.current = { onMessage, onClose };
  }, [onMessage, onClose]);

  // One phase, not three independent booleans: the socket is either down,
  // being opened, open, or waiting out a scheduled reconnect. The three
  // booleans below are views of it, kept because the session page composes
  // `connecting` with protocol readiness before it reaches the header.
  const [phase, setPhase] = useState<ConnectionPhase>("idle");
  const connected = phase === "connected";
  const connecting = phase === "connecting";
  const reconnecting = phase === "reconnecting";
  const [authError, setAuthError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const fetchWsToken = useCallback(async (): Promise<string | null> => {
    try {
      const response = await browserApiFetch(`/api/sessions/${sessionId}/ws-token`, {
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

  /**
   * Make sure `wsTokenRef` holds an auth token, fetching one if needed.
   * Returns false when none is available: the fetch failed, or `epoch` was
   * superseded (reconnect()/unmount) while awaiting — a stale attempt's
   * token is never stored, since it may belong to an old sessionId. The
   * in-flight flag lifecycle stays with connect().
   */
  const ensureWsToken = useCallback(
    async (epoch: number): Promise<boolean> => {
      if (wsTokenRef.current) {
        return true;
      }
      const token = await fetchWsToken();
      if (epoch !== connectEpochRef.current || !token) {
        return false;
      }
      wsTokenRef.current = token;
      return true;
    },
    [fetchWsToken]
  );

  const handleSocketOpen = useCallback((ws: WebSocket) => {
    if (wsRef.current !== ws || !mountedRef.current) {
      ws.close();
      return;
    }
    console.log("WebSocket connected!");
    connectingEpochRef.current = null;
    setPhase("connected");

    ws.send(
      JSON.stringify({
        type: "subscribe",
        token: wsTokenRef.current,
        clientId: crypto.randomUUID(),
      })
    );
  }, []);

  const handleSocketMessage = useCallback((ws: WebSocket, event: MessageEvent) => {
    if (wsRef.current !== ws) return;
    try {
      const raw: unknown = JSON.parse(event.data);
      const data = parseWsMessage(raw);
      if (!data) {
        console.error("Received invalid WebSocket message");
        ws.close(WS_CLOSE_INVALID_MESSAGE, "Invalid server message");
        return;
      }
      handlersRef.current.onMessage(data);
    } catch (error) {
      console.error("Failed to parse WebSocket message:", error);
      ws.close(WS_CLOSE_INVALID_MESSAGE, "Invalid server message");
    }
  }, []);

  /**
   * The single path back onto the wire: arms the timer and the phase together
   * so no close branch can schedule a reconnect the UI does not report.
   */
  const scheduleReconnect = useCallback((delayMs: number, retry: () => void) => {
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    setPhase("reconnecting");
    reconnectTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) retry();
    }, delayMs);
  }, []);

  /** `retry` is the connect function to schedule on an unclean close. */
  const handleSocketClose = useCallback(
    (ws: WebSocket, event: CloseEvent, retry: () => void) => {
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
      // Every close ends any pending reconnect; a branch below re-arms it
      // through scheduleReconnect, which owns the timer and the phase together.
      setPhase("idle");
      wsRef.current = null;
      handlersRef.current.onClose?.();

      const directive = closeDirective(
        event,
        reconnectAttempts.current,
        credentialRefreshes.current
      );
      switch (directive.action) {
        case "auth_required":
          setAuthError("Authentication failed. Please sign in again.");
          // Clear the token so we fetch a new one on reconnect
          wsTokenRef.current = null;
          return;

        case "refresh_credential":
          if (!mountedRef.current) return;
          credentialRefreshes.current++;
          wsTokenRef.current = null;
          scheduleReconnect(0, retry);
          return;

        case "refresh_authorization":
          if (!mountedRef.current) return;
          wsTokenRef.current = null;
          reconnectAttempts.current = 0;
          setAuthError(null);
          setConnectionError(null);
          scheduleReconnect(0, retry);
          return;

        case "session_expired":
          // e.g. after server hibernation
          setConnectionError("Session expired. Please reconnect.");
          wsTokenRef.current = null;
          return;

        case "authorization_revoked":
          wsTokenRef.current = null;
          if (!mountedRef.current) return;
          if (directive.delayMs === undefined) {
            setConnectionError("Authorization could not be refreshed. Please try reconnecting.");
            return;
          }
          reconnectAttempts.current++;
          scheduleReconnect(directive.delayMs, retry);
          return;

        case "retry":
          if (!mountedRef.current) return;
          reconnectAttempts.current++;
          console.log(
            `Reconnecting in ${directive.delayMs}ms (attempt ${reconnectAttempts.current})`
          );
          scheduleReconnect(directive.delayMs, retry);
          return;

        case "await_user":
          setConnectionError(directive.message);
          return;

        case "give_up":
          if (!mountedRef.current) return;
          console.error(`WebSocket reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
          setConnectionError("Connection lost. Please check your network and try reconnecting.");
          return;

        case "none":
          return;
      }
    },
    [scheduleReconnect]
  );

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
    setPhase("connecting");
    setAuthError(null);

    const tokenReady = await ensureWsToken(epoch);
    if (epoch !== connectEpochRef.current) {
      // Superseded while suspended — even the cached-token path yields a
      // microtask. Release the in-flight flag only if this attempt still
      // owns it; a newer connect may hold it now.
      if (connectingEpochRef.current === epoch) {
        connectingEpochRef.current = null;
        setPhase("idle");
      }
      return;
    }
    if (!tokenReady) {
      connectingEpochRef.current = null;
      setPhase("idle");
      return;
    }

    const wsUrl = `${WS_URL}/sessions/${sessionId}/ws`;
    console.log("WebSocket connecting to:", wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => handleSocketOpen(ws);
    ws.onmessage = (event) => handleSocketMessage(ws, event);
    ws.onclose = (event) => handleSocketClose(ws, event, connect);
    ws.onerror = (error) => console.error("WebSocket error event:", error);
  }, [sessionId, ensureWsToken, handleSocketOpen, handleSocketMessage, handleSocketClose]);

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
    if (!enabled) return;
    // A connect() still awaiting its token must not open a second socket
    // alongside the one this call creates.
    invalidateInFlightConnect();
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    const discarded = wsRef.current;
    if (discarded) {
      wsRef.current = null;
      discarded.close();
      // The discarded socket's close event is ignored by the identity guard
      // (and may arrive late), so notify the protocol layer directly.
      handlersRef.current.onClose?.();
      setPhase("idle");
    }
    reconnectAttempts.current = 0;
    credentialRefreshes.current = 0;
    wsTokenRef.current = null; // Clear token to fetch fresh one
    setAuthError(null);
    setConnectionError(null);
    connect();
  }, [connect, enabled, invalidateInFlightConnect]);

  const markHealthy = useCallback(() => {
    reconnectAttempts.current = 0;
    credentialRefreshes.current = 0;
  }, []);

  // Track the actual component lifetime separately from capability changes.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Connect while read transport is allowed. Cleanup is also the explicit
  // enabled -> disabled transition: invalidate pending work, notify the
  // protocol layer, and reset all transport state before a later re-enable.
  useEffect(() => {
    if (enabled) connect();

    return () => {
      const discarded = wsRef.current;
      const hadActiveAttempt = discarded !== null || connectingEpochRef.current !== null;
      invalidateInFlightConnect();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (discarded) {
        wsRef.current = null;
        discarded.close();
      }
      wsTokenRef.current = null;
      reconnectAttempts.current = 0;
      credentialRefreshes.current = 0;
      setPhase("idle");
      setAuthError(null);
      setConnectionError(null);
      if (hadActiveAttempt) handlersRef.current.onClose?.();
    };
  }, [connect, enabled, invalidateInFlightConnect]);

  // Ping periodically to keep connection alive.
  useEffect(() => {
    if (!enabled) return;
    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);

    return () => clearInterval(pingInterval);
  }, [enabled]);

  return {
    connected,
    connecting,
    reconnecting,
    authError,
    connectionError,
    isOpen,
    send,
    reconnect,
    markHealthy,
  };
}
