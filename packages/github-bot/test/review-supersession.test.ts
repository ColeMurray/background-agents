import { describe, it, expect, vi } from "vitest";
import type { Env } from "../src/types";
import type { Logger } from "../src/logger";
import {
  claimReviewGeneration,
  releaseReviewGeneration,
  sweepStaleReviews,
} from "../src/review-supersession";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createMockEnv(fetchImpl: (url: string) => Promise<Response>): Env {
  return {
    GITHUB_KV: { get: vi.fn(), put: vi.fn() },
    CONTROL_PLANE: { fetch: vi.fn().mockImplementation(fetchImpl) },
    DEPLOYMENT_NAME: "test",
    // Deliberately non-default: these client tests do not exercise model selection.
    DEFAULT_MODEL: "anthropic/test-review-model",
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_APP_INSTALLATION_ID: "67890",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    SERVICE_AUTH_SECRET: "test-internal-secret",
    LOG_LEVEL: "error",
  } as unknown as Env;
}

function getFetch(env: Env) {
  return (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
}

describe("claimReviewGeneration", () => {
  it("posts repoId/prNumber and returns the claimed generation", async () => {
    const env = createMockEnv(
      async () => new Response(JSON.stringify({ generation: 4 }), { status: 200 })
    );

    const generation = await claimReviewGeneration(env, "trace-claim", {
      repoId: 501,
      prNumber: 42,
    });

    expect(generation).toBe(4);
    const fetchMock = getFetch(env);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://internal/internal/github-reviews/claim");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ repoId: 501, prNumber: 42 });
  });

  it("throws when the control plane rejects the claim", async () => {
    const env = createMockEnv(async () => new Response("nope", { status: 500 }));

    await expect(
      claimReviewGeneration(env, "trace-claim-fail", { repoId: 501, prNumber: 42 })
    ).rejects.toThrow("Review generation claim failed: 500");
  });

  it("throws on a malformed claim response", async () => {
    const env = createMockEnv(async () => new Response(JSON.stringify({}), { status: 200 }));

    await expect(
      claimReviewGeneration(env, "trace-claim-malformed", { repoId: 501, prNumber: 42 })
    ).rejects.toThrow("Review generation claim failed: invalid response");
  });
});

describe("releaseReviewGeneration", () => {
  it("posts repoId/prNumber/generation so the rollback stays conditional", async () => {
    const env = createMockEnv(
      async () => new Response(JSON.stringify({ released: true }), { status: 200 })
    );
    const log = createMockLogger();

    await releaseReviewGeneration(env, log, "trace-release", {
      repoId: 501,
      prNumber: 42,
      generation: 3,
    });

    const fetchMock = getFetch(env);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://internal/internal/github-reviews/release-claim");
    expect(init.method).toBe("POST");
    // The generation is what makes the rollback conditional: the control plane
    // only decrements while this claim is still the latest one.
    expect(JSON.parse(init.body)).toEqual({ repoId: 501, prNumber: 42, generation: 3 });
    expect(log.info).toHaveBeenCalledWith(
      "review_claim.released",
      expect.objectContaining({ generation: 3 })
    );
  });

  it("never throws when the control plane rejects the release", async () => {
    const env = createMockEnv(async () => new Response("nope", { status: 503 }));
    const log = createMockLogger();

    await expect(
      releaseReviewGeneration(env, log, "trace-release-503", {
        repoId: 501,
        prNumber: 42,
        generation: 3,
      })
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "review_claim.release_failed",
      expect.objectContaining({ status: 503 })
    );
  });

  it("never throws when the control plane is unreachable", async () => {
    const env = createMockEnv(async () => {
      throw new Error("network down");
    });
    const log = createMockLogger();

    await expect(
      releaseReviewGeneration(env, log, "trace-release-error", {
        repoId: 501,
        prNumber: 42,
        generation: 3,
      })
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "review_claim.release_error",
      expect.objectContaining({ generation: 3 })
    );
  });
});

describe("sweepStaleReviews", () => {
  it("posts repoId/prNumber/generation and logs the cancelled sessions", async () => {
    const env = createMockEnv(
      async () =>
        new Response(
          JSON.stringify({ cancelledSessionIds: ["session-a", "session-b"], failedSessionIds: [] }),
          { status: 200 }
        )
    );
    const log = createMockLogger();

    await sweepStaleReviews(env, log, "trace-sweep", { repoId: 501, prNumber: 42, generation: 3 });

    const fetchMock = getFetch(env);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://internal/internal/github-reviews/sweep");
    expect(JSON.parse(init.body)).toEqual({ repoId: 501, prNumber: 42, generation: 3 });
    expect(log.info).toHaveBeenCalledWith(
      "review_sweep.completed",
      expect.objectContaining({ cancelled_session_ids: ["session-a", "session-b"] })
    );
  });

  it("never throws when the control plane request fails", async () => {
    const env = createMockEnv(async () => {
      throw new Error("network down");
    });
    const log = createMockLogger();

    await expect(
      sweepStaleReviews(env, log, "trace-sweep-error", { repoId: 501, prNumber: 42, generation: 3 })
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "review_sweep.error",
      expect.objectContaining({ generation: 3 })
    );
  });

  it("never throws and warns when the control plane responds with an error status", async () => {
    const env = createMockEnv(async () => new Response("boom", { status: 503 }));
    const log = createMockLogger();

    await expect(
      sweepStaleReviews(env, log, "trace-sweep-503", { repoId: 501, prNumber: 42, generation: 3 })
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "review_sweep.request_failed",
      expect.objectContaining({ status: 503 })
    );
  });

  it("warns without throwing when some cancellations fail", async () => {
    const env = createMockEnv(
      async () =>
        new Response(
          JSON.stringify({ cancelledSessionIds: ["session-a"], failedSessionIds: ["session-b"] }),
          { status: 200 }
        )
    );
    const log = createMockLogger();

    await sweepStaleReviews(env, log, "trace-sweep-partial", {
      repoId: 501,
      prNumber: 42,
      generation: 3,
    });

    expect(log.warn).toHaveBeenCalledWith(
      "review_sweep.partial_failure",
      expect.objectContaining({ failed_session_ids: ["session-b"] })
    );
  });
});
