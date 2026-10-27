"use client";

import useSWR from "swr";
import { z } from "zod";
import { useCallback, useState } from "react";
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

const previewUrlsSchema = z.object({ tunnelUrls: z.record(z.string(), z.string()) });

type SandboxAccess = z.infer<typeof sandboxAccessSchema> | z.infer<typeof previewUrlsSchema>;

async function fetchSandboxAccess(url: BrowserApiPath): Promise<SandboxAccess | null> {
  const response = await browserApiFetch(url, { cache: "no-store" });
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Sandbox access failed with status ${response.status}`);
  const body = await response.json();
  return url.endsWith("/sandbox-access")
    ? sandboxAccessSchema.parse(body)
    : previewUrlsSchema.parse(body);
}

export interface SandboxAccessOptions {
  /** Whether the viewer may use the sandbox at all. */
  enabled?: boolean;
  /** Load credentials without waiting for `connect()`, as for the session's owner. */
  autoConnect?: boolean;
}

/**
 * A viewer's access to a ready sandbox. Until they connect, only preview-port URLs load.
 * `connect()` also loads the terminal, editor and desktop credentials. The control plane treats
 * handing those to anyone but the session owner as joining the session, which switches off the
 * owner's personal memory search, so viewing a session never loads them.
 */
export function useSandboxAccess(
  sessionId: string,
  isSandboxReady: boolean,
  { enabled = true, autoConnect = false }: SandboxAccessOptions = {}
) {
  const [connectedSessionId, setConnectedSessionId] = useState<string | null>(null);
  const connected = enabled && (autoConnect || connectedSessionId === sessionId);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}` as const;
  const key: BrowserApiPath | null =
    enabled && isSandboxReady
      ? connected
        ? `${base}/sandbox-access`
        : `${base}/tunnel-urls`
      : null;
  const { data, mutate } = useSWR<SandboxAccess | null>(key, fetchSandboxAccess);
  const connect = useCallback(() => setConnectedSessionId(sessionId), [sessionId]);
  const clear = useCallback(() => mutate(null, { revalidate: false }), [mutate]);
  const refresh = useCallback(
    () => mutate(null, { revalidate: false }).then(() => mutate()),
    [mutate]
  );

  return {
    sandboxAccess: data,
    connected,
    connect,
    clear,
    refresh,
  };
}
