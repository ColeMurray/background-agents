import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext as HonoExecutionContext } from "hono";
import { computeHmacHex } from "@open-inspect/shared/auth";
import type { Env } from "../src/types";

vi.mock("../src/review-close-out", () => ({
  closeOutEndedReview: vi.fn().mockResolvedValue("closed_out"),
}));

import app from "../src/index";
import { closeOutEndedReview } from "../src/review-close-out";

const SECRET = "test-internal-secret";

function makeEnv(): Env {
  return {
    SERVICE_AUTH_SECRET: SECRET,
    LOG_LEVEL: "error",
  } as unknown as Env;
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn<HonoExecutionContext["waitUntil"]>(),
    passThroughOnException: vi.fn(),
  } as unknown as HonoExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

const completion = {
  sessionId: "session-1",
  messageId: "msg-1",
  success: false,
  error: "Execution timed out (stuck processing)",
  timestamp: 1_788_183_214_615,
  context: { source: "github", owner: "acme", repo: "widgets", prNumber: 42, headSha: "abc123" },
};

async function signed(data: object, secret = SECRET) {
  return { ...data, signature: await computeHmacHex(JSON.stringify(data), secret) };
}

function post(body: unknown, ctx = makeCtx()) {
  return {
    ctx,
    response: app.fetch(
      new Request("https://github-bot.test/callbacks/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      makeEnv(),
      ctx
    ),
  };
}

describe("POST /callbacks/complete", () => {
  beforeEach(() => {
    vi.mocked(closeOutEndedReview).mockClear();
  });

  it("acknowledges a signed review completion and closes the review out after responding", async () => {
    const { ctx, response } = post(await signed(completion));

    expect((await response).status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await ctx.waitUntil.mock.calls[0][0];
    expect(closeOutEndedReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ sessionId: "session-1", context: completion.context }),
      expect.any(String)
    );
  });

  it("rejects a completion signed with another key", async () => {
    const { response } = post(await signed(completion, "someone-elses-secret"));

    expect((await response).status).toBe(401);
    expect(closeOutEndedReview).not.toHaveBeenCalled();
  });

  it("rejects a signed body that is not a github review completion", async () => {
    const { response } = post(
      await signed({ ...completion, context: { source: "slack", channel: "C1" } })
    );

    expect((await response).status).toBe(400);
    expect(closeOutEndedReview).not.toHaveBeenCalled();
  });
});
