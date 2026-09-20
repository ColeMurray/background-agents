import type { FetchClient } from "../platform-ports";

export const DEFAULT_BOT_REQUEST_TIMEOUT_MS = 10_000;
const INTERNAL_ORIGIN = "https://internal";

/** A binding-shaped transport to one configured origin; signing and retries stay with callers. */
export function createUrlFetchClient(
  baseUrl: string,
  { timeoutMs = DEFAULT_BOT_REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {}
): FetchClient {
  const base = botOrigin(baseUrl);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) {
    throw new Error("Bot request timeoutMs must be a positive signed 32-bit integer");
  }
  return {
    async fetch(input, init) {
      const request = new Request(
        input instanceof Request ? input : new URL(input, INTERNAL_ORIGIN),
        init
      );
      const target = new URL(request.url);
      if (target.origin !== INTERNAL_ORIGIN && target.origin !== base.origin) {
        throw new Error("Bot requests must target the internal or configured bot origin");
      }
      // Assign the origin, never resolve the pathname as a URL: a // pathname
      // must not turn into a different authority. Keep query ordering and bytes.
      target.protocol = base.protocol;
      target.host = base.host;
      const forwarded = new Request(target, request);
      forwarded.headers.delete("host");
      return globalThis.fetch(forwarded, {
        // This remains active after headers arrive, bounding body consumption too.
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
        // Never forward a signed body through a redirect, even if a caller asks.
        redirect: "error",
      });
    },
  };
}

function botOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Do not echo a misconfigured URL that might contain credentials.
    throw new Error("Bot URL must be an absolute HTTPS origin");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Bot URL must be an HTTPS origin without credentials, path, query or fragment (HTTP loopback is allowed)"
    );
  }
  return url;
}
