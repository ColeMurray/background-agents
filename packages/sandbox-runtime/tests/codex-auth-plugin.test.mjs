import assert from "node:assert/strict";
import test from "node:test";

import { CodexAuthProxy } from "../src/sandbox_runtime/plugins/codex-auth-plugin.js";

test("retries once with a refreshed token after an upstream 401", async () => {
  process.env.CONTROL_PLANE_URL = "https://control.test";
  process.env.SANDBOX_AUTH_TOKEN = "sandbox-token";
  process.env.SESSION_CONFIG = JSON.stringify({ sessionId: "session-1" });
  const brokerBodies = [];
  const upstreamTokens = [];
  let brokerRequests = 0;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.startsWith("https://control.test/")) {
      brokerBodies.push(await request.json());
      brokerRequests++;
      return Response.json({
        accessToken: brokerRequests === 1 ? "access-1" : "access-2",
        expiresIn: 3600,
        providerMetadata: { accountId: "acct-1" },
      });
    }
    upstreamTokens.push(request.headers.get("authorization"));
    return new Response(null, { status: upstreamTokens.length === 1 ? 401 : 200 });
  };
  const getAuth = async () => ({ type: "oauth", refresh: "managed" });
  const setAuth = async () => undefined;
  const plugin = await CodexAuthProxy({ client: { auth: { set: setAuth } } });
  const loaded = await plugin.auth.loader(getAuth, { models: {} });

  const response = await loaded.fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5.4", input: "hello" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(upstreamTokens, ["Bearer access-1", "Bearer access-2"]);
  assert.deepEqual(brokerBodies, [{}, { rejectedAccessToken: "access-1" }]);
});
