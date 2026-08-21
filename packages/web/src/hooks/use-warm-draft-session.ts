"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModelProviderSelections } from "@open-inspect/shared/types/provider-accounts";
import type { SessionSkillSelection } from "@open-inspect/shared/types/skills";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import type { SessionTargetRequestFields } from "@/lib/session-target";
import { retireWarmDraftSession } from "@/lib/warm-session";

export type WarmDraftSessionRequest = SessionTargetRequestFields & {
  model: string;
  reasoningEffort?: string;
  skillSelection: SessionSkillSelection;
  providerSelections: ModelProviderSelections;
};

export function warmDraftSessionIdentity(request: WarmDraftSessionRequest | null): string | null {
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
  return JSON.stringify(canonicalize(request));
}

export function useWarmDraftSession(request: WarmDraftSessionRequest | null) {
  const identity = warmDraftSessionIdentity(request);
  const requestRef = useRef(request);
  const identityRef = useRef(identity);
  const sessionIdRef = useRef<string | null>(null);
  const creationRef = useRef<Promise<string | null> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isWarming, setIsWarming] = useState(false);

  useLayoutEffect(() => {
    requestRef.current = request;
    identityRef.current = identity;
  }, [identity, request]);

  useLayoutEffect(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    creationRef.current = null;
    setIsWarming(false);

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

    const launchRequest = requestRef.current;
    const launchIdentity = identityRef.current;
    if (!launchRequest || !launchIdentity) return null;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setIsWarming(true);

    const creation = (async () => {
      try {
        const response = await browserApiFetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(launchRequest),
          signal: abortController.signal,
        });
        if (!response.ok) return null;

        const payload = (await response.json()) as { sessionId?: unknown };
        if (typeof payload.sessionId !== "string" || payload.sessionId.length === 0) return null;
        if (identityRef.current !== launchIdentity) {
          void retireWarmDraftSession(payload.sessionId);
          return null;
        }

        sessionIdRef.current = payload.sessionId;
        setSessionId(payload.sessionId);
        return payload.sessionId;
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

  return { sessionId, isWarming, warm, consume };
}
