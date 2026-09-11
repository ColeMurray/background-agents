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
  readProviderAuthorizationCodeStatus,
  startProviderAuthorizationCode,
} from "@/hooks/use-provider-accounts";

type ConnectedAuthorization = Extract<
  ProviderAuthorizationCodeStatusResponse,
  { status: "connected" }
>;
type SettledStatus = Exclude<ProviderAuthorizationCodeStatusResponse["status"], "pending">;

/**
 * starting → awaiting_code → completing → connected | denied | failed |
 * expired | cancelled | superseded. A code the transaction did not accept
 * returns to awaiting_code so the user can paste again; every settled state
 * needs a fresh transaction (`retry`). Settled states are the control
 * plane's own vocabulary, so the dialog can tell a provider rejection
 * (`denied`) from a lost transaction (`failed`).
 */
export type ProviderAuthorizationCodeStatus =
  | "starting"
  | "awaiting_code"
  | "completing"
  | SettledStatus;

export type ProviderAuthorizationCodeFailure = {
  message: string;
  retryable: boolean;
  status?: number;
};

const COUNTDOWN_TICK_INTERVAL_MS = 1_000;
/** The transaction itself is gone for this user: never existed, or settled and cleaned up. */
const TRANSACTION_GONE_STATUSES = new Set([404, 410]);
/**
 * A completion whose outcome the browser did not learn (another request owns
 * the claim, the response was lost, or the deadline aborted it) is settled by
 * reading the durable status. The window must outlast the control plane's
 * provider exchange and finalization, so a healthy exchange reports its
 * result before the hook stops waiting for it.
 */
const COMPLETION_RECONCILE_WINDOW_MS = 45_000;
const COMPLETION_RECONCILE_INTERVAL_MS = 2_000;
const RECONCILE_PENDING_MESSAGE = "The provider has not confirmed the code yet. Paste it again.";

/**
 * One transaction's lifecycle. `phase` is the only mutable model: every
 * async branch reads it before acting, so a settled or torn-down flow
 * ignores late results, and only one completion or reconciliation can own
 * the transaction at a time.
 */
type Phase =
  | { kind: "starting" }
  | { kind: "awaiting_code" }
  | { kind: "completing"; controller: AbortController }
  | { kind: "reconciling"; controller: AbortController }
  | { kind: "settled" };

type Flow = {
  active: boolean;
  phase: Phase;
  transactionId: string | null;
  deadlineAt: number | null;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  cancellationRequested: boolean;
  complete: (code: string) => Promise<void>;
  cancel: () => void;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
      phase: { kind: "starting" },
      transactionId: null,
      deadlineAt: null,
      cancellationRequested: false,
      complete: async () => undefined,
      cancel: () => undefined,
    };
    flowRef.current = flow;

    setAuthorization(null);
    setFailure(null);
    setStatus("starting");
    setLocalDeadline(null);
    setRemainingMs(null);

    const deadlinePassed = () => flow.deadlineAt !== null && performance.now() >= flow.deadlineAt;

    const abortInFlight = () => {
      if (flow.phase.kind === "completing" || flow.phase.kind === "reconciling") {
        flow.phase.controller.abort();
      }
    };

    const settle = (
      nextStatus: SettledStatus,
      nextFailure: ProviderAuthorizationCodeFailure | null
    ) => {
      abortInFlight();
      flow.phase = { kind: "settled" };
      clearTimeout(flow.deadlineTimer);
      setStatus(nextStatus);
      setFailure(nextFailure);
    };

    const settleFromResponse = (result: ProviderAuthorizationCodeStatusResponse) => {
      if (result.status === "pending") return false;
      if (result.status === "connected") {
        settle("connected", null);
        onConnectedRef.current(result);
        return true;
      }
      settle(result.status, { message: result.error, retryable: result.retryable });
      return true;
    };

    const expireNow = () => {
      settle("expired", { message: "Provider authorization expired.", retryable: true });
      setRemainingMs(0);
    };

    const awaitCode = (nextFailure: ProviderAuthorizationCodeFailure | null) => {
      if (deadlinePassed()) {
        expireNow();
        return;
      }
      flow.phase = { kind: "awaiting_code" };
      setStatus("awaiting_code");
      setFailure(nextFailure);
    };

    flow.cancel = () => {
      if (!flow.transactionId || flow.phase.kind === "settled" || flow.cancellationRequested) {
        return;
      }
      flow.cancellationRequested = true;
      void cancelProviderAuthorizationCode(initialProvider, flow.transactionId).catch(
        () => undefined
      );
    };

    // At the deadline an idle transaction expires locally. A completion still
    // in flight is aborted instead; its own handling then reconciles the
    // durable status, so a result the control plane already reached is kept.
    const expire = () => {
      if (!flow.active || flow.phase.kind === "settled") return;
      if (flow.phase.kind === "completing") {
        flow.phase.controller.abort();
        return;
      }
      if (flow.phase.kind === "reconciling") return;
      expireNow();
    };

    const reconcile = async () => {
      if (!flow.active || flow.phase.kind === "settled" || !flow.transactionId) return;
      const controller = new AbortController();
      flow.phase = { kind: "reconciling", controller };
      setStatus("completing");
      const startedAt = performance.now();
      while (
        flow.active &&
        flow.phase.kind === "reconciling" &&
        flow.phase.controller === controller
      ) {
        try {
          const result = await readProviderAuthorizationCodeStatus(
            initialProvider,
            flow.transactionId,
            controller.signal
          );
          if (!flow.active || flow.phase.kind !== "reconciling") return;
          if (settleFromResponse(result)) return;
        } catch (error) {
          if (!flow.active || flow.phase.kind !== "reconciling" || isAbortError(error)) return;
          const nextFailure = authorizationFailure(error);
          if (
            nextFailure.status !== undefined &&
            TRANSACTION_GONE_STATUSES.has(nextFailure.status)
          ) {
            settle("failed", { ...nextFailure, retryable: true });
            return;
          }
        }
        if (performance.now() - startedAt >= COMPLETION_RECONCILE_WINDOW_MS) break;
        await abortableDelay(COMPLETION_RECONCILE_INTERVAL_MS, controller.signal);
      }
      if (
        !flow.active ||
        flow.phase.kind !== "reconciling" ||
        flow.phase.controller !== controller
      ) {
        return;
      }
      // Still pending after the window: nothing consumed the code, so the
      // user may paste it again while the transaction is alive.
      awaitCode({ message: RECONCILE_PENDING_MESSAGE, retryable: false });
    };

    flow.complete = async (code: string) => {
      if (!flow.active || flow.phase.kind !== "awaiting_code" || !flow.transactionId) return;
      const trimmed = code.trim();
      if (!trimmed) {
        setFailure({ message: "Enter the authorization code first.", retryable: false });
        return;
      }

      const controller = new AbortController();
      flow.phase = { kind: "completing", controller };
      setFailure(null);
      setStatus("completing");
      try {
        const result = await completeProviderAuthorizationCode(
          initialProvider,
          flow.transactionId,
          trimmed,
          controller.signal
        );
        if (!flow.active || flow.phase.kind !== "completing") return;
        if (!settleFromResponse(result)) {
          awaitCode({
            message: "The code was not accepted yet. Paste it again.",
            retryable: false,
          });
        }
      } catch (error) {
        if (!flow.active || flow.phase.kind !== "completing") return;
        const nextFailure = authorizationFailure(error);
        // The outcome is unknown: the deadline aborted the request, another
        // request owns the completion claim (409), or the transport failed.
        // The durable status says what actually happened.
        if (isAbortError(error) || nextFailure.status === 409 || nextFailure.status === undefined) {
          await reconcile();
          return;
        }
        if (TRANSACTION_GONE_STATUSES.has(nextFailure.status)) {
          settle("failed", { ...nextFailure, retryable: true });
          return;
        }
        // The transaction is still live and the code was not consumed.
        awaitCode(nextFailure);
      }
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
          settle("failed", {
            message: "Authorization target changed unexpectedly",
            retryable: true,
          });
          flow.cancel();
          return;
        }
        setAuthorization(result);
        flow.phase = { kind: "awaiting_code" };
        setStatus("awaiting_code");
        flow.deadlineAt = performance.now() + result.expiresInMs;
        flow.deadlineTimer = setTimeout(expire, result.expiresInMs);
        setLocalDeadline(flow.deadlineAt);
        setRemainingMs(result.expiresInMs);
      } catch (error) {
        if (!flow.active) return;
        settle("failed", authorizationFailure(error));
      }
    };

    void start();
    return () => {
      flow.active = false;
      clearTimeout(flow.deadlineTimer);
      abortInFlight();
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
    (code: string) => flowRef.current?.complete(code) ?? Promise.resolve(),
    []
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
