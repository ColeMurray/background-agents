import { describe, expect, it } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { callbacksRouter } from "./callbacks";
import { createFakeKV, makeExecutionContext, makeLinearBotEnv } from "./test-helpers";

const SECRET = "callback-secret";

const validToolCall = {
  sessionId: "session-1",
  tool: "bash",
  args: { command: "npm test" },
  callId: "call-1",
  status: "running",
  timestamp: 1_700_000_000_000,
  context: {
    source: "linear",
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueUrl: "https://linear.app/acme/issue/ENG-1",
    model: "anthropic/claude-haiku-4-5",
  },
};

const validCompletion = {
  sessionId: "session-1",
  messageId: "message-1",
  success: true,
  timestamp: 1_700_000_000_000,
  context: validToolCall.context,
};

async function sign(payload: Record<string, unknown>) {
  return { ...payload, signature: await computeHmacHex(JSON.stringify(payload), SECRET) };
}

async function postToolCall(payload: unknown): Promise<Response> {
  const { kv } = createFakeKV();
  return callbacksRouter.fetch(
    new Request("http://localhost/tool_call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    makeLinearBotEnv(kv, { SERVICE_AUTH_SECRET: SECRET }),
    makeExecutionContext()
  );
}

async function postCompletion(payload: unknown): Promise<Response> {
  const { kv } = createFakeKV();
  return callbacksRouter.fetch(
    new Request("http://localhost/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    makeLinearBotEnv(kv, { SERVICE_AUTH_SECRET: SECRET }),
    makeExecutionContext()
  );
}

describe("POST /tool_call callback validation", () => {
  it("accepts a valid signed callback", async () => {
    const response = await postToolCall(await sign(validToolCall));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it.each(["args", "callId"])("rejects a callback missing %s", async (field) => {
    const payload = { ...validToolCall } as Record<string, unknown>;
    delete payload[field];

    const response = await postToolCall(await sign(payload));

    expect(response.status).toBe(400);
  });

  it("rejects malformed Linear context", async () => {
    const response = await postToolCall(
      await sign({ ...validToolCall, context: { source: "linear", issueId: "issue-1" } })
    );

    expect(response.status).toBe(400);
  });

  it("rejects an invalid signature", async () => {
    const response = await postToolCall({ ...validToolCall, signature: "invalid" });

    expect(response.status).toBe(401);
  });
});

describe("POST /complete callback validation", () => {
  it("accepts a valid signed callback", async () => {
    const response = await postCompletion(await sign(validCompletion));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects malformed Linear context", async () => {
    const response = await postCompletion(
      await sign({ ...validCompletion, context: { source: "linear", issueId: "issue-1" } })
    );

    expect(response.status).toBe(400);
  });
});
