import assert from "node:assert/strict";
import test from "node:test";

import { createProviderTokenBroker } from "../src/sandbox_runtime/plugins/provider-token-broker.js";

function configureSession() {
  delete process.env.PROVIDER_ACCOUNT_SWITCH_IDENTITY;
  process.env.CONTROL_PLANE_URL = "https://control.test";
  process.env.SANDBOX_AUTH_TOKEN = "sandbox-token";
  process.env.SESSION_CONFIG = JSON.stringify({ sessionId: "session-1" });
}

test("uses the generic broker route, validates the response, and caches fresh tokens", async () => {
  configureSession();
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return Response.json({ accessToken: "access-1", expiresIn: 3600 });
  };
  const broker = createProviderTokenBroker({ provider: "openai", providerLabel: "OpenAI" });

  const first = await broker.getAccessToken();
  const second = await broker.getAccessToken();

  assert.equal(first.accessToken, "access-1");
  assert.equal(second.accessToken, "access-1");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://control.test/sessions/session-1/provider-auth/openai/access-token"
  );
  assert.equal(requests[0].init.headers.Authorization, "Bearer sandbox-token");
  assert.ok(requests[0].init.signal instanceof AbortSignal);
});

test("bootstraps a switched binding once and refuses wrong-generation credentials", async () => {
  configureSession();
  const binding = {
    bindingRevision: 2,
    providerAccountId: "account-b",
    generation: { sandboxId: "sandbox", createdAt: 100 },
  };
  const requests = [];
  let wrongGeneration = true;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/binding")) return Response.json(binding);
    if (!init.headers["x-provider-binding-revision"])
      return Response.json({ error: "stale_provider_binding" }, { status: 409 });
    return Response.json({
      ...binding,
      accessToken: "access-b",
      expiresIn: 3600,
      generation: { ...binding.generation, createdAt: wrongGeneration ? 99 : 100 },
    });
  };
  const broker = createProviderTokenBroker({ provider: "openai", providerLabel: "OpenAI" });
  await assert.rejects(broker.getAccessToken(), /Stale provider credential response/);
  wrongGeneration = false;
  assert.equal((await broker.getAccessToken()).accessToken, "access-b");
  assert.equal(requests.filter(({ url }) => url.endsWith("/binding")).length, 1);
  assert.equal(requests.at(-1).init.headers["x-provider-binding-revision"], "2");
});

test("a switched plugin rejects a stale revision without installing or proving it", async () => {
  configureSession();
  const identity = {
    operationId: "switch-test",
    provider: "openai",
    bindingRevision: 3,
    generation: { sandboxId: "sandbox", createdAt: 100 },
    conversationId: "conversation",
  };
  process.env.PROVIDER_ACCOUNT_SWITCH_IDENTITY = JSON.stringify(identity);
  globalThis.fetch = async () =>
    Response.json({
      accessToken: "stale",
      expiresIn: 3600,
      bindingRevision: 2,
      generation: identity.generation,
    });
  const broker = createProviderTokenBroker({ provider: "openai", providerLabel: "OpenAI" });
  let installs = 0;
  await assert.rejects(
    broker.getAccessToken(() => {
      installs++;
    }),
    /Stale provider credential response/
  );
  assert.equal(installs, 0);
  delete process.env.PROVIDER_ACCOUNT_SWITCH_IDENTITY;
});

test("deduplicates concurrent refreshes", async () => {
  configureSession();
  let resolveResponse;
  let requestCount = 0;
  globalThis.fetch = () => {
    requestCount++;
    return new Promise((resolve) => {
      resolveResponse = resolve;
    });
  };
  const broker = createProviderTokenBroker({ provider: "xai", providerLabel: "xAI" });

  const first = broker.getAccessToken();
  const second = broker.getAccessToken();
  assert.equal(requestCount, 1);
  resolveResponse(Response.json({ accessToken: "shared", expiresIn: 3600 }));

  assert.deepEqual(
    (await Promise.all([first, second])).map(({ accessToken }) => accessToken),
    ["shared", "shared"]
  );
});

test("clears a failed in-flight refresh so a later request can retry", async () => {
  configureSession();
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    return requestCount === 1
      ? Response.json({ accessToken: "" })
      : Response.json({ accessToken: "recovered", expiresIn: 3600 });
  };
  const broker = createProviderTokenBroker({ provider: "xai", providerLabel: "xAI" });

  await assert.rejects(broker.getAccessToken(), /Invalid xAI token broker response/);
  assert.equal((await broker.getAccessToken()).accessToken, "recovered");
  assert.equal(requestCount, 2);
});
