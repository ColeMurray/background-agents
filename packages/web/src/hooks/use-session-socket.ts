"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { mutate } from "swr";
import type { Artifact, SandboxEvent } from "@/types/session";
import type {
  ParticipantPresence,
  SandboxEvent as SharedSandboxEvent,
  ServerMessage,
  SessionState as SharedSessionState,
} from "@open-inspect/shared";

// WebSocket URL (should come from env in production)
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8787";

// WebSocket close codes
const WS_CLOSE_AUTH_REQUIRED = 4001;
const WS_CLOSE_SESSION_EXPIRED = 4002;

interface Message {
  id: string;
  authorId: string;
  content: string;
  source: string;
  status: string;
  createdAt: number;
}

type SessionState = SharedSessionState;
type Participant = ParticipantPresence;
type WsMessage = ServerMessage | { type: "artifact_updated"; artifact: Artifact };

interface UseSessionSocketReturn {
  connected: boolean;
  connecting: boolean;
  replaying: boolean;
  authError: string | null;
  connectionError: string | null;
  sessionState: SessionState | null;
  messages: Message[];
  events: SandboxEvent[];
  participants: Participant[];
  artifacts: Artifact[];
  currentParticipantId: string | null;
  isProcessing: boolean;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  sendPrompt: (content: string, model?: string, reasoningEffort?: string) => void;
  stopExecution: () => void;
  sendTyping: () => void;
  reconnect: () => void;
  loadOlderEvents: () => void;
}

/**
 * Collapse a batch of events by folding streaming token events into their
 * final form (only the last accumulated token before execution_complete is kept).
 * Mutates pendingTextRef to track in-flight tokens across calls.
 */
function collapseTokenEvents(
  events: SandboxEvent[],
  pendingTextRef: React.MutableRefObject<{
    content: string;
    messageId: string;
    timestamp: number;
  } | null>
): SandboxEvent[] {
  const result: SandboxEvent[] = [];
  for (const evt of events) {
    if (evt.type === "token" && evt.content && evt.messageId) {
      pendingTextRef.current = {
        content: evt.content,
        messageId: evt.messageId,
        timestamp: evt.timestamp,
      };
    } else if (evt.type === "execution_complete") {
      if (pendingTextRef.current) {
        const pending = pendingTextRef.current;
        pendingTextRef.current = null;
        result.push({
          type: "token",
          content: pending.content,
          messageId: pending.messageId,
          timestamp: pending.timestamp,
        });
      }
      result.push(evt);
    } else {
      result.push(evt);
    }
  }
  return result;
}

function parseWsMessage(raw: unknown): WsMessage | null {
  if (!raw || typeof raw !== "object") return null;
  if (!("type" in raw)) return null;
  return raw as WsMessage;
}

function toUiSandboxEvent(event: SharedSandboxEvent): SandboxEvent {
  return {
    ...(event as unknown as SandboxEvent),
    timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now() / 1000,
  };
}

function toUiArtifact(artifact: {
  id: string;
  type: string;
  url: string;
  prNumber?: number;
}): Artifact {
  return {
    id: artifact.id,
    type: artifact.type as Artifact["type"],
    url: artifact.url,
    createdAt: Date.now(),
    metadata: artifact.prNumber ? { prNumber: artifact.prNumber } : undefined,
  };
}

export function useSessionSocket(sessionId: string): UseSessionSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const connectingRef = useRef(false);
  const mountedRef = useRef(true);
  const subscribedRef = useRef(false);
  const wsTokenRef = useRef<string | null>(null);
  // Accumulates text during streaming, displayed only on completion to avoid duplicate display.
  // Stores only the latest token since token events contain the full accumulated text (not incremental).
  const pendingTextRef = useRef<{ content: string; messageId: string; timestamp: number } | null>(
    null
  );
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [replaying, setReplaying] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [messages, _setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<SandboxEvent[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [currentParticipantId, setCurrentParticipantId] = useState<string | null>(null);
  const currentParticipantRef = useRef<{
    participantId: string;
    name: string;
    avatar?: string;
  } | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);

  // Pagination state
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const cursorRef = useRef<{ timestamp: number; id: string } | null>(null);

  /**
   * Process a single live sandbox_event.
   */
  const processSandboxEvent = useCallback((event: SandboxEvent) => {
    if (event.type === "token" && event.content && event.messageId) {
      // Accumulate text but DON'T display yet
      pendingTextRef.current = {
        content: event.content,
        messageId: event.messageId,
        timestamp: event.timestamp,
      };
    } else if (event.type === "execution_complete") {
      // On completion: Add final text to events using the token's original timestamp
      if (pendingTextRef.current) {
        const pending = pendingTextRef.current;
        pendingTextRef.current = null;
        setEvents((prev) => [
          ...prev,
          {
            type: "token",
            content: pending.content,
            messageId: pending.messageId,
            timestamp: pending.timestamp,
          },
        ]);
      }
      setEvents((prev) => [...prev, event]);
    } else {
      // Other events (tool_call, user_message, git_sync, etc.) - add normally
      setEvents((prev) => [...prev, event]);
    }
  }, []);

  const handleMessage = useCallback(
    (data: WsMessage) => {
      switch (data.type) {
        case "subscribed": {
          console.log("WebSocket subscribed to session");
          subscribedRef.current = true;
          // Clear existing state since we're about to receive fresh history
          setArtifacts([]);
          pendingTextRef.current = null;
          if (data.state) {
            setSessionState({
              ...data.state,
              // Backward-compatible default for older sessions that may omit this.
              isProcessing: data.state.isProcessing ?? false,
            });
          }
          // Store the current user's participant ID and info for author attribution
          if (data.participantId) {
            setCurrentParticipantId(data.participantId);
          }
          // Initialize participant ref immediately for sendPrompt author attribution
          if (data.participant) {
            currentParticipantRef.current = data.participant;
          }

          // Process batched replay events in a single state update
          setEvents(
            data.replay
              ? collapseTokenEvents(data.replay.events.map(toUiSandboxEvent), pendingTextRef)
              : []
          );
          setHasMoreHistory(data.replay?.hasMore ?? false);
          cursorRef.current = data.replay?.cursor ?? null;
          setReplaying(false);

          if (data.spawnError) {
            console.error("Sandbox spawn error:", data.spawnError);
            setSessionState((prev) => (prev ? { ...prev, sandboxStatus: "failed" } : null));
          }
          break;
        }

        case "prompt_queued":
          // Could show queue position indicator
          break;

        case "sandbox_event":
          if (data.event) {
            processSandboxEvent(toUiSandboxEvent(data.event));
          }
          break;

        case "history_page": {
          // Prepend older events to the beginning
          setEvents((prev) => [...data.items.map(toUiSandboxEvent), ...prev]);
          setHasMoreHistory(data.hasMore ?? false);
          cursorRef.current = data.cursor ?? null;
          setLoadingHistory(false);
          break;
        }

        case "presence_sync":
        case "presence_update":
          setParticipants(data.participants);
          // Update current participant info for author attribution
          setCurrentParticipantId((currentId) => {
            if (currentId) {
              const currentParticipant = data.participants.find(
                (p) => p.participantId === currentId
              );
              if (currentParticipant) {
                currentParticipantRef.current = {
                  participantId: currentParticipant.participantId,
                  name: currentParticipant.name,
                  avatar: currentParticipant.avatar,
                };
              }
            }
            return currentId;
          });
          break;

        case "presence_leave":
          setParticipants((prev) => prev.filter((p) => p.userId !== data.userId));
          break;

        case "sandbox_warming":
          setSessionState((prev) => (prev ? { ...prev, sandboxStatus: "warming" } : null));
          break;

        case "sandbox_spawning":
          setSessionState((prev) => (prev ? { ...prev, sandboxStatus: "spawning" } : null));
          break;

        case "sandbox_status":
          setSessionState((prev) => (prev ? { ...prev, sandboxStatus: data.status } : null));
          break;

        case "sandbox_ready":
          setSessionState((prev) => (prev ? { ...prev, sandboxStatus: "ready" } : null));
          break;

        case "artifact_created":
          setArtifacts((prev) => {
            // Avoid duplicates
            const existing = prev.find((a) => a.id === data.artifact.id);
            if (existing) {
              return prev.map((a) => (a.id === data.artifact.id ? toUiArtifact(data.artifact) : a));
            }
            return [...prev, toUiArtifact(data.artifact)];
          });
          break;

        case "artifact_updated":
          setArtifacts((prev) => prev.map((a) => (a.id === data.artifact.id ? data.artifact : a)));
          break;

        case "session_status":
          setSessionState((prev) => (prev ? { ...prev, status: data.status } : null));
          // Revalidate session list so status change is reflected in sidebar
          mutate("/api/sessions");
          break;

        case "child_session_update":
          // Child session spawned or changed status — revalidate child list and sidebar
          mutate(`/api/sessions/${sessionId}/children`);
          mutate("/api/sessions");
          break;

        case "processing_status":
          setSessionState((prev) => (prev ? { ...prev, isProcessing: data.isProcessing } : null));
          break;

        case "sandbox_error":
          console.error("Sandbox error:", data.error);
          setSessionState((prev) => (prev ? { ...prev, sandboxStatus: "failed" } : null));
          break;

        case "pong":
          // Health check response
          break;

        case "error":
          console.error("Session error:", data);
          // Reset loading state if a fetch_history request was rejected
          setLoadingHistory(false);
          break;
      }
    },
    [processSandboxEvent, sessionId]
  );

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
    // Use ref to avoid race conditions with React StrictMode
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log("WebSocket already open");
      return;
    }
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
      console.log("WebSocket already connecting");
      return;
    }
    if (connectingRef.current) {
      console.log("Connection in progress (ref)");
      return;
    }

    connectingRef.current = true;
    setConnecting(true);
    setAuthError(null);

    // Fetch a WebSocket auth token first
    if (!wsTokenRef.current) {
      const token = await fetchWsToken();
      if (!token) {
        connectingRef.current = false;
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
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      console.log("WebSocket connected!");
      connectingRef.current = false;
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
      try {
        const data = parseWsMessage(JSON.parse(event.data));
        if (!data) return;
        handleMessage(data);
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    ws.onclose = (event) => {
      console.log("WebSocket closed:", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      connectingRef.current = false;
      subscribedRef.current = false;
      setConnected(false);
      setConnecting(false);
      setReplaying(false);
      wsRef.current = null;

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
        if (reconnectAttempts.current < 5) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
          reconnectAttempts.current++;
          console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);

          reconnectTimeoutRef.current = setTimeout(() => {
            if (mountedRef.current) {
              connect();
            }
          }, delay);
        } else {
          // Exhausted reconnection attempts
          console.error("WebSocket reconnection failed after 5 attempts");
          setConnectionError("Connection lost. Please check your network and try reconnecting.");
        }
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error event:", error);
    };
  }, [sessionId, handleMessage, fetchWsToken]);

  const sendPrompt = useCallback((content: string, model?: string, reasoningEffort?: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error("WebSocket not connected");
      return;
    }

    if (!subscribedRef.current) {
      console.error("Not subscribed yet, waiting...");
      // Retry after a short delay
      setTimeout(() => sendPrompt(content, model, reasoningEffort), 500);
      return;
    }

    console.log("Sending prompt", {
      contentLength: content.length,
      model,
      reasoningEffort,
    });

    // Optimistically set isProcessing for immediate feedback
    // Server will confirm with processing_status message
    setSessionState((prev) => (prev ? { ...prev, isProcessing: true } : null));

    // Note: user_message event is NOT inserted optimistically here.
    // The server writes a user_message event to the events table and broadcasts it
    // to all clients (including the sender), which handles both display and multiplayer.

    wsRef.current.send(
      JSON.stringify({
        type: "prompt",
        content,
        model, // Include model for per-message model switching
        reasoningEffort,
      })
    );
  }, []);

  const stopExecution = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    // Preserve partial content when stopping
    if (pendingTextRef.current) {
      const pending = pendingTextRef.current;
      pendingTextRef.current = null;
      setEvents((prev) => [
        ...prev,
        {
          type: "token",
          content: pending.content,
          messageId: pending.messageId,
          timestamp: pending.timestamp,
        },
      ]);
    }
    wsRef.current.send(JSON.stringify({ type: "stop" }));
  }, []);

  const sendTyping = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(JSON.stringify({ type: "typing" }));
  }, []);

  const loadOlderEvents = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!hasMoreHistory || loadingHistory || !cursorRef.current) return;
    setLoadingHistory(true);
    wsRef.current.send(
      JSON.stringify({
        type: "fetch_history",
        cursor: cursorRef.current,
        limit: 200,
      })
    );
  }, [hasMoreHistory, loadingHistory]);

  const reconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    connectingRef.current = false;
    reconnectAttempts.current = 0;
    wsTokenRef.current = null; // Clear token to fetch fresh one
    setAuthError(null);
    setConnectionError(null);
    connect();
  }, [connect]);

  // Connect on mount
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      connectingRef.current = false;
    };
  }, [connect]);

  // Ping every 30 seconds to keep connection alive
  useEffect(() => {
    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000);

    return () => clearInterval(pingInterval);
  }, []);

  const isProcessing = sessionState?.isProcessing ?? false;

  return {
    connected,
    connecting,
    replaying,
    authError,
    connectionError,
    sessionState,
    messages,
    events,
    participants,
    artifacts,
    currentParticipantId,
    isProcessing,
    hasMoreHistory,
    loadingHistory,
    sendPrompt,
    stopExecution,
    sendTyping,
    reconnect,
    loadOlderEvents,
  };
}
