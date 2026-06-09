/**
 * Reads workspace-wide Slack integration settings from the control plane.
 *
 * Currently exposes the `allowPrivateChannels` gate. The value is cached in memory
 * with a short TTL and mirrored to KV as a "last-known-good" so the gate degrades
 * safely: an operator who set deny is never re-opened by a transient control-plane
 * outage, while default-allow installs are not bricked when the fetch fails.
 */

import {
  buildInternalAuthHeaders,
  createKvCacheStore,
  resolveAllowPrivateChannels,
  DEFAULT_ALLOW_PRIVATE_CHANNELS,
  type SlackGlobalConfig,
} from "@open-inspect/shared";
import type { Env } from "./types";
import { createLogger } from "./logger";

const log = createLogger("integration-settings");

/** Short in-memory TTL; the bot may restart often, so this mirrors the repos cache. */
const LOCAL_CACHE_TTL_MS = 60 * 1000;

/** KV key holding the last successfully fetched value ("true" / "false"). */
const LAST_KNOWN_KV_KEY = "slack_settings:allow_private_channels";

interface ControlPlaneSlackSettingsResponse {
  integrationId: string;
  settings: SlackGlobalConfig | null;
}

let localCache: { allowPrivateChannels: boolean; timestamp: number } | null = null;

/** Reset the in-memory cache. Exported for test isolation (mirrors clearLocalCache). */
export function resetSlackSettingsCache(): void {
  localCache = null;
}

/**
 * Resolve the effective `allowPrivateChannels` gate for the workspace.
 *
 * Returns `true` (allow) by default. Only an explicit operator `false` denies.
 *
 * Outage behavior (bounded, not absolute): on a fetch failure we prefer the last
 * successfully fetched value from KV, so a deny that was already observed stays a deny
 * and is latched into the in-memory cache to avoid per-request oscillation and a request
 * storm against a down control plane. A deny that was set *during* an outage — or before
 * this isolate ever fetched (cold start with no KV value) — cannot be enforced until a
 * fetch succeeds; that window is the in-memory TTL plus reconnect time. The permissive
 * default is used only when no value was ever known, preserving default-allow behavior.
 */
export async function getAllowPrivateChannels(env: Env, traceId?: string): Promise<boolean> {
  if (localCache && Date.now() - localCache.timestamp < LOCAL_CACHE_TTL_MS) {
    return localCache.allowPrivateChannels;
  }

  const kv = createKvCacheStore(env.SLACK_KV);

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
    };

    let response: Response;
    if (env.CONTROL_PLANE) {
      response = await env.CONTROL_PLANE.fetch("https://internal/integration-settings/slack", {
        headers,
      });
    } else {
      response = await fetch(`${env.CONTROL_PLANE_URL}/integration-settings/slack`, {
        headers: { ...headers, "User-Agent": "open-inspect-slack-bot" },
      });
    }

    if (!response.ok) {
      throw new Error(`control plane returned ${response.status}`);
    }

    const data = (await response.json()) as ControlPlaneSlackSettingsResponse;
    const allowPrivateChannels = resolveAllowPrivateChannels(data.settings?.defaults);

    localCache = { allowPrivateChannels, timestamp: Date.now() };
    try {
      await kv.put(LAST_KNOWN_KV_KEY, String(allowPrivateChannels));
    } catch (e) {
      log.warn("kv.put", {
        trace_id: traceId,
        key_prefix: "slack_settings",
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
    return allowPrivateChannels;
  } catch (e) {
    log.error("control_plane.fetch_slack_settings", {
      trace_id: traceId,
      outcome: "error",
      error: e instanceof Error ? e : new Error(String(e)),
    });
    // Prefer the last successfully fetched value over the permissive default, and latch
    // it into the in-memory cache so a deny does not oscillate per request and we stop
    // re-hitting a down control plane on every event. When no value was ever recorded,
    // fall back to the permissive default WITHOUT caching, so a freshly-set deny is
    // picked up as soon as the control plane recovers rather than waiting out the TTL.
    try {
      const lastKnown = await kv.get(LAST_KNOWN_KV_KEY);
      if (lastKnown === "true" || lastKnown === "false") {
        const allowPrivateChannels = lastKnown === "true";
        localCache = { allowPrivateChannels, timestamp: Date.now() };
        return allowPrivateChannels;
      }
    } catch {
      // KV unavailable too — fall through to the default.
    }
    return DEFAULT_ALLOW_PRIVATE_CHANNELS;
  }
}
