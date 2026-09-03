import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAuthProxy } from "../src/sandbox_runtime/plugins/anthropic-auth-plugin.js";

test("rewrites managed OAuth requests without losing Request semantics", async () => {
  process.env.CONTROL_PLANE_URL = "https://control.test";
  process.env.SANDBOX_AUTH_TOKEN = "sandbox-token";
  process.env.SESSION_CONFIG = JSON.stringify({ sessionId: "session-1" });

  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ input, init, url });
    if (url.includes("/provider-auth/anthropic/access-token")) {
      return Response.json({ accessToken: "anthropic-access", expiresIn: 3600 });
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"name":"mcp_'));
          controller.enqueue(new TextEncoder().encode('Read"}\n\n'));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  };

  const plugin = await AnthropicAuthProxy();
  const unmanaged = await plugin.auth.loader(
    async () => ({ type: "oauth", refresh: "not-managed" }),
    { models: {} }
  );
  assert.deepEqual(unmanaged, {});
  assert.deepEqual(plugin.auth.methods, []);

  const models = {
    sonnet: { cost: { input: 3, output: 15 } },
    opus: { cost: { input: 5, output: 25 } },
  };
  const auth = { type: "oauth", refresh: "managed-by-control-plane" };
  const managedModels = await plugin.provider.models({ models }, { auth });
  assert.deepEqual(managedModels.sonnet.cost, {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  });
  assert.deepEqual(managedModels.opus.cost, managedModels.sonnet.cost);
  assert.deepEqual(models.sonnet.cost, { input: 3, output: 15 });

  const apiModels = await plugin.provider.models(
    { models },
    { auth: { type: "api", key: "anthropic-key" } }
  );
  assert.equal(apiModels, models);

  const loaded = await plugin.auth.loader(async () => auth);

  const request = new Request("https://api.anthropic.com/v1/messages?existing=1", {
    method: "POST",
    body: JSON.stringify({
      system: "You are OpenCode.\n\nKeep this useful context.\n\nSee opencode.ai/docs.",
      messages: [{ role: "user", content: "please read this file" }],
      tools: [{ name: "read" }],
    }),
    headers: {
      "anthropic-beta": "existing-beta, oauth-2025-04-20",
      authorization: "Bearer dummy",
      "user-agent": "old-agent",
      "x-api-key": "request-key",
      "x-precedence": "request",
    },
  });
  const response = await loaded.fetch(request, {
    headers: {
      "anthropic-beta": "init-beta, interleaved-thinking-2025-05-14, init-beta",
      "x-api-key": "init-key",
      "x-precedence": "init",
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    "https://control.test/sessions/session-1/provider-auth/anthropic/access-token"
  );
  const providerCall = calls[1];
  assert.ok(providerCall.input instanceof Request);
  assert.equal(providerCall.input.method, "POST");
  const providerUrl = new URL(providerCall.url);
  assert.equal(providerUrl.pathname, "/v1/messages");
  assert.equal(providerUrl.searchParams.get("existing"), "1");
  assert.equal(providerUrl.searchParams.get("beta"), "true");

  const headers = new Headers(providerCall.init.headers);
  assert.equal(headers.get("authorization"), "Bearer anthropic-access");
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("user-agent"), "claude-cli/2.1.251 (external, cli)");
  assert.equal(headers.get("x-precedence"), "init");
  assert.deepEqual(headers.get("anthropic-beta").split(","), [
    "init-beta",
    "interleaved-thinking-2025-05-14",
    "oauth-2025-04-20",
  ]);

  const body = JSON.parse(providerCall.init.body);
  assert.match(body.system[0].text, /^x-anthropic-billing-header:/);
  assert.equal(
    body.system[1].text,
    "You are a Claude agent, built on Anthropic's Claude Agent SDK."
  );
  assert.equal(body.system[2].text, "Keep this useful context.");
  assert.equal(body.tools[0].name, "mcp_Read");
  assert.equal(await response.text(), 'data: {"name":"read"}\n\n');
});

async function loadManagedFetchWithResponse(responseBody, status) {
  process.env.CONTROL_PLANE_URL = "https://control.test";
  process.env.SANDBOX_AUTH_TOKEN = "sandbox-token";
  process.env.SESSION_CONFIG = JSON.stringify({ sessionId: "session-1" });

  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/provider-auth/anthropic/access-token")) {
      return Response.json({ accessToken: "anthropic-access", expiresIn: 3600 });
    }
    return new Response(responseBody, { status });
  };

  const plugin = await AnthropicAuthProxy();
  return plugin.auth.loader(async () => ({
    type: "oauth",
    refresh: "managed-by-control-plane",
  }));
}

test("makes Anthropic subscription account limits non-retryable", async () => {
  const errorBody = JSON.stringify({
    type: "error",
    error: {
      type: "rate_limit_error",
      message: "This request would exceed your account's rate limit. Please try again later.",
    },
  });
  const loaded = await loadManagedFetchWithResponse(errorBody, 429);

  const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "continue" }] }),
  });

  assert.equal(response.status, 400);
  assert.equal(response.statusText, "Account limit reached");
  assert.equal(await response.text(), errorBody);
});

test("leaves transient Anthropic rate limits retryable", async () => {
  const errorBody = JSON.stringify({
    type: "error",
    error: {
      type: "rate_limit_error",
      message: "Rate limit exceeded. Please retry shortly.",
    },
  });
  const loaded = await loadManagedFetchWithResponse(errorBody, 429);

  const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "continue" }] }),
  });

  assert.equal(response.status, 429);
  assert.equal(await response.text(), errorBody);
});
