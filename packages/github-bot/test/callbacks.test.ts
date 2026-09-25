import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext as HonoExecutionContext } from "hono";
import { computeHmacHex } from "@open-inspect/shared/auth";
import type * as ReviewCloseOutModule from "../src/review-close-out";
import type { ReviewCloseOutGrant } from "../src/review-close-out";
import type { Env } from "../src/types";

vi.mock("../src/review-close-out", async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewCloseOutModule>()),
  requestCloseOut: vi.fn(),
  completeCloseOut: vi.fn().mockResolvedValue("closed_out"),
}));

import app from "../src/index";
import { completeCloseOut, requestCloseOut } from "../src/review-close-out";

const SECRET = "test-internal-secret";

const GRANT: ReviewCloseOutGrant = {
  outcome: "granted",
  sessionId: "session-1",
  owner: "acme",
  repo: "widgets",
  prNumber: 42,
  headSha: "abc123",
  description: "Review did not finish: Execution timed out (stuck processing)",
  superseded: false,
  leaseExpiresInMs: 120_000,
  requestedAt: 1_788_183_214_615,
};

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

function post(path: string, body: unknown, ctx = makeCtx()) {
  return {
    ctx,
    response: app.fetch(
      new Request(`https://github-bot.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      makeEnv(),
      ctx
    ),
  };
}

beforeEach(() => {
  vi.mocked(requestCloseOut).mockReset();
  vi.mocked(completeCloseOut).mockClear();
});

describe("POST /callbacks/complete", () => {
  it("records the ending, acknowledges, and writes the granted status after responding", async () => {
    vi.mocked(requestCloseOut).mockResolvedValue({ outcome: "granted", grant: GRANT });
    const { ctx, response } = post("/callbacks/complete", await signed(completion));

    expect((await response).status).toBe(200);
    expect(requestCloseOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "session-1",
      {
        owner: "acme",
        repo: "widgets",
        description: "Review did not finish: Execution timed out (stuck processing)",
      }
    );
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await ctx.waitUntil.mock.calls[0][0];
    expect(completeCloseOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      GRANT,
      expect.any(String)
    );
  });

  it("acknowledges a deferred close-out without touching GitHub", async () => {
    vi.mocked(requestCloseOut).mockResolvedValue({ outcome: "deferred" });
    const { ctx, response } = post("/callbacks/complete", await signed(completion));

    expect((await response).status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(completeCloseOut).not.toHaveBeenCalled();
  });

  it("answers 503 so the completion is redelivered when the control plane fails", async () => {
    vi.mocked(requestCloseOut).mockResolvedValue({ outcome: "request_failed", status: 500 });
    const { response } = post("/callbacks/complete", await signed(completion));

    expect((await response).status).toBe(503);
  });

  it("answers 503 when the control plane cannot be reached", async () => {
    vi.mocked(requestCloseOut).mockRejectedValue(new Error("network down"));
    const { response } = post("/callbacks/complete", await signed(completion));

    expect((await response).status).toBe(503);
  });

  it("rejects a completion signed with another key", async () => {
    const { response } = post(
      "/callbacks/complete",
      await signed(completion, "someone-elses-secret")
    );

    expect((await response).status).toBe(401);
    expect(requestCloseOut).not.toHaveBeenCalled();
  });

  it("rejects a signed body that is not a github review completion", async () => {
    const { response } = post(
      "/callbacks/complete",
      await signed({ ...completion, context: { source: "slack", channel: "C1" } })
    );

    expect((await response).status).toBe(400);
    expect(requestCloseOut).not.toHaveBeenCalled();
  });
});

describe("POST /callbacks/review-close-out", () => {
  const drive = { sessionId: "session-1", timestamp: 1_788_183_214_615 };

  it("retries an owed close-out without restating its request", async () => {
    vi.mocked(requestCloseOut).mockResolvedValue({ outcome: "granted", grant: GRANT });
    const { ctx, response } = post("/callbacks/review-close-out", await signed(drive));

    expect((await response).status).toBe(200);
    expect(requestCloseOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "session-1",
      undefined
    );
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("rejects a drive signed with another key", async () => {
    const { response } = post(
      "/callbacks/review-close-out",
      await signed(drive, "someone-elses-secret")
    );

    expect((await response).status).toBe(401);
    expect(requestCloseOut).not.toHaveBeenCalled();
  });
});
