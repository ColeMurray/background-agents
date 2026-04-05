/**
 * ttyd-proxy — JWT-authenticated reverse proxy for ttyd.
 *
 * Runs as a Bun HTTP server inside the sandbox. Validates HS256 JWTs signed
 * with SANDBOX_AUTH_TOKEN before proxying requests to ttyd on localhost.
 *
 * Usage: bun run /app/sandbox_runtime/ttyd_proxy/server.ts
 */

const TTYD_PORT = 7681;
const PROXY_PORT = 7680;
const SECRET = process.env.SANDBOX_AUTH_TOKEN;

if (!SECRET) {
  console.error("SANDBOX_AUTH_TOKEN not set, cannot start ttyd proxy");
  process.exit(1);
}

// --- HS256 JWT verification (no dependencies) ---

function base64urlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function base64urlEncode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function verifyJwt(token: string): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const [header, payload, signature] = parts;

    // Verify algorithm
    const headerObj = JSON.parse(new TextDecoder().decode(base64urlDecode(header)));
    if (headerObj.alg !== "HS256") return false;

    // Verify signature
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sigBytes = base64urlDecode(signature);
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, data);
    if (!valid) return false;

    // Check expiry
    const payloadObj = JSON.parse(new TextDecoder().decode(base64urlDecode(payload)));
    if (payloadObj.exp && payloadObj.exp < Math.floor(Date.now() / 1000)) return false;

    return true;
  } catch {
    return false;
  }
}

// --- WebSocket proxy state ---

const upstreamSockets = new WeakMap<object, WebSocket>();

// --- Server ---

Bun.serve({
  port: PROXY_PORT,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    // WebSocket upgrade — requires valid JWT
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!token || !(await verifyJwt(token))) {
        return new Response("Unauthorized", { status: 401 });
      }
      const upgraded = server.upgrade(req, { data: {} });
      return upgraded ? undefined : new Response("Upgrade failed", { status: 500 });
    }

    // HTML page (/) — requires valid JWT, injects WebSocket auth
    if (url.pathname === "/") {
      if (!token || !(await verifyJwt(token))) {
        return new Response("Unauthorized", { status: 401 });
      }

      const resp = await fetch(`http://127.0.0.1:${TTYD_PORT}/`);
      let html = await resp.text();

      // Inject script that patches WebSocket constructor to include the JWT
      // in the query string of all WebSocket connections made by ttyd's xterm.js
      const wsAuthScript = `<script>(function(){
        var _WS=WebSocket;
        window.WebSocket=function(u,p){
          var url=new URL(u,window.location.origin);
          url.searchParams.set("token",${JSON.stringify(token)});
          return new _WS(url.toString(),p);
        };
        window.WebSocket.prototype=_WS.prototype;
        window.WebSocket.CONNECTING=0;
        window.WebSocket.OPEN=1;
        window.WebSocket.CLOSING=2;
        window.WebSocket.CLOSED=3;
      })();</script>`;

      html = html.replace("<head>", `<head>${wsAuthScript}`);
      return new Response(html, {
        headers: { "Content-Type": resp.headers.get("Content-Type") || "text/html" },
      });
    }

    // All other requests (CSS, JS, favicons) — proxy without auth
    // Use a minimal header allowlist to avoid forwarding cookies, auth headers,
    // and the original Host header to the localhost ttyd instance
    const target = `http://127.0.0.1:${TTYD_PORT}${url.pathname}${url.search}`;
    const proxyHeaders = new Headers();
    for (const key of ["accept", "accept-encoding", "accept-language", "if-none-match"]) {
      const val = req.headers.get(key);
      if (val) proxyHeaders.set(key, val);
    }
    return fetch(target, { method: req.method, headers: proxyHeaders });
  },

  websocket: {
    open(ws) {
      // Connect to ttyd's WebSocket on localhost
      const upstream = new WebSocket(`ws://127.0.0.1:${TTYD_PORT}/ws`);
      upstreamSockets.set(ws, upstream);

      upstream.binaryType = "arraybuffer";
      upstream.onmessage = (event) => ws.send(event.data);
      upstream.onclose = () => ws.close();
      upstream.onerror = () => ws.close();
    },
    message(ws, message) {
      const upstream = upstreamSockets.get(ws);
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(message);
      }
    },
    close(ws) {
      const upstream = upstreamSockets.get(ws);
      upstream?.close();
      upstreamSockets.delete(ws);
    },
  },
});

console.log(`ttyd-proxy listening on port ${PROXY_PORT}`);
