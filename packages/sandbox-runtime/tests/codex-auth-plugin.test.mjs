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
function stubFetch({ codex, broker, usage, platform } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({
      url: target,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: init?.body,
      signal: init?.signal,
    });
    if (target.includes("/provider-auth/openai/access-token")) {
      return (
        broker?.() ??
        Response.json({
          accessToken: "cp-access",
          expiresIn: 3600,
          providerMetadata: { accountId: "acct-1" },
        })
      );
    }
    if (target.includes("/wham/usage")) {
      return usage?.(init) ?? new Response("no usage stub", { status: 404 });
    }
    if (target.startsWith("https://chatgpt.com/")) return codex(calls.length);
    return platform?.(target, init) ?? new Response("platform-ok", { status: 200 });
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

test("retries the subscription after a failed platform spillover", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  let platformCalls = 0;
  const calls = stubFetch({
    codex: () => usageLimitResponse(),
    platform: () =>
      ++platformCalls === 1
        ? new Response("platform unavailable", { status: 503 })
        : new Response("platform-ok", { status: 200 }),
  });
  const loaded = await loadProxy("fallback-failure");

  assert.equal((await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).status, 503);
  const before = calls.length;
  assert.equal((await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).status, 200);
  assert.ok(
    calls.slice(before).some((call) => call.url.startsWith("https://chatgpt.com/")),
    "the subscription is retried after a failed platform request"
  );
});

test("keeps the Chat Completions contract when spilling over", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("chat-completions");

  const chatUrl = "https://api.openai.com/v1/chat/completions";
  const chatInit = {
    ...REQUEST_INIT,
    body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }),
  };
  const response = await loaded.fetch(chatUrl, chatInit);
  assert.equal(response.status, 200);

  // A Chat Completions body is not a Responses body, so the spillover must not
  // rewrite the path to /v1/responses.
  const spilloverCall = calls.at(-1);
  assert.equal(spilloverCall.url, chatUrl);
  assert.equal(spilloverCall.headers.get("authorization"), "Bearer sk-fallback");
  assert.equal(spilloverCall.body, chatInit.body);
});

test("maps a subscription-only Spark model to its platform fallback", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("spark-model");
  const sparkInit = {
    ...REQUEST_INIT,
    body: JSON.stringify({ model: "gpt-5.3-codex-spark", input: "hi" }),
  };

  const response = await loaded.fetch(MODEL_REQUEST_URL, sparkInit);

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(calls.at(-1).body).model, "gpt-5.3-codex");
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

test("does not treat generic quota wording as subscription exhaustion", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("temporary quota throttle", { status: 429 }),
  });
  const loaded = await loadProxy("quota-wording");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);

  assert.equal(response.status, 429);
  assert.equal(await response.text(), "temporary quota throttle");
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
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
    broker: () => new Response("reconnect required", { status: 409 }),
  });
  const loaded = await loadProxy("broker-down");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await response.text(), "platform-ok");
  assert.equal(calls.filter((call) => call.url.startsWith("https://chatgpt.com/")).length, 0);
  assert.equal(calls.at(-1).headers.get("authorization"), "Bearer sk-fallback");
});

test("does not spend the fallback key on a transient broker failure", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () => new Response("temporarily unavailable", { status: 503 }),
  });
  const loaded = await loadProxy("broker-transient");

  await assert.rejects(
    loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT),
    /OpenAI token refresh failed \(503\)/
  );
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("does not spend the fallback key when sandbox authentication is rejected", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () => new Response("invalid sandbox token", { status: 401 }),
  });
  const loaded = await loadProxy("broker-sandbox-auth");

  await assert.rejects(
    loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT),
    /OpenAI token refresh failed \(401\)/
  );
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("keeps a Request-shaped call intact when the subscription token fails", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () => new Response("reconnect required", { status: 409 }),
  });
  const loaded = await loadProxy("request-input-token");

  // A Request carries its own method and body; an absent init must not turn the
  // spillover retry into a bodiless GET.
  const response = await loaded.fetch(new Request(MODEL_REQUEST_URL, REQUEST_INIT));
  assert.equal(await response.text(), "platform-ok");

  const spilloverCall = calls.at(-1);
  assert.equal(spilloverCall.url, MODEL_REQUEST_URL);
  assert.equal(spilloverCall.method, "POST");
  assert.equal(spilloverCall.body, REQUEST_INIT.body);
  assert.equal(spilloverCall.headers.get("authorization"), "Bearer sk-fallback");
});

test("spills over a Request-shaped call on a usage-limit 429", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("request-input-429");

  const response = await loaded.fetch(new Request(MODEL_REQUEST_URL, REQUEST_INIT));
  assert.equal(await response.text(), "platform-ok");

  const subscriptionCall = calls.find((call) => call.url.startsWith("https://chatgpt.com/"));
  assert.equal(subscriptionCall.method, "POST");
  assert.equal(subscriptionCall.body, REQUEST_INIT.body);

  // Retrying a 429 needs the body in hand, which a live Request stream cannot give.
  const spilloverCall = calls.at(-1);
  assert.equal(spilloverCall.url, MODEL_REQUEST_URL);
  assert.equal(spilloverCall.body, REQUEST_INIT.body);
  assert.equal(spilloverCall.headers.get("authorization"), "Bearer sk-fallback");
});

test("forwards a Request's abort signal to both legs", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("request-input-signal");

  const controller = new AbortController();
  const request = new Request(MODEL_REQUEST_URL, { ...REQUEST_INIT, signal: controller.signal });
  await loaded.fetch(request);

  // `new Request(url, { signal })` exposes a dependent signal rather than the
  // one passed in, so cancellation, not identity, is what must survive.
  const subscriptionCall = calls.find((call) => call.url.startsWith("https://chatgpt.com/"));
  const spilloverCall = calls.at(-1);
  assert.ok(subscriptionCall.signal, "subscription call carries a signal");
  assert.ok(spilloverCall.signal, "spillover call carries a signal");
  assert.equal(subscriptionCall.signal.aborted, false);
  controller.abort();
  assert.equal(subscriptionCall.signal.aborted, true);
  assert.equal(spilloverCall.signal.aborted, true);
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

test("abandons a usage probe still in flight when the caller aborts", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";

  // A probe that only settles on cancellation: without the caller's signal it
  // would hang until USAGE_PROBE_TIMEOUT_MS, which is exactly the wait under test.
  let probeStarted;
  const probeSignal = new Promise((resolve) => (probeStarted = resolve));
  stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    usage: (init) =>
      new Promise((_, reject) => {
        probeStarted(init.signal);
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      }),
  });
  const loaded = await loadProxy("probe-abort");

  const controller = new AbortController();
  const request = new Request(MODEL_REQUEST_URL, { ...REQUEST_INIT, signal: controller.signal });
  const pending = loaded.fetch(request);

  const signal = await probeSignal;
  assert.equal(signal.aborted, false, "the probe is in flight");
  controller.abort();

  let stall;
  const outcome = await Promise.race([
    pending.then(
      () => "settled",
      () => "settled"
    ),
    new Promise((resolve) => (stall = setTimeout(() => resolve("blocked"), 500))),
  ]);
  clearTimeout(stall);
  assert.equal(signal.aborted, true);
  assert.equal(outcome, "settled", "the turn does not wait out the probe timeout");
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

test("rejects a partially numeric ceiling", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80garbage";
  const calls = stubFetch({
    codex: () =>
      new Response("codex-ok", {
        status: 200,
        headers: { "x-codex-secondary-used-percent": "85" },
      }),
    usage: () => usageResponse(85, 85),
  });
  const loaded = await loadProxy("ceiling-suffix");

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
