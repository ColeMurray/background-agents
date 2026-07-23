import { describe, expect, it, vi } from "vitest";
import { callbacksRouter } from "./callbacks";
import { createStartCallbackRouter } from "./callbacks/start-callback";
import { computeHmacHex } from "./utils/crypto";
import { createFakeKV, makeExecutionContext, makeLinearBotEnv } from "./test-helpers";
import type { LinearApiClient } from "./utils/linear-client";

const NOW = 1_700_000_000_000;
const SECRET = "callback-secret";

const client: LinearApiClient = {
  accessToken: "token",
  organizationId: "org-1",
  renewAccessToken: vi.fn(async () => "renewed-token"),
};

async function signedPayload(overrides: Record<string, unknown> = {}) {
  const data = {
    sessionId: "session-1",
    messageId: "message-1",
    timestamp: NOW,
    context: {
      source: "linear",
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueUrl: "https://linear.app/acme/issue/ENG-1",
      model: "anthropic/claude-haiku-4-5",
      organizationId: "org-1",
      appUserId: "app-user-1",
      transitionIssueOnStart: true,
    },
    ...overrides,
  };
  return { ...data, signature: await computeHmacHex(JSON.stringify(data), SECRET) };
}

async function postStart(
  router: { fetch: typeof callbacksRouter.fetch },
  payload: unknown = signedPayload()
): Promise<Response> {
  const { kv } = createFakeKV();
  return router.fetch(
    new Request("http://localhost/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await payload),
    }),
    makeLinearBotEnv(kv, { INTERNAL_CALLBACK_SECRET: SECRET }),
    makeExecutionContext()
  );
}

describe("POST /start", () => {
  it("transitions an eligible issue before acknowledging the callback", async () => {
    const getLinearClient = vi.fn(async () => client);
    const transitionIssueToStarted = vi.fn(async () => ({
      outcome: "transitioned" as const,
      previousStateType: "unstarted",
      stateId: "started-1",
      stateName: "In Progress",
    }));
    const router = createStartCallbackRouter({
      getLinearClient,
      transitionIssueToStarted,
      now: () => NOW,
    });
    const response = await postStart(router);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: "transitioned" });
    expect(getLinearClient).toHaveBeenCalledWith(expect.anything(), "org-1", "app-user-1");
    expect(transitionIssueToStarted).toHaveBeenCalledWith(client, "issue-1");
  });

  it("rejects malformed JSON", async () => {
    const { kv } = createFakeKV();

    const response = await callbacksRouter.fetch(
      new Request("http://localhost/start", { method: "POST", body: "{not-json" }),
      makeLinearBotEnv(kv, { INTERNAL_CALLBACK_SECRET: SECRET }),
      makeExecutionContext()
    );

    expect(response.status).toBe(400);
  });

  it("rejects a callback with an invalid signature", async () => {
    const router = createStartCallbackRouter({
      getLinearClient: vi.fn(),
      transitionIssueToStarted: vi.fn(),
      now: () => NOW,
    });
    const payload = { ...(await signedPayload()), signature: "invalid" };
    const response = await postStart(router, payload);

    expect(response.status).toBe(401);
  });

  it("acknowledges an expired callback without changing the issue", async () => {
    const transitionIssueToStarted = vi.fn();
    const router = createStartCallbackRouter({
      getLinearClient: vi.fn(),
      transitionIssueToStarted,
      now: () => NOW,
    });
    const response = await postStart(router, signedPayload({ timestamp: NOW - 10 * 60 * 1000 }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: "stale_callback" });
    expect(transitionIssueToStarted).not.toHaveBeenCalled();
  });

  it("returns a retryable error when Linear cannot update the issue", async () => {
    const router = createStartCallbackRouter({
      getLinearClient: vi.fn(async () => client),
      transitionIssueToStarted: vi.fn(async () => {
        throw new Error("Linear unavailable");
      }),
      now: () => NOW,
    });
    const response = await postStart(router);

    expect(response.status).toBe(502);
  });

  it("acknowledges a message that did not opt into the transition", async () => {
    const getLinearClient = vi.fn();
    const transitionIssueToStarted = vi.fn();
    const router = createStartCallbackRouter({
      getLinearClient,
      transitionIssueToStarted,
      now: () => NOW,
    });
    const base = await signedPayload();
    const context = { ...base.context, transitionIssueOnStart: false };
    const response = await postStart(router, signedPayload({ context }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: "not_eligible" });
    expect(getLinearClient).not.toHaveBeenCalled();
    expect(transitionIssueToStarted).not.toHaveBeenCalled();
  });

  it("returns a retryable error when Linear credentials are unavailable", async () => {
    const router = createStartCallbackRouter({
      getLinearClient: vi.fn(async () => null),
      transitionIssueToStarted: vi.fn(),
      now: () => NOW,
    });
    const response = await postStart(router);

    expect(response.status).toBe(503);
  });

  it("maps credential lookup failures to an authentication retry", async () => {
    const router = createStartCallbackRouter({
      getLinearClient: vi.fn(async () => {
        throw new Error("credential service unavailable");
      }),
      transitionIssueToStarted: vi.fn(),
      now: () => NOW,
    });
    const response = await postStart(router);

    expect(response.status).toBe(503);
  });

  it("rejects malformed identity fields before credential lookup", async () => {
    const getLinearClient = vi.fn();
    const router = createStartCallbackRouter({
      getLinearClient,
      transitionIssueToStarted: vi.fn(),
      now: () => NOW,
    });
    const base = await signedPayload();
    const context = { ...base.context, appUserId: 42 };
    const response = await postStart(router, signedPayload({ context }));

    expect(response.status).toBe(400);
    expect(getLinearClient).not.toHaveBeenCalled();
  });

  it("rejects callback context fields outside the shared contract", async () => {
    const router = createStartCallbackRouter({
      getLinearClient: vi.fn(),
      transitionIssueToStarted: vi.fn(),
      now: () => NOW,
    });
    const base = await signedPayload();
    const context = { ...base.context, unexpectedPolicy: true };

    const response = await postStart(router, signedPayload({ context }));

    expect(response.status).toBe(400);
  });
});
