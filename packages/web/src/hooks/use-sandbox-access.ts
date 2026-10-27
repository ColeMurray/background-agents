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

type SandboxAccessRead = z.infer<typeof sandboxAccessSchema> | { connectRequired: true };

/** Credentials, or the control plane's request for an explicit connect first. */
async function fetchSandboxAccess(
  base: string,
  connect: boolean
): Promise<SandboxAccessRead | null> {
  const response = await browserApiFetch(
    `${base}/sandbox-access${connect ? "?connect=1" : ""}` as BrowserApiPath,
    { cache: "no-store" }
  );
  if (response.status === 204 || response.status === 404) return null;
  if (
    response.status === 409 &&
    connectRequiredSchema.safeParse(await response.json().catch(() => null)).success
  )
    return { connectRequired: true };
  if (!response.ok) throw new Error(`Sandbox access failed with status ${response.status}`);
  return sandboxAccessSchema.parse(await response.json());
}

async function fetchPreviewUrls(base: string): Promise<Record<string, string>> {
  const response = await browserApiFetch(`${base}/tunnel-urls` as BrowserApiPath, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Sandbox preview links failed with status ${response.status}`);
  return previewUrlsSchema.parse(await response.json()).tunnelUrls;
}

/**
 * A viewer's access to a ready sandbox. Credentials load straight away unless the control plane
 * says opening the sandbox would switch off the session owner's personal memory. Then
 * `connectRequired` is set, preview links load on their own, and `connect()` asks for the
 * credentials explicitly, filling the same cache when they arrive; a failed attempt can be retried.
 */
export function useSandboxAccess(sessionId: string, isSandboxReady: boolean, enabled = true) {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const key: BrowserApiPath | null =
    enabled && isSandboxReady ? (`${base}/sandbox-access` as BrowserApiPath) : null;
  const { data, mutate } = useSWR<SandboxAccessRead | null>(key, () =>
    fetchSandboxAccess(base, false)
  );
  const connectRequired = !!data && "connectRequired" in data;
  const { data: previewUrls } = useSWR<Record<string, string>>(
    connectRequired ? `${base}/tunnel-urls` : null,
    () => fetchPreviewUrls(base)
  );
  const [attempt, setAttempt] = useState<{
    sessionId: string;
    status: "pending" | "failed";
  } | null>(null);
  const connect = useCallback(async () => {
    if (!key) return;
    setAttempt({ sessionId, status: "pending" });
    try {
      await mutate(await fetchSandboxAccess(base, true), { revalidate: false });
      setAttempt(null);
    } catch {
      setAttempt({ sessionId, status: "failed" });
    }
  }, [base, key, mutate, sessionId]);
  const clear = useCallback(() => mutate(null, { revalidate: false }), [mutate]);
  const refresh = useCallback(
    () => mutate(null, { revalidate: false }).then(() => mutate()),
    [mutate]
  );
  const attemptStatus = attempt?.sessionId === sessionId ? attempt.status : null;

  return {
    sandboxAccess: connectRequired ? (previewUrls ? { tunnelUrls: previewUrls } : undefined) : data,
    connectRequired,
    connecting: attemptStatus === "pending",
    connectFailed: attemptStatus === "failed",
    connect,
    clear,
    refresh,
  };
}
