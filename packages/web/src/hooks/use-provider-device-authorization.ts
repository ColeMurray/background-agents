"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ProviderDeviceAuthorizationStatusResponse,
  StartProviderDeviceAuthorizationRequest,
  StartProviderDeviceAuthorizationResponse,
  SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import {
  cancelProviderDeviceAuthorization,
  pollProviderDeviceAuthorization,
  startProviderDeviceAuthorization,
} from "@/hooks/use-provider-accounts";

type ConnectedAuthorization = Extract<
  ProviderDeviceAuthorizationStatusResponse,
  { status: "connected" }
>;

type AuthorizationStatus = "starting" | ProviderDeviceAuthorizationStatusResponse["status"];

type AuthorizationFailure = {
  message: string;
  retryable: boolean;
  status?: number;
};

const COUNTDOWN_TICK_INTERVAL_MS = 1_000;

function authorizationFailure(error: unknown): AuthorizationFailure {
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    const retryable =
      "retryable" in error && typeof error.retryable === "boolean"
        ? error.retryable
        : error.status >= 500;
    return { message: error.message, status: error.status, retryable };
  }
  return {
    message: error instanceof Error ? error.message : "Device authorization request failed",
    retryable: true,
  };
}

export function useProviderDeviceAuthorization(
  provider: SubscriptionProviderId,
  target: StartProviderDeviceAuthorizationRequest,
  onConnected: (result: ConnectedAuthorization) => void
) {
  // Provider and target are frozen for one flow; remount with a new key to change either.
  const [{ initialProvider, initialTarget }] = useState(() => ({
    initialProvider: provider,
    initialTarget: target,
  }));
  const [authorization, setAuthorization] =
    useState<StartProviderDeviceAuthorizationResponse | null>(null);
  const [failure, setFailure] = useState<AuthorizationFailure | null>(null);
  const [status, setStatus] = useState<AuthorizationStatus>("starting");
  const [attempt, setAttempt] = useState(0);
  const [localDeadline, setLocalDeadline] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const cancelCurrentRef = useRef<() => void>(() => undefined);
  const onConnectedRef = useRef(onConnected);

  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  useEffect(() => {
    let active = true;
    let finished = false;
    let cancellationRequested = false;
    let transactionId: string | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let pollAbortController: AbortController | undefined;
    let pollIntervalMs: number | null = null;
    let deadline: number | null = null;

    setAuthorization(null);
    setFailure(null);
    setStatus("starting");
    setLocalDeadline(null);
    setRemainingMs(null);

    const cancel = () => {
      if (!transactionId || finished || cancellationRequested) return;
      cancellationRequested = true;
      void cancelProviderDeviceAuthorization(initialProvider, transactionId).catch(() => undefined);
    };
    cancelCurrentRef.current = cancel;

    const expire = () => {
      if (!active || finished) return;
      finished = true;
      clearTimeout(pollTimer);
      pollAbortController?.abort();
      setRemainingMs(0);
      setStatus("expired");
      setFailure({ message: "Provider authorization expired.", retryable: true });
    };

    const schedulePoll = (pollIntervalMs: number) => {
      const remaining = deadline === null ? 0 : deadline - performance.now();
      if (remaining <= 0) {
        expire();
        return;
      }
      pollTimer = setTimeout(() => void poll(), Math.min(pollIntervalMs, remaining));
    };

    const poll = async () => {
      if (!active || finished || !transactionId) return;
      const controller = new AbortController();
      pollAbortController = controller;
      try {
        const result = await pollProviderDeviceAuthorization(
          initialProvider,
          transactionId,
          controller.signal
        );
        if (!active || finished) return;
        if (result.status === "pending") {
          pollIntervalMs = result.pollIntervalMs;
          setAuthorization((current) =>
            current
              ? {
                  ...current,
                  pollIntervalMs: result.pollIntervalMs,
                }
              : current
          );
          schedulePoll(result.pollIntervalMs);
          return;
        }

        setStatus(result.status);
        finished = true;
        clearTimeout(deadlineTimer);
        if (result.status === "connected") {
          onConnectedRef.current(result);
        } else {
          setFailure({ message: result.error, retryable: result.retryable });
        }
      } catch (error) {
        if (!active || finished) return;
        const nextFailure = authorizationFailure(error);
        const remaining = deadline === null ? 0 : deadline - performance.now();
        if (nextFailure.retryable && pollIntervalMs !== null && remaining > 0) {
          schedulePoll(Math.min(pollIntervalMs, remaining));
          return;
        }
        finished = true;
        clearTimeout(deadlineTimer);
        setStatus("failed");
        setFailure(nextFailure);
      } finally {
        if (pollAbortController === controller) pollAbortController = undefined;
      }
    };

    const start = async () => {
      try {
        const result = await startProviderDeviceAuthorization(initialProvider, initialTarget);
        transactionId = result.transactionId;
        if (!active) {
          cancel();
          return;
        }
        if (result.provider !== initialProvider || result.operation !== initialTarget.operation) {
          setStatus("failed");
          setFailure({
            message: "Device authorization target changed unexpectedly",
            retryable: true,
          });
          cancel();
          return;
        }
        setAuthorization(result);
        setStatus("pending");
        pollIntervalMs = result.pollIntervalMs;
        deadline = performance.now() + result.expiresInMs;
        deadlineTimer = setTimeout(expire, result.expiresInMs);
        setLocalDeadline(deadline);
        setRemainingMs(result.expiresInMs);
        schedulePoll(result.pollIntervalMs);
      } catch (error) {
        if (!active) return;
        setStatus("failed");
        setFailure(authorizationFailure(error));
      }
    };

    void start();
    return () => {
      active = false;
      clearTimeout(pollTimer);
      clearTimeout(deadlineTimer);
      pollAbortController?.abort();
      cancel();
      if (cancelCurrentRef.current === cancel) cancelCurrentRef.current = () => undefined;
    };
  }, [attempt, initialProvider, initialTarget]);

  useEffect(() => {
    if (localDeadline === null || status !== "pending") return;
    const updateRemaining = () => setRemainingMs(Math.max(0, localDeadline - performance.now()));
    updateRemaining();
    const timer = setInterval(updateRemaining, COUNTDOWN_TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [localDeadline, status]);

  return {
    authorization,
    failure,
    status,
    remainingMs,
    retry: () => setAttempt((value) => value + 1),
    cancel: () => cancelCurrentRef.current(),
  };
}
