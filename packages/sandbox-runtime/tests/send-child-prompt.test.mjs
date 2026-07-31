import assert from "node:assert/strict";
import test from "node:test";

process.env.CONTROL_PLANE_URL = "https://control.test";
process.env.SANDBOX_AUTH_TOKEN = "parent-token";
process.env.SESSION_CONFIG = JSON.stringify({ sessionId: "parent-1" });

const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  return Response.json({ messageId: "message-1", status: "queued" });
};

const { executeSendChildPrompt } =
  await import("../src/sandbox_runtime/tools/_send-child-prompt.js");

test("send-child-prompt queues content through the parent-scoped child route", async () => {
  const output = await executeSendChildPrompt({
    childId: "child/with spaces",
    prompt: "Continue with the edge cases",
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://control.test/sessions/parent-1/children/child%2Fwith%20spaces/prompt"
  );
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    content: "Continue with the edge cases",
  });
  assert.match(output, /message-1/);
  assert.match(output, /durably queued/i);
});

for (const [status, error, expected] of [
  [404, "Child session not found", /not found/i],
  [409, "Cannot prompt a cancelled session", /cannot prompt/i],
  [429, "Child prompt queue is full", /cannot queue another prompt/i],
]) {
  test(`send-child-prompt explains HTTP ${status} failures`, async () => {
    globalThis.fetch = async () => Response.json({ error }, { status });

    const output = await executeSendChildPrompt({ childId: "child-1", prompt: "Continue" });

    assert.match(output, expected);
    if (status !== 404) assert.match(output, new RegExp(error, "i"));
  });
}

test("send-child-prompt reports transport failures", async () => {
  globalThis.fetch = async () => {
    throw new Error("network unavailable");
  };

  const output = await executeSendChildPrompt({ childId: "child-1", prompt: "Continue" });

  assert.match(output, /network unavailable/);
});
