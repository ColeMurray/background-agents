import { request as httpRequest, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserCookie } from "../support/browser-session";
import type { Persona } from "./contracts";
import { startSignInLinks, type SignInLinks } from "./sign-in-links";

const webOrigin = "http://127.0.0.1:3100";
const cookie: BrowserCookie = {
  name: "openinspect.session_token",
  value: "token.signature",
  domain: "127.0.0.1",
  path: "/",
  expires: Date.UTC(2030, 0, 1) / 1000,
  httpOnly: true,
  secure: false,
  sameSite: "Lax",
};

async function get(url: string, init: { method?: string; host?: string } = {}) {
  const { hostname, port, pathname, search, host } = new URL(url);
  const request = httpRequest({
    hostname,
    port,
    path: `${pathname}${search}`,
    method: init.method ?? "GET",
    headers: { Host: init.host ?? host },
  });
  request.end();
  const [response] = (await once(request, "response")) as [IncomingMessage];
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => (body += chunk));
  await once(response, "end");
  return { status: response.statusCode, headers: response.headers, body };
}

describe("sign-in links", () => {
  let links: SignInLinks | undefined;
  afterEach(async () => {
    await links?.close();
    links = undefined;
  });

  it("signs a browser in as the linked persona and lands it on the app", async () => {
    const signIn = vi.fn(async (_persona: Persona) => cookie);
    links = await startSignInLinks(webOrigin, signIn);
    expect(links.urls.owner).toBe(`${new URL(links.urls.owner).origin}/as/owner?k=${links.key}`);
    expect(new URL(links.urls.owner).hostname).toBe("127.0.0.1");
    const response = await get(links.urls.owner);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${webOrigin}/`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toEqual([
      "openinspect.session_token=token.signature; Path=/; Expires=Tue, 01 Jan 2030 00:00:00 GMT; HttpOnly; SameSite=Lax",
    ]);
    expect(signIn).toHaveBeenCalledWith("owner");
  });

  it("deletes the login cookie when the persona's cookie has already expired", async () => {
    links = await startSignInLinks(webOrigin, async () => ({ ...cookie, value: "", expires: 0 }));
    const response = await get(links.urls.anonymous);
    expect(response.status).toBe(302);
    expect(response.headers["set-cookie"]).toEqual([
      "openinspect.session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax",
    ]);
  });

  it("answers only its own host, key, method and personas", async () => {
    const signIn = vi.fn(async (_persona: Persona) => cookie);
    links = await startSignInLinks(webOrigin, signIn);
    const link = new URL(links.urls.member);
    const withoutKey = `${link.origin}${link.pathname}`;
    expect((await get(withoutKey)).status).toBe(404);
    expect((await get(`${withoutKey}?k=${"A".repeat(links.key.length)}`)).status).toBe(404);
    expect((await get(`${link.origin}/as/administrator${link.search}`)).status).toBe(404);
    expect((await get(links.urls.member, { method: "POST" })).status).toBe(405);
    // DNS rebinding: an attacker's name resolving to loopback still sends its own Host.
    expect((await get(links.urls.member, { host: `rebound.test:${link.port}` })).status).toBe(421);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("reports a failed sign-in to the browser and keeps serving", async () => {
    const signIn = vi
      .fn<(persona: Persona) => Promise<BrowserCookie>>()
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockResolvedValue(cookie);
    links = await startSignInLinks(webOrigin, signIn);
    const failed = await get(links.urls.member);
    expect(failed.status).toBe(500);
    expect(failed.body).toBe("Sign-in failed: database is locked");
    expect((await get(links.urls.member)).status).toBe(302);
  });

  it("stops answering once closed", async () => {
    links = await startSignInLinks(webOrigin, async () => cookie);
    const { member } = links.urls;
    await links.close();
    links = undefined;
    await expect(get(member)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
