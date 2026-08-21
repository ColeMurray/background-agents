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

    const schedulePoll = (pollIntervalMs: number) => {
      pollTimer = setTimeout(() => void poll(), pollIntervalMs);
    };

    const poll = async () => {
      if (!active || !transactionId) return;
      try {
        const result = await pollProviderDeviceAuthorization(initialProvider, transactionId);
        if (!active) return;
        if (result.status === "pending") {
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
        if (result.status === "connected") {
          onConnectedRef.current(result);
        } else {
          setFailure({ message: result.error, retryable: result.retryable });
        }
      } catch (error) {
        if (!active) return;
        setStatus("failed");
        setFailure(authorizationFailure(error));
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
        const deadline = performance.now() + result.expiresInMs;
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
      cancel();
      if (cancelCurrentRef.current === cancel) cancelCurrentRef.current = () => undefined;
    };
  }, [attempt, initialProvider, initialTarget]);

  useEffect(() => {
    if (localDeadline === null || status !== "pending") return;
    const updateRemaining = () => setRemainingMs(Math.max(0, localDeadline - performance.now()));
    updateRemaining();
    const timer = setInterval(updateRemaining, 1_000);
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
