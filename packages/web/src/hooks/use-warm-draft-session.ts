"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createSessionResponseSchema } from "@open-inspect/shared/types/session-api";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import type { ModelProviderSelections } from "@open-inspect/shared/types/provider-accounts";
import type { SessionSkillSelection } from "@open-inspect/shared/types/skills";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import type { SessionTargetRequestFields } from "@/lib/session-target";
import { retireWarmDraftSession } from "@/lib/warm-session";
import type { InteractiveProviderRoutingIdentity } from "@/lib/provider-selection";

export type WarmDraftSessionRequest = SessionTargetRequestFields & {
  harness: HarnessId;
  model: string;
  reasoningEffort?: string;
  skillSelection: SessionSkillSelection;
  providerSelections: ModelProviderSelections;
  teamId: string | null;
  visibility: SessionVisibility;
};

interface WarmDraftSessionError {
  message: string;
  code: string | null;
  status: number;
  terminal: boolean;
}

export function warmDraftSessionIdentity(
  request: WarmDraftSessionRequest | null,
  routingIdentity?: InteractiveProviderRoutingIdentity
): string | null {
  if (!request) return null;
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)])
      );
    }
    return value;
  };
  return JSON.stringify(canonicalize({ request, routingIdentity }));
}

export function useWarmDraftSession(
  request: WarmDraftSessionRequest | null,
  routingIdentity?: InteractiveProviderRoutingIdentity
) {
  const identity = warmDraftSessionIdentity(request, routingIdentity);
  const requestRef = useRef(request);
  const identityRef = useRef(identity);
  const sessionIdRef = useRef<string | null>(null);
  const creationRef = useRef<Promise<string | null> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const errorRef = useRef<WarmDraftSessionError | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isWarming, setIsWarming] = useState(false);
  const [error, setError] = useState<WarmDraftSessionError | null>(null);

  useLayoutEffect(() => {
    requestRef.current = request;
    identityRef.current = identity;
  }, [identity, request]);

  useLayoutEffect(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    creationRef.current = null;
    setIsWarming(false);
    errorRef.current = null;
    setError(null);

    const supersededSessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    setSessionId(null);
    if (supersededSessionId) void retireWarmDraftSession(supersededSessionId);
  }, [identity]);

  useEffect(
    () => () => {
      identityRef.current = null;
      abortControllerRef.current?.abort();
      if (sessionIdRef.current) void retireWarmDraftSession(sessionIdRef.current);
    },
    []
  );

  const warm = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (creationRef.current) return creationRef.current;
    if (errorRef.current?.terminal) return null;

    const launchRequest = requestRef.current;
    const launchIdentity = identityRef.current;
    if (!launchRequest || !launchIdentity) return null;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setIsWarming(true);
    errorRef.current = null;
    setError(null);

    const creation = (async () => {
      try {
        const response = await browserApiFetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(launchRequest),
          signal: abortController.signal,
        });
        if (!response.ok) {
          const failure: unknown = await response.json().catch(() => null);
          if (identityRef.current !== launchIdentity || abortController.signal.aborted) return null;
          let message = "Failed to create session";
          let code: string | null = null;
          if (failure && typeof failure === "object") {
            if ("error" in failure && typeof failure.error === "string") message = failure.error;
            if ("code" in failure && typeof failure.code === "string") code = failure.code;
          }
          const creationError: WarmDraftSessionError = {
            message: code ? `${message} (${code})` : message,
            code,
            status: response.status,
            terminal: [400, 403, 404, 409].includes(response.status),
          };
          errorRef.current = creationError;
          setError(creationError);
          return null;
        }

        const parsed = createSessionResponseSchema.safeParse(
          await response.json().catch(() => null)
        );
        if (!parsed.success) return null;
        const { sessionId } = parsed.data;
        if (identityRef.current !== launchIdentity || abortController.signal.aborted) {
          void retireWarmDraftSession(sessionId);
          return null;
        }

        sessionIdRef.current = sessionId;
        setSessionId(sessionId);
        return sessionId;
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          console.error("Failed to create session for warming:", error);
        }
        return null;
      } finally {
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
          creationRef.current = null;
          setIsWarming(false);
        }
      }
    })();

    creationRef.current = creation;
    return creation;
  }, []);

  const consume = useCallback((consumedSessionId: string) => {
    if (sessionIdRef.current !== consumedSessionId) return;
    sessionIdRef.current = null;
    setSessionId(null);
  }, []);

  return { identity, sessionId, isWarming, warm, consume, error };
}
