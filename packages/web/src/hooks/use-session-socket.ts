"use client";

import { useCallback, useReducer, useRef } from "react";
import { mutate } from "swr";
import { useSessionTransport } from "@/hooks/use-session-transport";
import {
  ingestLiveSandboxEvent,
  pendingToTokenEvent,
  toUiSandboxEvent,
  type PendingAssistantText,
} from "@/lib/session-socket/event-log";
import { initialSessionSocketState, sessionSocketReducer } from "@/lib/session-socket/reducer";
import { swrKeysToRevalidate } from "@/lib/session-socket/swr-revalidation";
import type { Artifact, SandboxEvent } from "@/types/session";
import type {
  PromptAttachment,
  ParticipantPresence,
  ServerMessage,
  SessionState,
} from "@open-inspect/shared";

const PROMPT_SUBSCRIPTION_RETRY_DELAY_MS = 500;
const HISTORY_PAGE_SIZE = 200;

interface Message {
  id: string;
  authorId: string;
  content: string;
  source: string;
  status: string;
  createdAt: number;
}

// Message history is delivered through replayed events; kept for API shape.
const NO_MESSAGES: Message[] = [];

interface UseSessionSocketReturn {
  connected: boolean;
  connecting: boolean;
  replaying: boolean;
  authError: string | null;
  connectionError: string | null;
  sessionState: SessionState | null;
  messages: Message[];
  events: SandboxEvent[];
  participants: ParticipantPresence[];
  artifacts: Artifact[];
  currentParticipantId: string | null;
  isProcessing: boolean;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  sendPrompt: (
    content: string,
    model?: string,
    reasoningEffort?: string,
    attachments?: PromptAttachment[]
  ) => void;
  stopExecution: () => void;
  sendTyping: () => void;
  reconnect: () => void;
  loadOlderEvents: () => void;
}

/**
 * Session view over a WebSocket connection, composed from four layers:
 *
 * - transport (connect/auth/reconnect/ping): `useSessionTransport`
 * - event-log construction and token buffering: `lib/session-socket/event-log`
 * - view-state projection: `lib/session-socket/reducer`
 * - SWR revalidation: `lib/session-socket/swr-revalidation` (applied below,
 *   the only place this hook touches the cache)
 */
export function useSessionSocket(sessionId: string): UseSessionSocketReturn {
  const [state, dispatch] = useReducer(sessionSocketReducer, initialSessionSocketState);
  const subscribedRef = useRef(false);
  // Buffers streamed assistant text in a ref so token events (which arrive at
  // high frequency) don't re-render; the text is appended on completion.
  const pendingTextRef = useRef<PendingAssistantText | null>(null);

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      if (message.type === "sandbox_event") {
        const { pending, append } = ingestLiveSandboxEvent(
          pendingTextRef.current,
          toUiSandboxEvent(message.event)
        );
        pendingTextRef.current = pending;
        if (append.length > 0) {
          dispatch({ type: "events_appended", events: append });
        }
        return;
      }

      if (message.type === "subscribed") {
        console.log("WebSocket subscribed to session");
        subscribedRef.current = true;
        pendingTextRef.current = null;
        if (message.spawnError && message.state.sandboxStatus === "failed") {
          console.error("Sandbox spawn error:", message.spawnError);
        }
      } else if (message.type === "sandbox_error") {
        console.error("Sandbox error:", message.error);
      } else if (message.type === "error") {
        console.error("Session error:", message);
      }

      dispatch({ type: "server_message", message });
      for (const key of swrKeysToRevalidate(message, sessionId)) {
        mutate(key);
      }
    },
    [sessionId]
  );

  const handleClose = useCallback(() => {
    subscribedRef.current = false;
    dispatch({ type: "socket_closed" });
  }, []);

  const transport = useSessionTransport(sessionId, {
    onMessage: handleMessage,
    onClose: handleClose,
  });
  const { isOpen, send } = transport;

  const sendPrompt = useCallback(
    (
      content: string,
      model?: string,
      reasoningEffort?: string,
      attachments?: PromptAttachment[]
    ) => {
      if (!isOpen()) {
        console.error("WebSocket not connected");
        return;
      }

      if (!subscribedRef.current) {
        console.error("Not subscribed yet, waiting...");
        // Retry after a short delay
        setTimeout(
          () => sendPrompt(content, model, reasoningEffort, attachments),
          PROMPT_SUBSCRIPTION_RETRY_DELAY_MS
        );
        return;
      }

      console.log("Sending prompt", {
        contentLength: content.length,
        model,
        reasoningEffort,
        attachmentsCount: attachments?.length ?? 0,
      });

      // Optimistically set isProcessing for immediate feedback
      // Server will confirm with processing_status message
      dispatch({ type: "prompt_sent" });

      // Note: user_message event is NOT inserted optimistically here.
      // The server writes a user_message event to the events table and broadcasts it
      // to all clients (including the sender), which handles both display and multiplayer.

      send({
        type: "prompt",
        content,
        model, // Include model for per-message model switching
        reasoningEffort,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
    },
    [isOpen, send]
  );

  const stopExecution = useCallback(() => {
    if (!isOpen()) {
      return;
    }
    // Preserve partial content when stopping
    const pending = pendingTextRef.current;
    pendingTextRef.current = null;
    if (pending) {
      dispatch({ type: "events_appended", events: [pendingToTokenEvent(pending)] });
    }
    send({ type: "stop" });
  }, [isOpen, send]);

  const sendTyping = useCallback(() => {
    if (!isOpen()) {
      return;
    }
    send({ type: "typing" });
  }, [isOpen, send]);

  const { hasMoreHistory, loadingHistory, cursor } = state;
  const loadOlderEvents = useCallback(() => {
    if (!isOpen()) return;
    if (!hasMoreHistory || loadingHistory || !cursor) return;
    dispatch({ type: "history_requested" });
    send({
      type: "fetch_history",
      cursor,
      limit: HISTORY_PAGE_SIZE,
    });
  }, [isOpen, send, hasMoreHistory, loadingHistory, cursor]);

  const isProcessing = state.sessionState?.isProcessing ?? false;

  return {
    connected: transport.connected,
    connecting: transport.connecting,
    replaying: state.replaying,
    authError: transport.authError,
    connectionError: transport.connectionError,
    sessionState: state.sessionState,
    messages: NO_MESSAGES,
    events: state.events,
    participants: state.participants,
    artifacts: state.artifacts,
    currentParticipantId: state.currentParticipantId,
    isProcessing,
    hasMoreHistory,
    loadingHistory,
    sendPrompt,
    stopExecution,
    sendTyping,
    reconnect: transport.reconnect,
    loadOlderEvents,
  };
}
