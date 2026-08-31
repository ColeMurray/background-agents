"use client";

import useSWR from "swr";
import { z } from "zod";
import { useCallback } from "react";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

const sandboxAccessSchema = z
  .object({
    codeServer: z.object({ url: z.string(), password: z.string() }).nullable(),
    vnc: z.object({ url: z.string(), password: z.string() }).nullable(),
    ttyd: z.object({ url: z.string(), token: z.string() }).nullable(),
    // Optional during rolling deployments where the control plane predates
    // these protected access fields.
    tunnelUrls: z.record(z.string(), z.string()).nullable().optional().default(null),
    sandboxDashboardUrl: z.string().nullable().optional().default(null),
  })
  .transform(({ codeServer, vnc, ttyd, tunnelUrls, sandboxDashboardUrl }) => ({
    codeServerUrl: codeServer?.url ?? null,
    codeServerPassword: codeServer?.password ?? null,
    vncUrl: vnc?.url ?? null,
    vncPassword: vnc?.password ?? null,
    ttydUrl: ttyd?.url ?? null,
    ttydToken: ttyd?.token ?? null,
    tunnelUrls,
    sandboxDashboardUrl,
  }));

type SandboxAccess = z.infer<typeof sandboxAccessSchema>;

export function useSandboxAccess(sessionId: string, isSandboxReady: boolean, enabled = true) {
  const key: BrowserApiPath | null =
    enabled && isSandboxReady
      ? `/api/sessions/${encodeURIComponent(sessionId)}/sandbox-access`
      : null;
  const { data, mutate } = useSWR<SandboxAccess | null>(key, async (url: BrowserApiPath) => {
    const response = await browserApiFetch(url, { cache: "no-store" });
    if (response.status === 204 || response.status === 404) return null;
    if (!response.ok) throw new Error(`Sandbox access failed with status ${response.status}`);
    return sandboxAccessSchema.parse(await response.json());
  });
  const clear = useCallback(() => mutate(null, { revalidate: false }), [mutate]);
  const refresh = useCallback(
    () => mutate(null, { revalidate: false }).then(() => mutate()),
    [mutate]
  );

  return {
    sandboxAccess: data,
    clear,
    refresh,
  };
}
