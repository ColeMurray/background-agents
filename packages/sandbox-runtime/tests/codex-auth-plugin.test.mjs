import assert from "node:assert/strict";
import test from "node:test";

import { CodexAuthProxy } from "../src/sandbox_runtime/plugins/codex-auth-plugin.js";

test("preserves a source Request while proxying Codex authentication", async () => {
  process.env.CONTROL_PLANE_URL = "https://control.test";
  process.env.SANDBOX_AUTH_TOKEN = "sandbox-token";
  process.env.SESSION_CONFIG = JSON.stringify({ sessionId: "session-1" });
  let upstreamRequest;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.startsWith("https://control.test/")) {
      return Response.json({
        accessToken: "access-token",
        expiresIn: 3600,
        providerMetadata: { accountId: "account-1" },
      });
    }
    upstreamRequest = request;
    return new Response(null, { status: 200 });
  };
  const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });
  const loaded = await plugin.auth.loader(async () => ({ type: "oauth", refresh: "managed" }), {
    models: {},
  });

  await loaded.fetch(
    new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer dummy", "X-Request-Header": "preserved" },
      body: "request-body",
    })
  );

  assert.equal(upstreamRequest.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(upstreamRequest.method, "POST");
  assert.equal(upstreamRequest.headers.get("authorization"), "Bearer access-token");
  assert.equal(upstreamRequest.headers.get("chatgpt-account-id"), "account-1");
  assert.equal(upstreamRequest.headers.get("x-request-header"), "preserved");
  assert.equal(await upstreamRequest.text(), "request-body");
});

test("preserves caller authorization after switching away from OAuth", async () => {
  let upstreamRequest;
  globalThis.fetch = async (input, init) => {
    upstreamRequest = input instanceof Request ? input : new Request(input, init);
    return new Response(null, { status: 200 });
  };
  let authReadCount = 0;
  const getAuth = async () =>
    authReadCount++ === 0 ? { type: "oauth", refresh: "managed" } : { type: "api" };
  const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });
  const loaded = await plugin.auth.loader(getAuth, { models: {} });

  await loaded.fetch(
    new Request("https://api.openai.com/v1/responses", {
      headers: { Authorization: "Bearer caller-token" },
    })
  );

  assert.equal(upstreamRequest.headers.get("authorization"), "Bearer caller-token");
});
