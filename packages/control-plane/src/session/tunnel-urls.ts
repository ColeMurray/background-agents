import type { Logger } from "../logger";

/**
 * Parse a stored `sandbox.tunnel_urls` blob into a `{ [port]: url }` map.
 *
 * `tunnel_urls` is a JSON-encoded `Record<string, string>` written by
 * `SandboxLifecycleManager#storeAndBroadcastTunnelUrls`. Returns `null` when the
 * stored value is malformed — not valid JSON, not a plain JSON object, or holds
 * a non-string value — so callers can tell corrupt data apart from an empty map
 * and decide how to react (the DO state path falls open to `null`; the
 * sandbox-auth endpoint hard-fails with a 500). Logging is left to the caller so
 * this stays a pure, independently testable function.
 */
export function parseTunnelUrls(raw: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  if (!Object.values(parsed).every((value) => typeof value === "string")) {
    return null;
  }

  return parsed as Record<string, string>;
}

/**
 * {@link parseTunnelUrls} for the read paths that fall open on corrupt data:
 * logs the malformed blob and returns null, so the session state read still
 * succeeds with no tunnel URLs rather than failing.
 */
export function safeParseTunnelUrls(
  raw: string,
  log: Pick<Logger, "warn">
): Record<string, string> | null {
  const urls = parseTunnelUrls(raw);
  if (!urls) {
    log.warn("Invalid sandbox tunnel_urls JSON");
  }
  return urls;
}
