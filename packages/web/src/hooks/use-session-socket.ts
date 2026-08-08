"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { mutate } from "swr";
import { useSessionTransport } from "@/hooks/use-session-transport";
import { useSessionAccess } from "@/hooks/use-session-access";
import {
  ingestLiveSandboxEvent,
  pendingToTokenEvent,
  toUiSandboxEvent,
  type PendingAssistantText,
} from "@/lib/session-socket/event-log";
import {
  createSessionSocketState,
  initialSessionSocketState,
  sessionSocketReducer,
} from "@/lib/session-socket/reducer";
import { swrKeysToRevalidate } from "@/lib/session-socket/swr-revalidation";
import type { Artifact, SandboxEvent } from "@/types/session";
import type { ParticipantPresence, SessionState } from "@open-inspect/shared";
import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import type { ServerMessage, SessionBootstrap } from "@open-inspect/shared/types/server-messages";

const PROMPT_SUBSCRIPTION_TIMEOUT_MS = 5_000;
const PROMPT_ACK_TIMEOUT_MS = 15_000;
const HISTORY_PAGE_SIZE = 200;
const MAX_PROTOCOL_RECOVERY_ATTEMPTS = 3;
const PROTOCOL_RECOVERY_BASE_DELAY_MS = 250;

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
  ready: boolean;
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
    attachments?: SessionAttachmentReference[]
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
export function useSessionSocket(
  sessionId: string,
  initialBootstrap?: SessionBootstrap
): UseSessionSocketReturn {
  const [state, dispatch] = useReducer(sessionSocketReducer, initialBootstrap, (bootstrap) =>
    bootstrap ? createSessionSocketState(bootstrap) : initialSessionSocketState
  );
  const subscribedRef = useRef(false);
  const revisionRef = useRef(initialBootstrap?.viewRevision ?? null);
  const handledRecoveryNonceRef = useRef(0);
  const protocolRecoveryAttemptsRef = useRef(0);
  const protocolRecoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [protocolRecoveryError, setProtocolRecoveryError] = useState<string | null>(null);
  // Buffers streamed assistant text in a ref so token events (which arrive at
  // high frequency) don't re-render; the text is appended on completion.
  const pendingTextRef = useRef<PendingAssistantText | null>(null);
  const subscriptionWaitersRef = useRef(new Set<(subscribed: boolean) => void>());
  const pendingPromptRef = useRef<{
    resolve: (accepted: boolean) => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null>(null);
  const { access, clear: clearAccess, refetch: refetchAccess } = useSessionAccess(sessionId);

  useEffect(() => {
    revisionRef.current = state.lastAppliedRevision;
  }, [state.lastAppliedRevision]);

  useEffect(() => {
    if (access !== undefined) {
      dispatch({ type: "access_loaded", access });
    }
  }, [access]);

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

  useEffect(() => {
    subscribedRef.current = state.ready;
    if (state.ready) settleSubscriptionWaiters(true);
  }, [state.ready, settleSubscriptionWaiters]);

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
        pendingTextRef.current = null;
        if (message.spawnError && message.state.sandboxStatus === "failed") {
          console.error("Sandbox spawn error:", message.spawnError);
        }
      } else if (message.type === "session_ready") {
        revisionRef.current = message.appliedRevision;
        void refetchAccess();
      } else if (message.type === "session_sync_started") {
        subscribedRef.current = false;
      } else if (message.type === "session_delta") {
        if (revisionRef.current !== null && message.revision === revisionRef.current + 1) {
          revisionRef.current = message.revision;
        }
      } else if (message.type === "session_snapshot") {
        revisionRef.current = message.bootstrap.viewRevision;
      } else if (message.type === "session_access_changed") {
        dispatch({ type: "access_loaded", access: null });
        void clearAccess().then(() => refetchAccess());
      } else if (message.type === "sandbox_error") {
        console.error("Sandbox error:", message.error);
      } else if (message.type === "error") {
        console.error("Session error:", message);
        settlePendingPrompt(false);
      } else if (message.type === "prompt_queued") {
        settlePendingPrompt(true);
      }

      const clearsAccess =
        message.type === "sandbox_spawning" ||
        message.type === "sandbox_error" ||
        (message.type === "sandbox_status" &&
          ["spawning", "stale", "stopped", "failed"].includes(message.status)) ||
        (message.type === "session_delta" &&
          message.delta.operations.some(
            (operation) =>
              operation.type === "state_patch" &&
              operation.patch.sandboxStatus !== undefined &&
              ["spawning", "stale", "stopped", "failed"].includes(operation.patch.sandboxStatus)
          ));
      if (clearsAccess) void clearAccess();

      dispatch({ type: "server_message", message });
      for (const key of swrKeysToRevalidate(message, sessionId)) {
        mutate(key);
      }
    },
    [clearAccess, refetchAccess, sessionId, settlePendingPrompt]
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
    getResumeRevision: () => revisionRef.current,
    onProtocolError: () => dispatch({ type: "protocol_error" }),
  });
  const { isOpen, send, reconnect, markHealthy } = transport;

  useEffect(() => {
    if (!state.ready) return;
    protocolRecoveryAttemptsRef.current = 0;
    setProtocolRecoveryError(null);
    markHealthy();
  }, [markHealthy, state.ready]);

  useEffect(() => {
    if (state.recoveryNonce === handledRecoveryNonceRef.current) return;
    handledRecoveryNonceRef.current = state.recoveryNonce;
    subscribedRef.current = false;
    settleSubscriptionWaiters(false);
    settlePendingPrompt(false);
    if (protocolRecoveryAttemptsRef.current >= MAX_PROTOCOL_RECOVERY_ATTEMPTS) {
      setProtocolRecoveryError("Session synchronization failed. Please reconnect.");
      return;
    }
    const delayMs =
      PROTOCOL_RECOVERY_BASE_DELAY_MS * Math.pow(2, protocolRecoveryAttemptsRef.current);
    protocolRecoveryAttemptsRef.current += 1;
    protocolRecoveryTimeoutRef.current = setTimeout(() => {
      protocolRecoveryTimeoutRef.current = null;
      reconnect(true);
    }, delayMs);
  }, [state.recoveryNonce, reconnect, settlePendingPrompt, settleSubscriptionWaiters]);

  const reconnectManually = useCallback(() => {
    if (protocolRecoveryTimeoutRef.current) {
      clearTimeout(protocolRecoveryTimeoutRef.current);
      protocolRecoveryTimeoutRef.current = null;
    }
    protocolRecoveryAttemptsRef.current = 0;
    setProtocolRecoveryError(null);
    reconnect(false);
  }, [reconnect]);

  useEffect(
    () => () => {
      if (protocolRecoveryTimeoutRef.current) {
        clearTimeout(protocolRecoveryTimeoutRef.current);
      }
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
      attachments?: SessionAttachmentReference[]
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
    if (!isOpen() || !subscribedRef.current) {
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
    if (!isOpen() || !subscribedRef.current) {
      return;
    }
    send({ type: "typing" });
  }, [isOpen, send]);

  const { hasMoreHistory, loadingHistory, cursor } = state;
  const loadOlderEvents = useCallback(() => {
    if (!isOpen() || !subscribedRef.current) return;
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
    ready: state.ready,
    replaying: state.replaying,
    authError: transport.authError,
    connectionError: protocolRecoveryError ?? transport.connectionError,
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
    reconnect: reconnectManually,
    loadOlderEvents,
  };
}
