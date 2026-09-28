import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexAuthProxy } from "../src/sandbox_runtime/plugins/codex-auth-plugin.js";

async function withCatalog(models, run) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-model-prices-"));
  const previous = process.env.OPENCODE_MODELS_PATH;
  process.env.OPENCODE_MODELS_PATH = join(directory, "models.json");
  await writeFile(process.env.OPENCODE_MODELS_PATH, JSON.stringify({ openai: { models } }));
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_MODELS_PATH;
    else process.env.OPENCODE_MODELS_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

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
  await withCatalog(
    {
      "gpt-6-astra": { cost: { input: 12, output: 52, cache_read: 1.2 } },
      "gpt-6-sol": { cost: { input: 3, output: 11, cache_read: 0.3 } },
      "gpt-6-luna": { cost: { input: 0.2, output: 0.6 } },
      "gpt-5.3-codex": { cost: { input: 2, output: 15 } },
      "gpt-5.3-codex-spark": { cost: { input: 2.5, output: 16 } },
    },
    async () => {
      const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });

      const apiKeyModels = await plugin.provider.models(provider, { auth: { type: "api" } });
      assert.equal(apiKeyModels, provider.models);

      const priced = await plugin.provider.models(provider, { auth: { type: "oauth" } });
      assert.equal(priced["gpt-6-astra"].cost.input, 12);
      assert.equal(priced["gpt-6-sol"].cost.cache.read, 0.3);
      assert.equal(priced["gpt-6-luna"].cost.output, 0.6);
      assert.equal(priced["unsupported-model"], undefined);
      assert.equal(priced["gpt-5.3-codex"].api.id, "gpt-5.3-codex");
      assert.equal(priced["gpt-5.3-codex"].cost.input, 2);
      assert.equal(priced["gpt-5.3-codex"].limit.input, 272_000);
      assert.equal(priced["gpt-5.3-codex-spark"].cost.output, 16);
      assert.equal(provider.models["gpt-6-astra"].cost.input, 0);
      assert.equal(provider.models["gpt-5.3-codex"], undefined);
      await plugin.auth.loader(async () => ({ type: "oauth", refresh: "managed" }));
    }
  );
});

test("converts catalog context pricing without hardcoding the tier rates", async () => {
  await withCatalog(
    {
      "gpt-6-astra": {
        cost: {
          input: 12,
          output: 52,
          cache_read: 1.2,
          cache_write: 13,
          context_over_200k: { input: 24, output: 78, cache_read: 2.4, cache_write: 26 },
          tiers: [
            {
              input: 25,
              output: 80,
              cache_read: 2.5,
              cache_write: 27,
              tier: { type: "context", size: 272_000 },
            },
          ],
        },
      },
    },
    async () => {
      const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });
      const models = await plugin.provider.models(
        { models: { "gpt-6-astra": { cost: { input: 0, output: 0 } } } },
        { auth: { type: "oauth" } }
      );
      const cost = models["gpt-6-astra"].cost;
      const selected = (tokens) =>
        cost.tiers?.filter(({ tier }) => tokens > tier.size).at(-1) ??
        (tokens > 200_000 ? cost.experimentalOver200K : cost);

      assert.equal(selected(200_000).input, 12);
      assert.equal(selected(200_001).input, 24);
      assert.equal(selected(272_000), cost.experimentalOver200K);
      assert.equal(selected(272_001).input, 25);
      assert.equal(cost.experimentalOver200K.cache.write, 26);
      assert.equal(cost.tiers[0].cache.write, 27);
    }
  );
});

test("fetches OpenCode's catalog when its cache is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "missing-opencode-models-"));
  const previous = process.env.OPENCODE_MODELS_PATH;
  process.env.OPENCODE_MODELS_PATH = join(directory, "models.json");
  let requested;
  globalThis.fetch = async (url) => {
    requested = url;
    return Response.json({
      openai: { models: { "gpt-6-sol": { cost: { input: 4, output: 12 } } } },
    });
  };
  try {
    const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });
    const models = await plugin.provider.models(
      { models: { "gpt-6-sol": { cost: { input: 0, output: 0 } } } },
      { auth: { type: "oauth" } }
    );
    assert.equal(requested, "https://models.opencode.ai/api.json");
    assert.equal(models["gpt-6-sol"].cost.input, 4);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_MODELS_PATH;
    else process.env.OPENCODE_MODELS_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps OAuth models available at zero cost when neither catalog source is available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "missing-opencode-models-"));
  const previousPath = process.env.OPENCODE_MODELS_PATH;
  const previousFetch = globalThis.fetch;
  const previousWarn = console.warn;
  process.env.OPENCODE_MODELS_PATH = join(directory, "models.json");
  globalThis.fetch = async () => {
    throw new Error("catalog offline");
  };
  console.warn = () => undefined;
  try {
    const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });
    const models = await plugin.provider.models(
      { models: { "gpt-6-sol": { cost: { input: 0, output: 0 } } } },
      { auth: { type: "oauth" } }
    );
    assert.equal(models["gpt-6-sol"].cost.input, 0);
    assert.equal(models["gpt-5.3-codex"].cost.input, 0);
  } finally {
    if (previousPath === undefined) delete process.env.OPENCODE_MODELS_PATH;
    else process.env.OPENCODE_MODELS_PATH = previousPath;
    globalThis.fetch = previousFetch;
    console.warn = previousWarn;
    await rm(directory, { recursive: true, force: true });
  }
});
