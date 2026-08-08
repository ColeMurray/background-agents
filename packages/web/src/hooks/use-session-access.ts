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

export function useSessionAccess(sessionId: string) {
  const key: BrowserApiPath = `/api/sessions/${encodeURIComponent(sessionId)}/access`;
  const { data, mutate } = useSWR<SessionAccess | null>(key, async (url: BrowserApiPath) => {
    const response = await browserApiFetch(url, { cache: "no-store" });
    if (response.status === 404 || response.status === 409) return null;
    if (!response.ok) throw new Error(`Session access failed with status ${response.status}`);
    return sessionAccessSchema.parse(await response.json());
  });
  const clear = useCallback(() => mutate(null, { revalidate: false }), [mutate]);
  const refresh = useCallback(
    () => mutate(null, { revalidate: false }).then(() => mutate()),
    [mutate]
  );

  return {
    access: data,
    clear,
    refresh,
  };
}
