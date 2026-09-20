import type { FetchClient } from "../platform-ports";
import type { Request as NodeRequest } from "undici-types";

const INTERNAL_ORIGIN = "https://internal";

/** A binding-shaped transport to one configured origin; signing and retries stay with callers. */
export function createUrlFetchClient(baseUrl: string): FetchClient {
  const base = botOrigin(baseUrl);
  return {
    async fetch(input, init) {
      const target = new URL(input instanceof Request ? input.url : input, INTERNAL_ORIGIN);
      if (target.origin !== INTERNAL_ORIGIN && target.origin !== base.origin) {
        throw new Error("Bot requests must target the internal or configured bot origin");
      }
      // Assign the origin, never resolve the pathname as a URL: a // pathname
      // must not turn into a different authority. Keep query ordering and bytes.
      target.protocol = base.protocol;
      target.host = base.host;
      let forwarded: Request;
      if (input instanceof Request) {
        // The combined test program also loads Worker globals; this adapter
        // always runs against Node's native Request implementation.
        const request = new Request(input, init) as unknown as NodeRequest;
        // A keepalive Request has a replayable source, but its exposed body is a
        // stream. Passing that stream as a new body is invalid for keepalive.
        const rewrittenInit =
          request.keepalive && request.body
            ? {
                method: request.method,
                headers: request.headers,
                body: await request.arrayBuffer(),
                referrer: request.referrer,
                referrerPolicy: request.referrerPolicy,
                mode: request.mode,
                credentials: request.credentials,
                cache: request.cache,
                redirect: request.redirect,
                integrity: request.integrity,
                keepalive: request.keepalive,
                signal: request.signal,
              }
            : request;
        forwarded = new Request(target, rewrittenInit as RequestInit);
      } else {
        forwarded = new Request(target, init);
      }
      forwarded.headers.delete("host");
      return globalThis.fetch(forwarded, {
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
