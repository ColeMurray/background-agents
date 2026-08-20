import assert from "node:assert/strict";
import test from "node:test";

const PLUGIN_PATH = "../src/sandbox_runtime/plugins/codex-auth-plugin.js";
const MODEL_REQUEST_URL = "https://api.openai.com/v1/responses";
const REQUEST_INIT = {
  method: "POST",
  body: JSON.stringify({ model: "gpt-5.4", input: "hi" }),
  headers: { authorization: "Bearer opencode-oauth-dummy-key", originator: "opencode" },
};

process.env.CONTROL_PLANE_URL = "https://control.test";
process.env.SANDBOX_AUTH_TOKEN = "sandbox-token";
process.env.SESSION_CONFIG = JSON.stringify({ sessionId: "session-1" });
delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;

/**
 * Load a fresh copy of the plugin. The spillover latch is module state, so each
 * case needs its own instance.
 */
async function loadProxy(tag) {
  const { CodexAuthProxy } = await import(`${PLUGIN_PATH}?case=${tag}`);
  const plugin = await CodexAuthProxy({ client: { auth: { set: async () => {} } } });
  return plugin.auth.loader(async () => ({ type: "oauth", refresh: "managed-by-control-plane" }), {
    models: { "gpt-5.4": { cost: {} } },
  });
}

/**
 * Route stubbed traffic by path: the control-plane broker always mints a token
 * unless `broker` overrides it, the usage endpoint answers with `usage`, the
 * Codex backend with `codex`, and the platform API always succeeds.
 */
function stubFetch({ codex, broker, usage } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, headers: new Headers(init?.headers), body: init?.body });
    if (target.includes("/openai-token-refresh")) {
      return (
        broker?.() ??
        Response.json({ access_token: "cp-access", account_id: "acct-1", expires_in: 3600 })
      );
    }
    if (target.includes("/wham/usage")) {
      return usage?.() ?? new Response("no usage stub", { status: 404 });
    }
    if (target.startsWith("https://chatgpt.com/")) return codex(calls.length);
    return new Response("platform-ok", { status: 200 });
  };
  return calls;
}

const usageResponse = (primary, secondary) =>
  Response.json({
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: primary, limit_window_seconds: 18000, reset_at: 1 },
      secondary_window: { used_percent: secondary, limit_window_seconds: 604800, reset_at: 2 },
    },
  });

const usageLimitResponse = () =>
  new Response(JSON.stringify({ error: { message: "The usage limit has been reached" } }), {
    status: 429,
    headers: { "x-codex-rate-limit-reached-type": "secondary" },
  });

test("spills over to the platform API on a usage-limit 429, then latches", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("latch");

  const first = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "platform-ok");

  const subscriptionCall = calls.find((call) => call.url.startsWith("https://chatgpt.com/"));
  assert.equal(subscriptionCall.headers.get("authorization"), "Bearer cp-access");
  assert.equal(subscriptionCall.headers.get("chatgpt-account-id"), "acct-1");

  const spilloverCall = calls.at(-1);
  assert.equal(spilloverCall.url, MODEL_REQUEST_URL);
  assert.equal(spilloverCall.headers.get("authorization"), "Bearer sk-fallback");
  assert.equal(spilloverCall.headers.get("chatgpt-account-id"), null);
  assert.equal(spilloverCall.headers.get("originator"), null);
  assert.equal(spilloverCall.body, REQUEST_INIT.body);

  // Latched: the second turn must not retry the exhausted subscription.
  const before = calls.length;
  await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.deepEqual(
    calls.slice(before).map((call) => call.url),
    [MODEL_REQUEST_URL]
  );
});

test("passes a throttling 429 through without spending the fallback key", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("slow down", { status: 429 }),
  });
  const loaded = await loadProxy("throttle");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), "slow down");
  assert.equal(
    calls.filter((call) => call.url === MODEL_REQUEST_URL).length,
    0,
    "no platform-API call for a transient throttle"
  );
});

test("leaves a usage-limit 429 alone when no fallback key is configured", async () => {
  delete process.env.OPENAI_API_KEY_FALLBACK;
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("no-key");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(response.status, 429);
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("spills over when the control plane cannot mint a subscription token", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () => new Response("revoked", { status: 401 }),
  });
  const loaded = await loadProxy("broker-down");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await response.text(), "platform-ok");
  assert.equal(calls.filter((call) => call.url.startsWith("https://chatgpt.com/")).length, 0);
  assert.equal(calls.at(-1).headers.get("authorization"), "Bearer sk-fallback");
});

test("latches on exhausted usage headers reported by a successful call", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () =>
      new Response("codex-ok", {
        status: 200,
        headers: { "x-codex-secondary-used-percent": "100" },
      }),
  });
  const loaded = await loadProxy("headers");

  const first = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await first.text(), "codex-ok", "the in-flight call is never discarded");

  const before = calls.length;
  const second = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await second.text(), "platform-ok");
  assert.deepEqual(
    calls.slice(before).map((call) => call.url),
    [MODEL_REQUEST_URL]
  );
});

test("spills over before touching the subscription when usage is over the ceiling", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  const calls = stubFetch({
    codex: () => new Response("codex-should-not-be-called", { status: 200 }),
    usage: () => usageResponse(42, 85),
  });
  const loaded = await loadProxy("ceiling-over");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await response.text(), "platform-ok");

  const probe = calls.find((call) => call.url.includes("/wham/usage"));
  assert.equal(probe.headers.get("authorization"), "Bearer cp-access");
  assert.equal(probe.headers.get("chatgpt-account-id"), "acct-1");
  assert.equal(
    calls.filter((call) => call.url.includes("/codex/responses")).length,
    0,
    "no subscription turn is spent past the ceiling"
  );
});

test("keeps the subscription while usage is under the ceiling", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  const calls = stubFetch({
    codex: () =>
      new Response("codex-ok", {
        status: 200,
        headers: { "x-codex-secondary-used-percent": "50" },
      }),
    usage: () => usageResponse(40, 50),
  });
  const loaded = await loadProxy("ceiling-under");

  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  assert.equal(
    calls.filter((call) => call.url.includes("/wham/usage")).length,
    1,
    "the usage endpoint is probed once per sandbox"
  );
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("latches at the ceiling from a successful response's headers", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  const calls = stubFetch({
    codex: () =>
      new Response("codex-ok", {
        status: 200,
        headers: { "x-codex-primary-used-percent": "80.4" },
      }),
    usage: () => usageResponse(10, 10),
  });
  const loaded = await loadProxy("ceiling-headers");

  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  const before = calls.length;
  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "platform-ok");
  assert.deepEqual(
    calls.slice(before).map((call) => call.url),
    [MODEL_REQUEST_URL]
  );
});

test("ignores a malformed ceiling and spends the whole subscription", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "eighty";
  const calls = stubFetch({
    codex: () =>
      new Response("codex-ok", {
        status: 200,
        headers: { "x-codex-secondary-used-percent": "85" },
      }),
    usage: () => usageResponse(85, 85),
  });
  const loaded = await loadProxy("ceiling-invalid");

  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  assert.equal(calls.filter((call) => call.url.includes("/wham/usage")).length, 0);
  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
});

test("stays on the subscription when the usage probe fails", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  const calls = stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    usage: () => new Response("boom", { status: 500 }),
  });
  const loaded = await loadProxy("probe-failure");

  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  assert.equal(calls.filter((call) => call.url.includes("/codex/responses")).length, 1);
});
