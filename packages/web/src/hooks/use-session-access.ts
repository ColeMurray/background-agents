"use client";

import useSWR from "swr";
import { z } from "zod";
import { useCallback } from "react";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

const sessionAccessSchema = z
  .object({
    codeServer: z.object({ url: z.string(), password: z.string() }).nullable(),
    ttyd: z.object({ url: z.string(), token: z.string() }).nullable(),
  })
  .transform(({ codeServer, ttyd }) => ({
    codeServerUrl: codeServer?.url ?? null,
    codeServerPassword: codeServer?.password ?? null,
    ttydUrl: ttyd?.url ?? null,
    ttydToken: ttyd?.token ?? null,
  }));

export type SessionAccess = z.infer<typeof sessionAccessSchema>;

export function sessionAccessKey(sessionId: string): BrowserApiPath {
  return `/api/sessions/${encodeURIComponent(sessionId)}/access`;
}

export function useSessionAccess(sessionId: string) {
  const key = sessionAccessKey(sessionId);
  const result = useSWR<SessionAccess | null>(key, async (url: BrowserApiPath) => {
    const response = await browserApiFetch(url, { cache: "no-store" });
    if (response.status === 404 || response.status === 409) return null;
    if (!response.ok) throw new Error(`Session access failed with status ${response.status}`);
    return sessionAccessSchema.parse(await response.json());
  });
  const { data, mutate } = result;
  const clear = useCallback(() => mutate(null, { revalidate: false }), [mutate]);
  const refetch = useCallback(() => mutate(), [mutate]);

  return {
    access: data,
    clear,
    refetch,
  };
}
