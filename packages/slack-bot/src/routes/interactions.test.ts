import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { interactionRoutes } from "./interactions";
import { getTargetClarificationOptions, targetPickerBlockId } from "../target-clarification";
import { getPendingRequest } from "../pending-requests/pending-request-store";
import type { Env } from "../types";
import { makeExecutionContext } from "../test-helpers";
import { postMessage } from "@open-inspect/shared/slack";

vi.mock(import("@open-inspect/shared/slack"), async (original) => ({
  ...(await original()),
  verifySlackSignature: vi.fn(async () => true),
  postMessage: vi.fn(),
}));
vi.mock("../app-home", () => ({ handleAppHomeInteractionRoute: vi.fn(async () => null) }));
vi.mock("../pending-requests/pending-request-store", () => ({ getPendingRequest: vi.fn() }));
vi.mock(import("../target-clarification"), async (original) => ({
  ...(await original()),
  getTargetClarificationOptions: vi.fn(async () => ({ options: [] })),
}));

const requestId = "00000000-0000-4000-8000-000000000001";
const env = {
  SLACK_SIGNING_SECRET: "secret",
  SERVICE_AUTH_SECRET: "service-secret",
  CONTROL_PLANE: { fetch: vi.fn() },
} as unknown as Env;
async function suggest(fields: Record<string, unknown> = {}) {
  const app = new Hono<{ Bindings: Env }>().route("/", interactionRoutes);
  return app.fetch(
    new Request("https://bot/interactions", {
      method: "POST",
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: "block_suggestion",
          action_id: "select_repo",
          value: "app",
          user: { id: "U1" },
          channel: { id: "C1" },
          block_id: targetPickerBlockId(requestId),
          ...fields,
        }),
      }),
    }),
    env,
    makeExecutionContext()
  );
}

describe("scoped external target suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(env.CONTROL_PLANE.fetch).mockImplementation(async () =>
      Response.json({ teamId: "team-a", kind: "primary" })
    );
    vi.mocked(getPendingRequest).mockResolvedValue({
      requestId,
      channel: "C1",
      threadTs: "1.000001",
      userId: "U1",
      message: "Fix it",
      teamId: "team-a",
    });
  });

  it("recovers the scope from the payload block_id", async () => {
    expect((await suggest()).status).toBe(200);
    expect(getPendingRequest).toHaveBeenCalledWith(env, requestId);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/channel-bindings/slack/C1",
      expect.anything()
    );
    expect(getTargetClarificationOptions).toHaveBeenCalledWith(
      env,
      "app",
      expect.any(String),
      "team-a"
    );
  });

  it("permits an unchanged explicit workspace binding", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue({
      requestId,
      channel: "C1",
      threadTs: "1.000001",
      userId: "U1",
      message: "Fix it",
      teamId: null,
    });
    vi.mocked(env.CONTROL_PLANE.fetch).mockImplementation(async () =>
      Response.json({ teamId: null })
    );
    expect((await suggest()).status).toBe(200);
    expect(getTargetClarificationOptions).toHaveBeenCalledWith(
      env,
      "app",
      expect.any(String),
      null
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it.each(["changed-team", "workspace-fallback", "unbound", "failure", "malformed", "network"])(
    "returns empty suggestions without visible instructions when the binding is unavailable or changed: %s",
    async (failure) => {
      vi.mocked(env.CONTROL_PLANE.fetch).mockImplementation(async () => {
        if (failure === "network") throw new Error("CP offline");
        if (failure === "unbound" || failure === "failure")
          return new Response(null, { status: failure === "unbound" ? 404 : 503 });
        return Response.json(
          failure === "changed-team"
            ? { teamId: "team-b", kind: "primary" }
            : failure === "workspace-fallback"
              ? { teamId: null }
              : { invalid: true }
        );
      });
      expect(await (await suggest()).json()).toEqual({ options: [] });
      expect(getTargetClarificationOptions).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
    }
  );

  it("returns no suggestions for expired pending requests or KV failures", async () => {
    vi.mocked(getPendingRequest)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("KV unavailable"));
    expect(await (await suggest()).json()).toEqual({ options: [] });
    expect(await (await suggest()).json()).toEqual({ options: [] });
    expect(getTargetClarificationOptions).not.toHaveBeenCalled();
  });

  it.each([
    { block_id: undefined },
    { block_id: "malformed" },
    { user: { id: "other" } },
    { channel: { id: "other" } },
    { channel: undefined },
  ])("returns no suggestions when pending scope cannot be trusted: %s", async (fields) => {
    expect(await (await suggest(fields)).json()).toEqual({ options: [] });
    expect(getTargetClarificationOptions).not.toHaveBeenCalled();
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
  });
});
