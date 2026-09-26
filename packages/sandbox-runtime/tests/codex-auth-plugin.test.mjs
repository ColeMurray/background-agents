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
    // A non-generation call is dispatched as a Request so its own options
    // survive, so the stub must read either shape.
    const request = url instanceof Request ? url : null;
    const target = request ? request.url : String(url);
    calls.push({
      url: target,
      method: init?.method ?? request?.method,
      headers: new Headers(init?.headers ?? request?.headers),
      body: init?.body,
      signal: init?.signal ?? request?.signal,
      init: init ?? {},
      request,
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
    broker: () =>
      Response.json({ error: "reconnect required", code: "reconnect_required" }, { status: 409 }),
  });
  const loaded = await loadProxy("broker-down");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await response.text(), "platform-ok");
  assert.equal(calls.filter((call) => call.url.startsWith("https://chatgpt.com/")).length, 0);
  assert.equal(calls.at(-1).headers.get("authorization"), "Bearer sk-fallback");
});

test("spills over when the bound provider account is gone", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  // This one answers 404 rather than 409, and no retry can bring the account
  // back, so it belongs on the permanent side with the reconnect cases.
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () =>
      Response.json(
        { error: "Provider account not found", code: "account_not_found" },
        { status: 404 }
      ),
  });
  const loaded = await loadProxy("broker-account-gone");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await response.text(), "platform-ok");
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

test("does not spend the fallback key on transient exchange contention", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  // The control plane answers 409 for a credential that needs reconnection and
  // for exchange contention alike, so only its own code separates them.
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () =>
      Response.json(
        { error: "openai credential exchange did not complete", code: "exchange_busy" },
        { status: 409 }
      ),
  });
  const loaded = await loadProxy("broker-exchange-busy");

  await assert.rejects(
    loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT),
    /OpenAI token refresh failed \(409\)/
  );
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("does not spend the fallback key on a 409 that carries no code", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () => new Response("conflict", { status: 409 }),
  });
  const loaded = await loadProxy("broker-409-no-code");

  await assert.rejects(
    loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT),
    /OpenAI token refresh failed \(409\)/
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
    broker: () =>
      Response.json({ error: "reconnect required", code: "reconnect_required" }, { status: 409 }),
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

test("stops waiting on the ceiling probe when the caller aborts", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";

  // The probe is shared, so the caller's signal is deliberately not forwarded
  // into it. A cancelled turn must therefore stop waiting on its own rather
  // than hang until USAGE_PROBE_TIMEOUT_MS.
  let probeStarted;
  const probeReached = new Promise((resolve) => (probeStarted = resolve));
  stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    usage: () =>
      new Promise(() => {
        probeStarted();
      }),
  });
  const loaded = await loadProxy("probe-abort");

  const controller = new AbortController();
  const request = new Request(MODEL_REQUEST_URL, { ...REQUEST_INIT, signal: controller.signal });
  const pending = loaded.fetch(request);

  await probeReached;
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
  assert.equal(outcome, "settled", "the turn does not wait out the probe timeout");
});

test("holds a concurrent request behind the pending ceiling probe", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";

  // The preflight only counts as spent once it answers. A second request
  // arriving while it is in flight must wait for the same answer instead of
  // spending a subscription turn above the ceiling being measured.
  let releaseProbe;
  let probeStarted;
  const probeReached = new Promise((resolve) => (probeStarted = resolve));
  const calls = stubFetch({
    codex: () => new Response("codex-should-not-be-called", { status: 200 }),
    usage: () =>
      new Promise((resolve) => {
        probeStarted();
        releaseProbe = () => resolve(usageResponse(42, 85));
      }),
  });
  const loaded = await loadProxy("probe-shared");

  const first = loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  await probeReached;
  const second = loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    calls.filter((call) => call.url.includes("/codex/responses")).length,
    0,
    "no turn is spent while the ceiling is still unknown"
  );

  releaseProbe();
  assert.equal(await (await first).text(), "platform-ok");
  assert.equal(await (await second).text(), "platform-ok");
  assert.equal(
    calls.filter((call) => call.url.includes("/wham/usage")).length,
    1,
    "both requests share one probe"
  );
  assert.equal(calls.filter((call) => call.url.includes("/codex/responses")).length, 0);
});

test("keeps a measurement whose only waiter walked away", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";

  let releaseProbe;
  let probeStarted;
  const probeReached = new Promise((resolve) => (probeStarted = resolve));
  const calls = stubFetch({
    codex: () => new Response("codex-should-not-be-called", { status: 200 }),
    usage: () =>
      new Promise((resolve) => {
        probeStarted();
        releaseProbe = () => resolve(usageResponse(42, 85));
      }),
  });
  const loaded = await loadProxy("probe-result-retained");

  const controller = new AbortController();
  const abandoned = loaded.fetch(
    new Request(MODEL_REQUEST_URL, { ...REQUEST_INIT, signal: controller.signal })
  );
  await probeReached;
  controller.abort();
  await abandoned.catch(() => {});

  // The probe answers after its only waiter gave up. Discarding that 85%
  // would send the next request over the 80% ceiling.
  releaseProbe();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const before = calls.length;
  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await response.text(), "platform-ok");
  assert.equal(
    calls.slice(before).filter((call) => call.url.includes("/codex/responses")).length,
    0,
    "no subscription turn is spent above the measured ceiling"
  );
  assert.equal(
    calls.slice(before).filter((call) => call.url.includes("/wham/usage")).length,
    0,
    "the retained measurement is reused rather than re-probed"
  );
});

test("retries the subscription after a fallback chosen by the preflight fails", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  let platformOk = false;
  const calls = stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    usage: () => usageResponse(42, 85),
    platform: () =>
      platformOk
        ? new Response("platform-ok", { status: 200 })
        : new Response("platform down", { status: 503 }),
  });
  const loaded = await loadProxy("preflight-fallback-recovery");

  const first = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(first.status, 503, "the preflight sent this turn to a failing platform");

  // Clearing only the latch is not enough: the retained 85% measurement would
  // pick the platform again and never give the subscription a turn.
  platformOk = true;
  const before = calls.length;
  const second = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await second.text(), "codex-ok");
  assert.equal(
    calls.slice(before).filter((call) => call.url.startsWith("https://chatgpt.com/")).length,
    1,
    "the subscription is retried"
  );
});

test("inherits the source body when an init passes a null body", async () => {
  delete process.env.OPENAI_API_KEY_FALLBACK;
  const calls = stubFetch({ codex: () => new Response("codex-ok", { status: 200 }) });
  const loaded = await loadProxy("null-body-override");

  // native new Request(source, { body: null }) inherits the source body, so a
  // null must not turn a valid POST into a bodiless call.
  await loaded.fetch(new Request(MODEL_REQUEST_URL, REQUEST_INIT), { body: null });

  const call = calls.find((entry) => entry.url.startsWith("https://chatgpt.com/"));
  assert.equal(call.body, REQUEST_INIT.body, "the source body reaches the subscription");
});

test("ignores init members whose value is undefined", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("undefined-init-members");

  // The shape an object spread produces: keys present, values undefined.
  // Request construction ignores those, so they must not erase the source's.
  const request = new Request(MODEL_REQUEST_URL, {
    ...REQUEST_INIT,
    redirect: "manual",
    credentials: "include",
    cache: "no-store",
  });
  await loaded.fetch(request, {
    redirect: undefined,
    credentials: undefined,
    cache: undefined,
  });

  for (const call of [
    calls.find((entry) => entry.url.startsWith("https://chatgpt.com/")),
    calls.at(-1),
  ]) {
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.credentials, "include");
    assert.equal(call.init.cache, "no-store");
  }
});

test("re-measures the ceiling after a recovered turn", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  let platformOk = false;
  const calls = stubFetch({
    // Header-less Codex replies, so the ceiling can only be enforced by the
    // preflight: if the recovery leaves it spent, it is off for good.
    codex: () => new Response("codex-ok", { status: 200 }),
    usage: () => usageResponse(42, 95),
    platform: () =>
      platformOk
        ? new Response("platform-ok", { status: 200 })
        : new Response("platform down", { status: 503 }),
  });
  const loaded = await loadProxy("ceiling-rearm");

  assert.equal((await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).status, 503);

  // Exactly one turn is allowed past the ceiling, to find out whether the
  // subscription answers at all.
  platformOk = true;
  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");

  const before = calls.length;
  const third = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await third.text(), "platform-ok");
  assert.equal(
    calls.slice(before).filter((call) => call.url.includes("/wham/usage")).length,
    1,
    "the ceiling is measured again"
  );
  assert.equal(
    calls.slice(before).filter((call) => call.url.includes("/codex/responses")).length,
    0,
    "95% against an 80% ceiling still reserves the window"
  );
});

test("a late fallback failure does not undo a newer successful latch", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";

  // Two requests share one 85% preflight against an 80% ceiling, so both go
  // straight to the platform. The first succeeds and latches; the second fails
  // afterwards and must not send the next turn back to a subscription the
  // first one is already standing in for.
  let platformCall = 0;
  let releaseSecond;
  const secondReleased = new Promise((resolve) => (releaseSecond = resolve));
  const calls = stubFetch({
    codex: () => new Response("codex-should-not-be-called", { status: 200 }),
    usage: () => usageResponse(42, 85),
    platform: async () => {
      platformCall += 1;
      if (platformCall === 1) return new Response("platform-ok", { status: 200 });
      if (platformCall === 2) {
        await secondReleased;
        return new Response("platform down", { status: 503 });
      }
      return new Response("platform-ok", { status: 200 });
    },
  });
  const loaded = await loadProxy("late-failure-race");

  const first = loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  const second = loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await (await first).text(), "platform-ok", "the first fallback latches");
  releaseSecond();
  assert.equal((await second).status, 503);

  const before = calls.length;
  const third = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await third.text(), "platform-ok");
  assert.equal(
    calls.slice(before).filter((call) => call.url.includes("/codex/responses")).length,
    0,
    "the newer successful latch still holds"
  );
});

test("detaches from the source Request when the caller passes a null signal", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("null-signal-detach");

  // Native fetch(request, { signal: null }) detaches, so aborting the source
  // must not reach either reconstructed leg.
  const controller = new AbortController();
  const request = new Request(MODEL_REQUEST_URL, { ...REQUEST_INIT, signal: controller.signal });
  await loaded.fetch(request, { signal: null });
  controller.abort();

  for (const call of [
    calls.find((entry) => entry.url.startsWith("https://chatgpt.com/")),
    calls.at(-1),
  ]) {
    assert.equal(call.signal, undefined, "no signal is attached to the call");
  }
});

test("an init header set replaces the source Request's headers", async () => {
  delete process.env.OPENAI_API_KEY_FALLBACK;
  const calls = stubFetch({ codex: () => new Response("codex-ok", { status: 200 }) });
  const loaded = await loadProxy("header-replacement");

  // Native fetch(request, { headers }) replaces rather than merges, so a
  // caller dropping authorization must not have the Request's value survive.
  const request = new Request(MODEL_REQUEST_URL, {
    ...REQUEST_INIT,
    headers: { authorization: "Bearer caller-secret", "x-keep": "no" },
  });
  await loaded.fetch(request, { headers: { "x-replaced": "yes" } });

  const call = calls.find((entry) => entry.url.startsWith("https://chatgpt.com/"));
  assert.equal(call.headers.get("x-replaced"), "yes");
  assert.equal(call.headers.get("x-keep"), null, "the Request's headers are not merged in");
  assert.equal(
    call.headers.get("authorization"),
    "Bearer cp-access",
    "the subscription credential replaces the caller's, not the Request's"
  );
});

test("a Spark spillover drops entity headers that described the original body", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const body = JSON.stringify({ model: "gpt-5.3-codex-spark", input: "hi" });
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("spark-entity-headers");

  await loaded.fetch(MODEL_REQUEST_URL, {
    method: "POST",
    body,
    headers: {
      authorization: "Bearer opencode-oauth-dummy-key",
      "content-length": String(Buffer.byteLength(body)),
      "content-encoding": "identity",
    },
  });

  const spilloverCall = calls.at(-1);
  assert.equal(
    JSON.parse(spilloverCall.body).model,
    "gpt-5.3-codex",
    "Spark aliases to the platform model"
  );
  assert.notEqual(spilloverCall.body, body, "the body really was rewritten");
  assert.equal(
    spilloverCall.headers.get("content-length"),
    null,
    "a stale length would make the transport reject the fallback"
  );
  assert.equal(spilloverCall.headers.get("content-encoding"), null);
});

test("leaves a response-retrieval path on its own origin", async () => {
  delete process.env.OPENAI_API_KEY_FALLBACK;
  const calls = stubFetch({ codex: () => new Response("codex-ok", { status: 200 }) });
  const loaded = await loadProxy("retrieval-path");

  // Only the generation endpoints may be rewritten onto the Codex backend;
  // retrieving an earlier response must reach api.openai.com unchanged.
  const retrievalUrl = "https://api.openai.com/v1/responses/resp_123";
  await loaded.fetch(retrievalUrl, { method: "GET", headers: {} });
  assert.equal(calls.filter((call) => call.url.startsWith("https://chatgpt.com/")).length, 0);
  assert.equal(calls.at(-1).url, retrievalUrl);

  // A path that merely starts with the endpoint name is not this API at all.
  const lookalike = "https://api.openai.com/v1/chat/completionsXYZ";
  await loaded.fetch(lookalike, { method: "POST", body: "{}", headers: {} });
  assert.equal(calls.at(-1).url, lookalike);

  // A proxied base URL that prefixes the generation path is still rewritten.
  await loaded.fetch("https://gateway.test/openai/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5.4", input: "hi" }),
    headers: {},
  });
  assert.equal(calls.filter((call) => call.url.startsWith("https://chatgpt.com/")).length, 1);
});

test("a fallback that cannot be sent releases the latch", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  let platformReachable = true;
  const calls = stubFetch({
    codex: () => usageLimitResponse(),
    platform: () => {
      if (platformReachable) return new Response("platform-ok", { status: 200 });
      throw new TypeError("fetch failed");
    },
  });
  const loaded = await loadProxy("fallback-transport-reject");

  const latched = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await latched.text(), "platform-ok", "the sandbox is now latched");

  // A transport rejection never reaches a status check, so without releasing
  // the latch the sandbox would keep dialling a paid path that cannot answer.
  platformReachable = false;
  await assert.rejects(loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT), /fetch failed/);

  platformReachable = true;
  const before = calls.length;
  await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(
    calls.slice(before).filter((call) => call.url.startsWith("https://chatgpt.com/")).length,
    1,
    "the subscription is retried instead of the failing paid path"
  );
});

test("dispatches a non-generation Request without reshaping it", async () => {
  delete process.env.OPENAI_API_KEY_FALLBACK;
  const calls = stubFetch({ codex: () => new Response("codex-ok", { status: 200 }) });
  const loaded = await loadProxy("passthrough-request");

  // Flattening this would UTF-8-decode the body and drop Request-level
  // options, so the call would stop being equivalent to fetch(request).
  const body = new Uint8Array([0xff, 0x00, 0x10]);
  const request = new Request("https://api.openai.com/v1/files", {
    method: "POST",
    body,
    redirect: "manual",
    headers: { authorization: `Bearer ${"opencode-oauth-dummy-key"}`, "x-custom": "kept" },
  });
  await loaded.fetch(request);

  const call = calls.at(-1);
  assert.ok(call.request, "the original Request shape is dispatched");
  assert.equal(call.request.redirect, "manual", "Request-level options survive");
  assert.equal(call.request.headers.get("x-custom"), "kept");
  assert.equal(call.request.headers.get("authorization"), "Bearer cp-access");
  const sent = new Uint8Array(await call.request.arrayBuffer());
  assert.deepEqual([...sent], [...body], "the body bytes are untouched");
});

test("cancels a stalled streaming body when the caller aborts", async () => {
  delete process.env.OPENAI_API_KEY_FALLBACK;
  stubFetch({ codex: () => new Response("codex-ok", { status: 200 }) });
  const loaded = await loadProxy("stalled-body-abort");

  // A body that never completes must not keep the buffering await pending, and
  // settling alone is not enough: the producer has to be told to stop, or it
  // keeps being drained by a read nobody is waiting for any more.
  let cancelled;
  let pulled;
  const producerCancelled = new Promise((resolve) => (cancelled = resolve));
  const producerPulled = new Promise((resolve) => (pulled = resolve));
  const controller = new AbortController();
  const body = new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('{"model":"gpt-5.4","input":"'));
    },
    // Reached once the first chunk has been consumed, so the abort below
    // lands while the read loop is waiting rather than before it starts.
    pull() {
      pulled();
      return new Promise(() => {});
    },
    cancel() {
      cancelled();
    },
  });
  const request = new Request(MODEL_REQUEST_URL, {
    method: "POST",
    body,
    duplex: "half",
    signal: controller.signal,
  });
  const pending = loaded.fetch(request);

  await producerPulled;
  let stall;
  controller.abort();
  const outcome = await Promise.race([
    pending.then(
      () => "settled",
      () => "settled"
    ),
    new Promise((resolve) => (stall = setTimeout(() => resolve("blocked"), 500))),
  ]);
  clearTimeout(stall);
  assert.equal(outcome, "settled", "the turn does not hang on a body that never arrives");

  let cancelStall;
  const producerOutcome = await Promise.race([
    producerCancelled.then(() => "cancelled"),
    new Promise((resolve) => (cancelStall = setTimeout(() => resolve("still draining"), 500))),
  ]);
  clearTimeout(cancelStall);
  assert.equal(producerOutcome, "cancelled", "the stream producer is told to stop");
});

test("carries every Request-level option onto the reconstructed legs", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("request-option-carry");

  await loaded.fetch(
    new Request(MODEL_REQUEST_URL, {
      ...REQUEST_INIT,
      keepalive: true,
      referrer: "https://referrer.test/page",
      referrerPolicy: "origin",
      redirect: "manual",
    })
  );

  for (const call of [
    calls.find((entry) => entry.url.startsWith("https://chatgpt.com/")),
    calls.at(-1),
  ]) {
    assert.equal(call.init.keepalive, true);
    assert.equal(call.init.referrer, "https://referrer.test/page");
    assert.equal(call.init.referrerPolicy, "origin");
    assert.equal(call.init.redirect, "manual");
  }
});

test("never pairs a fresh token with an inherited account id", async () => {
  delete process.env.OPENAI_API_KEY_FALLBACK;
  const calls = stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    broker: () => Response.json({ accessToken: "cp-access", expiresIn: 3600 }),
  });
  const loaded = await loadProxy("stale-account-header");

  // The broker answered without an account id, so a copied header would send
  // this token against someone else's account.
  const headers = {
    authorization: "Bearer opencode-oauth-dummy-key",
    "chatgpt-account-id": "acct-stale",
  };
  await loaded.fetch(MODEL_REQUEST_URL, { ...REQUEST_INIT, headers });
  assert.equal(calls.at(-1).headers.get("chatgpt-account-id"), null);

  await loaded.fetch(new Request("https://api.openai.com/v1/files", { method: "GET", headers }));
  assert.equal(calls.at(-1).headers.get("chatgpt-account-id"), null);
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

test("preserves a source Request while proxying Codex authentication", async () => {
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
  const loaded = await loadProxy("preserve-request");

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
  const { CodexAuthProxy } = await import(`${PLUGIN_PATH}?case=switch-away`);
  const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });
  const loaded = await plugin.auth.loader(getAuth, { models: {} });

  await loaded.fetch(
    new Request("https://api.openai.com/v1/responses", {
      headers: { Authorization: "Bearer caller-token" },
    })
  );

  assert.equal(upstreamRequest.headers.get("authorization"), "Bearer caller-token");
});

test("keeps GPT-6 models available for Codex subscriptions", async () => {
  const gpt6Ids = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
  const gpt6Models = gpt6Ids.map((id) => [id, { name: id, cost: { input: 1, output: 1 } }]);
  const provider = { models: { ...Object.fromEntries(gpt6Models), "unsupported-model": {} } };
  const { CodexAuthProxy } = await import(`${PLUGIN_PATH}?case=gpt6-entitlement`);
  const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });

  await plugin.auth.loader(async () => ({ type: "oauth", refresh: "managed" }), provider);

  for (const [id, model] of gpt6Models) {
    assert.equal(provider.models[id], model, id);
    assert.equal(model.cost.input, 0, id);
    assert.equal(model.cost.output, 0, id);
  }
  assert.equal(provider.models["unsupported-model"], undefined);
});
