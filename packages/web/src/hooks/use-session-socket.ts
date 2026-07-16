"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
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

const PROMPT_SUBSCRIPTION_TIMEOUT_MS = 5_000;
const PROMPT_ACK_TIMEOUT_MS = 15_000;
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
  ) => Promise<boolean>;
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
  const subscriptionWaitersRef = useRef(new Set<(subscribed: boolean) => void>());
  const pendingPromptRef = useRef<{
    resolve: (accepted: boolean) => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null>(null);

  const settleSubscriptionWaiters = useCallback((subscribed: boolean) => {
    for (const resolve of subscriptionWaitersRef.current) {
      resolve(subscribed);
    }
    subscriptionWaitersRef.current.clear();
  }, []);

  const settlePendingPrompt = useCallback((accepted: boolean) => {
    const pending = pendingPromptRef.current;
    if (!pending) return;

    clearTimeout(pending.timeout);
    pendingPromptRef.current = null;
    pending.resolve(accepted);
  }, []);

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
        settleSubscriptionWaiters(true);
        pendingTextRef.current = null;
        if (message.spawnError && message.state.sandboxStatus === "failed") {
          console.error("Sandbox spawn error:", message.spawnError);
        }
      } else if (message.type === "sandbox_error") {
        console.error("Sandbox error:", message.error);
      } else if (message.type === "error") {
        console.error("Session error:", message);
        settlePendingPrompt(false);
      } else if (message.type === "prompt_queued") {
        settlePendingPrompt(true);
      }

      dispatch({ type: "server_message", message });
      for (const key of swrKeysToRevalidate(message, sessionId)) {
        mutate(key);
      }
    },
    [sessionId, settlePendingPrompt, settleSubscriptionWaiters]
  );

  const handleClose = useCallback(() => {
    subscribedRef.current = false;
    settleSubscriptionWaiters(false);
    settlePendingPrompt(false);
    dispatch({ type: "socket_closed" });
  }, [settlePendingPrompt, settleSubscriptionWaiters]);

  const transport = useSessionTransport(sessionId, {
    onMessage: handleMessage,
    onClose: handleClose,
  });
  const { isOpen, send } = transport;

  useEffect(
    () => () => {
      settleSubscriptionWaiters(false);
      settlePendingPrompt(false);
    },
    [settlePendingPrompt, settleSubscriptionWaiters]
  );

  const waitForSubscription = useCallback((): Promise<boolean> => {
    if (subscribedRef.current) return Promise.resolve(true);
    if (!isOpen()) return Promise.resolve(false);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (subscribed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        subscriptionWaitersRef.current.delete(finish);
        resolve(subscribed);
      };
      const timeout = setTimeout(() => finish(false), PROMPT_SUBSCRIPTION_TIMEOUT_MS);
      subscriptionWaitersRef.current.add(finish);
    });
  }, [isOpen]);

  const sendPrompt = useCallback(
    async (
      content: string,
      model?: string,
      reasoningEffort?: string,
      attachments?: PromptAttachment[]
    ): Promise<boolean> => {
      if (!isOpen()) {
        console.error("WebSocket not connected");
        return false;
      }

      if (pendingPromptRef.current) {
        console.error("A prompt is already waiting for acknowledgement");
        return false;
      }

      if (!(await waitForSubscription()) || !isOpen()) {
        console.error("WebSocket subscription unavailable");
        return false;
      }

      if (pendingPromptRef.current) {
        console.error("A prompt is already waiting for acknowledgement");
        return false;
      }

      console.log("Sending prompt", {
        contentLength: content.length,
        model,
        reasoningEffort,
        attachmentsCount: attachments?.length ?? 0,
      });

      // Note: user_message event is NOT inserted optimistically here.
      // The server writes a user_message event to the events table and broadcasts it
      // to all clients (including the sender), which handles both display and multiplayer.

      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          settlePendingPrompt(false);
        }, PROMPT_ACK_TIMEOUT_MS);
        pendingPromptRef.current = { resolve, timeout };

        send({
          type: "prompt",
          content,
          model, // Include model for per-message model switching
          reasoningEffort,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        });
      });
    },
    [isOpen, send, settlePendingPrompt, waitForSubscription]
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
