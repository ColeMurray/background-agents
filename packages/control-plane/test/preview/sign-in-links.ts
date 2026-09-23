import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { BrowserCookie } from "../support/browser-session";
import { PERSONAS, type Persona } from "./contracts";
import { errorSummary } from "./diagnostics";

export interface SignInLinks {
  /** Opening a link signs that browser in as its persona and lands on the web app. */
  urls: Record<Persona, string>;
  /** Embedded in every link, which makes each link a credential for this run. */
  key: string;
  close(): Promise<void>;
}

/**
 * Serves one sign-in link per persona for browsers outside the launcher's named sessions: a
 * person's everyday browser or any automation tool. A link sets its persona's login cookie and
 * redirects to the web app, which receives the cookie because cookies are scoped by host, not
 * port. This is launcher code on the app's loopback host, not a route in the application, and it
 * answers only its own Host header and per-run key.
 */
export async function startSignInLinks(
  webOrigin: string,
  signIn: (persona: Persona) => Promise<BrowserCookie>
): Promise<SignInLinks> {
  const key = randomBytes(32).toString("base64url");
  const expectedKey = Buffer.from(key);
  const hostname = new URL(webOrigin).hostname;
  let host = "";
  const server = createServer((request, response) => {
    // A rebound DNS name can reach this socket too; only the literal loopback host is ours.
    if (request.headers.host !== host) return reply(response, 421);
    if (request.method !== "GET") return reply(response, 405);
    const url = new URL(request.url ?? "/", `http://${host}`);
    const persona = PERSONAS.find((candidate) => url.pathname === `/as/${candidate}`);
    const givenKey = Buffer.from(url.searchParams.get("k") ?? "");
    if (
      !persona ||
      givenKey.length !== expectedKey.length ||
      !timingSafeEqual(givenKey, expectedKey)
    )
      return reply(response, 404);
    void signIn(persona).then(
      (cookie) =>
        response
          .writeHead(302, {
            Location: `${webOrigin}/`,
            "Set-Cookie": setCookieHeader(cookie),
            "Cache-Control": "no-store",
          })
          .end(),
      (error: unknown) => reply(response, 500, `Sign-in failed: ${errorSummary(error)}`)
    );
  });
  server.listen(0, hostname);
  await once(server, "listening");
  host = `${hostname}:${(server.address() as AddressInfo).port}`;
  return {
    urls: Object.fromEntries(
      PERSONAS.map((persona) => [persona, `http://${host}/as/${persona}?k=${key}`])
    ) as Record<Persona, string>,
    key,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

function reply(response: ServerResponse, status: number, body = "") {
  response
    .writeHead(status, { "Cache-Control": "no-store", "Content-Type": "text/plain" })
    .end(body);
}

/** The response header that stores `cookie`; an expiry in the past deletes it instead. */
function setCookieHeader(cookie: BrowserCookie): string {
  // No Domain attribute: a host-only cookie for the loopback host this server shares with the app.
  return [
    `${cookie.name}=${cookie.value}`,
    `Path=${cookie.path}`,
    `Expires=${new Date(cookie.expires * 1000).toUTCString()}`,
    ...(cookie.httpOnly ? ["HttpOnly"] : []),
    ...(cookie.secure ? ["Secure"] : []),
    `SameSite=${cookie.sameSite}`,
  ].join("; ");
}
