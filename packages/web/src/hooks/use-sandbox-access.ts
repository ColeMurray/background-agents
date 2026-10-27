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

const connectRequiredSchema = z.object({ code: z.literal("sandbox_connect_required") });
const previewUrlsSchema = z.object({ tunnelUrls: z.record(z.string(), z.string()) });

type SandboxAccess =
  | z.infer<typeof sandboxAccessSchema>
  | { tunnelUrls: Record<string, string>; connectRequired: true };

/**
 * Credentials when the control plane hands them out, or, when it needs the viewer's explicit
 * connect first, the preview links that carry no credentials.
 */
async function loadSandboxAccess(base: string, connect: boolean): Promise<SandboxAccess | null> {
  const response = await browserApiFetch(
    `${base}/sandbox-access${connect ? "?connect=1" : ""}` as BrowserApiPath,
    { cache: "no-store" }
  );
  if (response.status === 204 || response.status === 404) return null;
  if (response.status === 409) {
    const refusal = connectRequiredSchema.safeParse(await response.json().catch(() => null));
    if (refusal.success) {
      const previews = await browserApiFetch(`${base}/tunnel-urls` as BrowserApiPath, {
        cache: "no-store",
      });
      if (!previews.ok && previews.status !== 404)
        throw new Error(`Sandbox preview links failed with status ${previews.status}`);
      const tunnelUrls = previews.ok
        ? previewUrlsSchema.parse(await previews.json()).tunnelUrls
        : {};
      return { tunnelUrls, connectRequired: true };
    }
  }
  if (!response.ok) throw new Error(`Sandbox access failed with status ${response.status}`);
  return sandboxAccessSchema.parse(await response.json());
}

/**
 * A viewer's access to a ready sandbox. Credentials load straight away unless the control plane
 * says opening the sandbox would switch off the session owner's personal memory; then only preview
 * links load, `connectRequired` is set, and `connect()` asks for the credentials explicitly.
 */
export function useSandboxAccess(sessionId: string, isSandboxReady: boolean, enabled = true) {
  const [connectedSessionId, setConnectedSessionId] = useState<string | null>(null);
  const connected = connectedSessionId === sessionId;
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const key: BrowserApiPath | null =
    enabled && isSandboxReady
      ? (`${base}/sandbox-access${connected ? "?connect=1" : ""}` as BrowserApiPath)
      : null;
  const { data, mutate } = useSWR<SandboxAccess | null>(key, () =>
    loadSandboxAccess(base, connected)
  );
  const connect = useCallback(() => setConnectedSessionId(sessionId), [sessionId]);
  const clear = useCallback(() => mutate(null, { revalidate: false }), [mutate]);
  const refresh = useCallback(
    () => mutate(null, { revalidate: false }).then(() => mutate()),
    [mutate]
  );
  const connectRequired = !!data && "connectRequired" in data;

  return {
    sandboxAccess: data && "connectRequired" in data ? { tunnelUrls: data.tunnelUrls } : data,
    connectRequired,
    connect,
    clear,
    refresh,
  };
}
