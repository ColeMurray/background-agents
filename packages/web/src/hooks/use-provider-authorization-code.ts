"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProviderAuthorizationCodeStatusResponse,
  StartProviderAuthorizationCodeRequest,
  StartProviderAuthorizationCodeResponse,
  SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import {
  cancelProviderAuthorizationCode,
  completeProviderAuthorizationCode,
  startProviderAuthorizationCode,
} from "@/hooks/use-provider-accounts";

type ConnectedAuthorization = Extract<
  ProviderAuthorizationCodeStatusResponse,
  { status: "connected" }
>;

/**
 * starting → awaiting_code → completing → connected | failed | expired.
 * A rejected code returns to awaiting_code so the user can paste again;
 * failed/expired need a fresh transaction (`retry`).
 */
export type ProviderAuthorizationCodeStatus =
  | "starting"
  | "awaiting_code"
  | "completing"
  | "connected"
  | "expired"
  | "failed";

export type ProviderAuthorizationCodeFailure = {
  message: string;
  retryable: boolean;
  status?: number;
};

const COUNTDOWN_TICK_INTERVAL_MS = 1_000;
/** The transaction itself is unusable (consumed, superseded, or gone), not the pasted code. */
const TRANSACTION_GONE_STATUSES = new Set([404, 409, 410]);

type Flow = {
  active: boolean;
  finished: boolean;
  completing: boolean;
  expiredWhileCompleting: boolean;
  cancellationRequested: boolean;
  transactionId: string | null;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  cancel: () => void;
  expire: () => void;
};

function authorizationFailure(error: unknown): ProviderAuthorizationCodeFailure {
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    const retryable =
      "retryable" in error && typeof error.retryable === "boolean"
        ? error.retryable
        : error.status >= 500;
    return { message: error.message, status: error.status, retryable };
  }
  return {
    message: error instanceof Error ? error.message : "Authorization request failed",
    retryable: true,
  };
}

export function useProviderAuthorizationCode(
  provider: SubscriptionProviderId,
  target: StartProviderAuthorizationCodeRequest,
  onConnected: (result: ConnectedAuthorization) => void
) {
  // Provider and target are frozen for one flow; remount with a new key to change either.
  const [{ initialProvider, initialTarget }] = useState(() => ({
    initialProvider: provider,
    initialTarget: target,
  }));
  const [authorization, setAuthorization] = useState<StartProviderAuthorizationCodeResponse | null>(
    null
  );
  const [failure, setFailure] = useState<ProviderAuthorizationCodeFailure | null>(null);
  const [status, setStatus] = useState<ProviderAuthorizationCodeStatus>("starting");
  const [attempt, setAttempt] = useState(0);
  const [localDeadline, setLocalDeadline] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const flowRef = useRef<Flow | null>(null);
  const onConnectedRef = useRef(onConnected);

  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  useEffect(() => {
    const flow: Flow = {
      active: true,
      finished: false,
      completing: false,
      expiredWhileCompleting: false,
      cancellationRequested: false,
      transactionId: null,
      cancel: () => undefined,
      expire: () => undefined,
    };
    flowRef.current = flow;

    setAuthorization(null);
    setFailure(null);
    setStatus("starting");
    setLocalDeadline(null);
    setRemainingMs(null);

    flow.cancel = () => {
      if (!flow.transactionId || flow.finished || flow.cancellationRequested) return;
      flow.cancellationRequested = true;
      void cancelProviderAuthorizationCode(initialProvider, flow.transactionId).catch(
        () => undefined
      );
    };

    flow.expire = () => {
      if (!flow.active || flow.finished) return;
      if (flow.completing) {
        flow.expiredWhileCompleting = true;
        return;
      }
      flow.finished = true;
      setRemainingMs(0);
      setStatus("expired");
      setFailure({ message: "Provider authorization expired.", retryable: true });
    };

    const start = async () => {
      try {
        const result = await startProviderAuthorizationCode(initialProvider, initialTarget);
        flow.transactionId = result.transactionId;
        if (!flow.active) {
          flow.cancel();
          return;
        }
        if (result.provider !== initialProvider || result.operation !== initialTarget.operation) {
          setStatus("failed");
          setFailure({ message: "Authorization target changed unexpectedly", retryable: true });
          flow.cancel();
          return;
        }
        setAuthorization(result);
        setStatus("awaiting_code");
        flow.deadlineTimer = setTimeout(flow.expire, result.expiresInMs);
        setLocalDeadline(performance.now() + result.expiresInMs);
        setRemainingMs(result.expiresInMs);
      } catch (error) {
        if (!flow.active) return;
        setStatus("failed");
        setFailure(authorizationFailure(error));
      }
    };

    void start();
    return () => {
      flow.active = false;
      clearTimeout(flow.deadlineTimer);
      flow.cancel();
      if (flowRef.current === flow) flowRef.current = null;
    };
  }, [attempt, initialProvider, initialTarget]);

  useEffect(() => {
    if (localDeadline === null || (status !== "awaiting_code" && status !== "completing")) return;
    const updateRemaining = () => setRemainingMs(Math.max(0, localDeadline - performance.now()));
    updateRemaining();
    const timer = setInterval(updateRemaining, COUNTDOWN_TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [localDeadline, status]);

  const complete = useCallback(
    async (code: string) => {
      const flow = flowRef.current;
      if (!flow || !flow.active || flow.finished || flow.completing || !flow.transactionId) return;
      const trimmed = code.trim();
      if (!trimmed) {
        setFailure({ message: "Enter the authorization code first.", retryable: false });
        return;
      }

      flow.completing = true;
      setFailure(null);
      setStatus("completing");
      try {
        const result = await completeProviderAuthorizationCode(
          initialProvider,
          flow.transactionId,
          trimmed
        );
        if (!flow.active) return;
        flow.completing = false;
        if (result.status === "pending") {
          if (flow.expiredWhileCompleting) {
            flow.expire();
            return;
          }
          setStatus("awaiting_code");
          setFailure({
            message: "The code was not accepted yet. Paste it again.",
            retryable: false,
          });
          return;
        }

        flow.finished = true;
        clearTimeout(flow.deadlineTimer);
        if (result.status === "connected") {
          setStatus("connected");
          onConnectedRef.current(result);
          return;
        }
        setStatus(result.status === "expired" ? "expired" : "failed");
        setFailure({ message: result.error, retryable: result.retryable });
      } catch (error) {
        if (!flow.active) return;
        flow.completing = false;
        if (flow.expiredWhileCompleting) {
          flow.expire();
          return;
        }
        const nextFailure = authorizationFailure(error);
        if (nextFailure.status !== undefined && TRANSACTION_GONE_STATUSES.has(nextFailure.status)) {
          flow.finished = true;
          clearTimeout(flow.deadlineTimer);
          setStatus("failed");
          setFailure({ ...nextFailure, retryable: true });
          return;
        }
        // The transaction is still live: the user can paste the code again.
        setStatus("awaiting_code");
        setFailure(nextFailure);
      }
    },
    [initialProvider]
  );

  return {
    authorization,
    failure,
    status,
    remainingMs,
    complete,
    retry: () => setAttempt((value) => value + 1),
    cancel: () => flowRef.current?.cancel(),
  };
}
