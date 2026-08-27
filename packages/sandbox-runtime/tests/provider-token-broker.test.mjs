import assert from "node:assert/strict";
import test from "node:test";

import { createProviderTokenBroker } from "../src/sandbox_runtime/plugins/provider-token-broker.js";

function configureSession() {
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
