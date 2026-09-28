import assert from "node:assert/strict";
import test from "node:test";

import {
  API_EQUIVALENT_PRICES,
  CodexAuthProxy,
} from "../src/sandbox_runtime/plugins/codex-auth-plugin.js";

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

test("preserves API-key requests if OpenAI authentication switches away from OAuth", async () => {
  let upstreamRequest;
  globalThis.fetch = async (input, init) => {
    upstreamRequest = input instanceof Request ? input : new Request(input, init);
    return new Response(null, { status: 200 });
  };
  let authReadCount = 0;
  const getAuth = async () =>
    authReadCount++ === 0 ? { type: "oauth", refresh: "managed" } : { type: "api" };
  const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });
  const loaded = await plugin.auth.loader(getAuth);

  await loaded.fetch(
    new Request("https://api.openai.com/v1/responses", {
      headers: { Authorization: "Bearer api-key" },
    })
  );
  assert.equal(upstreamRequest.url, "https://api.openai.com/v1/responses");
  assert.equal(upstreamRequest.headers.get("authorization"), "Bearer api-key");
  assert.deepEqual(await plugin.auth.loader(async () => ({ type: "api" })), {});
});

test("restores known prices and missing Codex models after the built-in OAuth hook", async () => {
  const gpt6Ids = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
  const gpt6Models = gpt6Ids.map((id) => [id, { name: id, cost: { input: 0, output: 0 } }]);
  // OpenCode's built-in hook has already filtered gpt-5.3-codex and zeroed the survivors.
  const provider = {
    models: { ...Object.fromEntries(gpt6Models), "unsupported-model": { cost: { input: 0 } } },
  };
  const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });

  const apiKeyModels = await plugin.provider.models(provider, { auth: { type: "api" } });
  assert.equal(apiKeyModels, provider.models);

  const priced = await plugin.provider.models(provider, { auth: { type: "oauth" } });
  assert.equal(priced["gpt-6-astra"].cost.input, 10);
  assert.equal(priced["gpt-6-astra"].cost.tiers[0].tier.size, 272_000);
  assert.equal(priced["gpt-6-sol"].cost.cache.read, 0.2);
  assert.equal(priced["gpt-6-luna"].cost.output, 0.5);
  assert.equal(priced["unsupported-model"], undefined);
  assert.equal(priced["gpt-5.3-codex"].api.id, "gpt-5.3-codex");
  assert.equal(priced["gpt-5.3-codex"].cost.input, 1.75);
  assert.equal(priced["gpt-5.3-codex"].limit.input, 272_000);
  assert.equal(priced["gpt-5.3-codex-spark"].cost.output, 14);
  assert.equal(provider.models["gpt-6-astra"].cost.input, 0);
  assert.equal(provider.models["gpt-5.3-codex"], undefined);
  await plugin.auth.loader(async () => ({ type: "oauth", refresh: "managed" }));
});

test("uses the over-200k price until the 272k context tier takes over", () => {
  const cost = API_EQUIVALENT_PRICES["gpt-6-astra"];
  const selected = (tokens) =>
    cost.tiers?.filter(({ tier }) => tokens > tier.size).at(-1) ??
    (tokens > 200_000 ? cost.experimentalOver200K : cost);

  assert.equal(selected(200_000).input, 10);
  assert.equal(selected(200_001).input, 20);
  assert.equal(selected(272_000), cost.experimentalOver200K);
  assert.equal(selected(272_001), cost.tiers[0]);
  assert.equal(cost.experimentalOver200K.cache.write, 25);
});
