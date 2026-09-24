import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GitHubAuthModule from "../src/github-auth";
import type { GitHubReviewCompletionCallback } from "@open-inspect/shared/types/session-api";
import type { Env } from "../src/types";
import type { Logger } from "../src/logger";

vi.mock("../src/github-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAuthModule>()),
  generateInstallationToken: vi.fn().mockResolvedValue("installation-token"),
  getReviewStatusState: vi.fn(),
  getPullRequestSnapshot: vi.fn(),
  postCommitStatus: vi.fn(),
}));

import { getPullRequestSnapshot, getReviewStatusState, postCommitStatus } from "../src/github-auth";
import { closeOutDescription, closeOutEndedReview } from "../src/review-close-out";

const CLOSE_OUT_URL = "https://internal/internal/github-reviews/close-out";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  } as unknown as Logger;
}

function createEnv(closeOutStatus: number): { env: Env; cpFetch: ReturnType<typeof vi.fn> } {
  const cpFetch = vi.fn(async () => new Response(null, { status: closeOutStatus }));
  const env = {
    CONTROL_PLANE: { fetch: cpFetch },
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_APP_INSTALLATION_ID: "67890",
    SERVICE_AUTH_SECRET: "test-internal-secret",
  } as unknown as Env;
  return { env, cpFetch };
}

function callback(
  overrides: Partial<GitHubReviewCompletionCallback> = {}
): GitHubReviewCompletionCallback {
  return {
    sessionId: "session-1",
    messageId: "msg-1",
    success: false,
    error: "Execution timed out (stuck processing)",
    timestamp: 1_788_183_214_615,
    signature: "sig",
    context: { source: "github", owner: "acme", repo: "widgets", prNumber: 42, headSha: "abc123" },
    ...overrides,
  };
}

describe("closeOutEndedReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getReviewStatusState).mockResolvedValue({ ok: true, state: "pending" });
    vi.mocked(getPullRequestSnapshot).mockResolvedValue({
      ok: true,
      headSha: "abc123",
      state: "open",
      draft: false,
    });
    vi.mocked(postCommitStatus).mockResolvedValue({ ok: true });
  });

  it("replaces a still-pending status with an error carrying the session's reason", async () => {
    const { env, cpFetch } = createEnv(204);

    const outcome = await closeOutEndedReview(env, createMockLogger(), callback(), "trace-1");

    expect(outcome).toBe("closed_out");
    const [url, init] = cpFetch.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe(CLOSE_OUT_URL);
    expect(JSON.parse(init.body)).toEqual({ sessionId: "session-1" });
    expect(postCommitStatus).toHaveBeenCalledWith(
      "installation-token",
      "acme",
      "widgets",
      "abc123",
      {
        state: "error",
        context: "open-inspect",
        description: "Review did not finish: Execution timed out (stuck processing)",
      },
      "Open-Inspect"
    );
  });

  it("closes out a cancelled review the same way", async () => {
    const { env } = createEnv(204);

    await closeOutEndedReview(
      env,
      createMockLogger(),
      callback({ error: "Execution was cancelled" }),
      "trace-1"
    );

    expect(postCommitStatus).toHaveBeenCalledWith(
      "installation-token",
      "acme",
      "widgets",
      "abc123",
      expect.objectContaining({
        state: "error",
        description: "Review did not finish: Execution was cancelled",
      }),
      "Open-Inspect"
    );
  });

  it("writes nothing when the review already published or closed itself out", async () => {
    vi.mocked(getReviewStatusState).mockResolvedValue({ ok: true, state: "success" });
    const { env } = createEnv(204);

    const outcome = await closeOutEndedReview(
      env,
      createMockLogger(),
      callback({ success: true, error: undefined }),
      "trace-1"
    );

    expect(outcome).toBe("already_terminal");
    expect(postCommitStatus).not.toHaveBeenCalled();
  });

  it("writes nothing, and reads nothing from GitHub, when the control plane declines the close-out", async () => {
    const { env } = createEnv(409);

    const outcome = await closeOutEndedReview(env, createMockLogger(), callback(), "trace-1");

    expect(outcome).toBe("not_owned");
    expect(getReviewStatusState).not.toHaveBeenCalled();
    expect(postCommitStatus).not.toHaveBeenCalled();
  });

  it("writes nothing when the close-out claim itself fails", async () => {
    const { env } = createEnv(500);
    const log = createMockLogger();

    const outcome = await closeOutEndedReview(env, log, callback(), "trace-1");

    expect(outcome).toBe("close_out_claim_failed");
    expect(postCommitStatus).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "review_close_out.claim_failed",
      expect.objectContaining({ session_id: "session-1" })
    );
  });

  it.each(["closed", "merged"])("leaves a %s pull request's status alone", async (state) => {
    vi.mocked(getPullRequestSnapshot).mockResolvedValue({
      ok: true,
      headSha: "abc123",
      state,
      draft: false,
    });
    const { env } = createEnv(204);

    const outcome = await closeOutEndedReview(env, createMockLogger(), callback(), "trace-1");

    expect(outcome).toBe("pr_not_open");
    expect(postCommitStatus).not.toHaveBeenCalled();
  });

  it("still closes out when the pull request's state cannot be read", async () => {
    vi.mocked(getPullRequestSnapshot).mockResolvedValue({
      ok: false,
      error: "GitHub API returned 502",
    });
    const { env } = createEnv(204);

    const outcome = await closeOutEndedReview(env, createMockLogger(), callback(), "trace-1");

    expect(outcome).toBe("closed_out");
    expect(postCommitStatus).toHaveBeenCalled();
  });

  it("writes nothing when the current status cannot be read", async () => {
    vi.mocked(getReviewStatusState).mockResolvedValue({
      ok: false,
      error: "GitHub API returned 502",
    });
    const { env } = createEnv(204);

    const outcome = await closeOutEndedReview(env, createMockLogger(), callback(), "trace-1");

    expect(outcome).toBe("status_unreadable");
    expect(postCommitStatus).not.toHaveBeenCalled();
  });

  it("reports a failed status write", async () => {
    vi.mocked(postCommitStatus).mockResolvedValue({
      ok: false,
      status: 422,
      error: "GitHub API returned 422",
    });
    const { env } = createEnv(204);
    const log = createMockLogger();

    const outcome = await closeOutEndedReview(env, log, callback(), "trace-1");

    expect(outcome).toBe("status_write_failed");
    expect(log.error).toHaveBeenCalledWith(
      "review_close_out.status_write_failed",
      expect.objectContaining({ github_status: 422 })
    );
  });
});

describe("closeOutDescription", () => {
  it("names a successful turn that left the status pending as unpublished", () => {
    expect(closeOutDescription({ success: true })).toBe(
      "Review did not publish — push again to retry"
    );
  });

  it("falls back to unpublished when a failed turn carries no reason", () => {
    expect(closeOutDescription({ success: false, error: "  " })).toBe(
      "Review did not publish — push again to retry"
    );
  });

  it("truncates a long reason to GitHub's description limit", () => {
    const description = closeOutDescription({ success: false, error: "x".repeat(500) });

    expect(description).toHaveLength(140);
    expect(description.startsWith("Review did not finish: ")).toBe(true);
    expect(description.endsWith("…")).toBe(true);
  });
});
