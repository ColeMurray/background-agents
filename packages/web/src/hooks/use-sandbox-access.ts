"use client";

import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { useCallback, useEffect } from "react";
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
  const accessUrl: BrowserApiPath = `/api/sessions/${encodeURIComponent(sessionId)}/sandbox-access`;
  const available = enabled && isSandboxReady;
  const { mutate: mutateCache } = useSWRConfig();
  const { data, error, mutate } = useSWR<SandboxAccess | null>(
    available ? accessUrl : null,
    async (url: BrowserApiPath) => {
      const response = await browserApiFetch(url, { cache: "no-store" });
      if (response.status === 204 || response.status === 404) return null;
      if (response.status === 409) {
        const body: unknown = await response
          .clone()
          .json()
          .catch(() => null);
        if (
          body &&
          typeof body === "object" &&
          "error" in body &&
          body.error === "Sandbox access is unavailable"
        )
          return null;
      }
      if (!response.ok) throw new Error(`Sandbox access failed with status ${response.status}`);
      return sandboxAccessSchema.parse(await response.json());
    }
  );
  const clear = useCallback(
    () => mutateCache(accessUrl, null, { revalidate: false }),
    [accessUrl, mutateCache]
  );
  useEffect(() => {
    if (!available) void clear();
  }, [available, clear]);
  const refresh = useCallback(
    () => clear().then(() => (available ? mutate() : undefined)),
    [available, clear, mutate]
  );

  return {
    sandboxAccess: available && !error ? data : null,
    clear,
    refresh,
  };
}
