import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type * as GitHubAuthModule from "../src/github-auth";
import type { Env } from "../src/types";
import type { Logger } from "../src/logger";

vi.mock("../src/github-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAuthModule>()),
  generateInstallationToken: vi.fn(),
  getReviewStatusState: vi.fn(),
  getPullRequestSnapshot: vi.fn(),
  postCommitStatus: vi.fn(),
}));

import {
  generateInstallationToken,
  getPullRequestSnapshot,
  getReviewStatusState,
  postCommitStatus,
} from "../src/github-auth";
import {
  closeOutDescription,
  closeOutReviewStatus,
  completeCloseOut,
  requestCloseOut,
  type ReviewCloseOutGrant,
} from "../src/review-close-out";

const CLOSE_OUT_URL = "https://internal/internal/github-reviews/close-out";
const FINALIZE_URL = "https://internal/internal/github-reviews/close-out/finalize";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  } as unknown as Logger;
}

/** The control plane: answers close-out with `closeOut`, and finalize with 204. */
function createEnv(closeOut: () => Response = () => grantResponse()): { env: Env; cpFetch: Mock } {
  const cpFetch = vi.fn(async (url: string) =>
    url === FINALIZE_URL ? new Response(null, { status: 204 }) : closeOut()
  );
  const env = {
    CONTROL_PLANE: { fetch: cpFetch },
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_APP_INSTALLATION_ID: "67890",
    SERVICE_AUTH_SECRET: "test-internal-secret",
  } as unknown as Env;
  return { env, cpFetch };
}

function grantResponse(overrides: Partial<ReviewCloseOutGrant> = {}): Response {
  return Response.json({
    outcome: "granted",
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    headSha: "abc123",
    description: "Review did not finish: Execution timed out (stuck processing)",
    superseded: false,
    leaseExpiresInMs: 120_000,
    ...overrides,
  });
}

function grant(overrides: Partial<ReviewCloseOutGrant> = {}): ReviewCloseOutGrant {
  return {
    outcome: "granted",
    sessionId: "session-1",
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    headSha: "abc123",
    description: "Review did not finish: Execution timed out (stuck processing)",
    superseded: false,
    leaseExpiresInMs: 120_000,
    requestedAt: Date.now(),
    ...overrides,
  };
}

function finalizeOutcomes(cpFetch: Mock): string[] {
  return cpFetch.mock.calls
    .filter(([url]) => url === FINALIZE_URL)
    .map(([, init]) => JSON.parse((init as { body: string }).body).outcome);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateInstallationToken).mockResolvedValue("installation-token");
  vi.mocked(getReviewStatusState).mockResolvedValue({ ok: true, state: "pending" });
  vi.mocked(getPullRequestSnapshot).mockResolvedValue({
    ok: true,
    headSha: "abc123",
    state: "open",
    draft: false,
  });
  vi.mocked(postCommitStatus).mockResolvedValue({ ok: true });
});

describe("requestCloseOut", () => {
  it("records the request and returns the granted lease", async () => {
    const { env, cpFetch } = createEnv();
    const request = { owner: "acme", repo: "widgets", description: "Review failed to start" };

    const result = await requestCloseOut(env, "trace-1", "session-1", request);

    expect(result).toEqual({
      outcome: "granted",
      grant: expect.objectContaining({
        sessionId: "session-1",
        headSha: "abc123",
        requestedAt: expect.any(Number),
      }),
    });
    expect(cpFetch.mock.calls[0][0]).toBe(CLOSE_OUT_URL);
    expect(JSON.parse(cpFetch.mock.calls[0][1].body)).toEqual({ sessionId: "session-1", request });
  });

  it.each([
    [202, "deferred"],
    [409, "not_owned"],
    [500, "request_failed"],
  ])("maps a %i from the control plane to %s", async (status, outcome) => {
    const { env } = createEnv(() => Response.json({}, { status }));

    await expect(requestCloseOut(env, "trace-1", "session-1")).resolves.toMatchObject({
      outcome,
    });
  });
});

describe("completeCloseOut", () => {
  it("replaces a still-pending status with an error carrying the ending's reason", async () => {
    const { env, cpFetch } = createEnv();

    const outcome = await completeCloseOut(env, createMockLogger(), grant(), "trace-1");

    expect(outcome).toBe("closed_out");
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
    expect(finalizeOutcomes(cpFetch)).toEqual(["done"]);
  });

  it("names a superseded review's head as superseded", async () => {
    const { env } = createEnv();

    await completeCloseOut(env, createMockLogger(), grant({ superseded: true }), "trace-1");

    expect(vi.mocked(postCommitStatus).mock.calls[0][4].description).toBe(
      "Superseded by a newer commit"
    );
  });

  it("falls back to unpublished when the ending recorded no reason", async () => {
    const { env } = createEnv();

    await completeCloseOut(env, createMockLogger(), grant({ description: null }), "trace-1");

    expect(vi.mocked(postCommitStatus).mock.calls[0][4].description).toBe(
      "Review did not publish — push again to retry"
    );
  });

  it.each(["success", "failure", "error"])(
    "never replaces a %s status, and finalizes it as done",
    async (state) => {
      vi.mocked(getReviewStatusState).mockResolvedValue({ ok: true, state });
      const { env, cpFetch } = createEnv();

      const outcome = await completeCloseOut(env, createMockLogger(), grant(), "trace-1");

      expect(outcome).toBe("already_terminal");
      expect(postCommitStatus).not.toHaveBeenCalled();
      expect(finalizeOutcomes(cpFetch)).toEqual(["done"]);
    }
  );

  it.each(["closed", "merged"])("leaves a %s pull request's status alone", async (state) => {
    vi.mocked(getPullRequestSnapshot).mockResolvedValue({
      ok: true,
      headSha: "abc123",
      state,
      draft: false,
    });
    const { env, cpFetch } = createEnv();

    const outcome = await completeCloseOut(env, createMockLogger(), grant(), "trace-1");

    expect(outcome).toBe("pr_not_open");
    expect(postCommitStatus).not.toHaveBeenCalled();
    expect(finalizeOutcomes(cpFetch)).toEqual(["done"]);
  });

  it("still closes out when the pull request's state cannot be read", async () => {
    vi.mocked(getPullRequestSnapshot).mockResolvedValue({ ok: false, error: "boom" });
    const { env } = createEnv();

    await expect(completeCloseOut(env, createMockLogger(), grant(), "trace-1")).resolves.toBe(
      "closed_out"
    );
  });

  it("keeps the close-out for a retry when the current status cannot be read", async () => {
    vi.mocked(getReviewStatusState).mockResolvedValue({ ok: false, error: "boom" });
    const { env, cpFetch } = createEnv();

    const outcome = await completeCloseOut(env, createMockLogger(), grant(), "trace-1");

    expect(outcome).toBe("status_unreadable");
    expect(postCommitStatus).not.toHaveBeenCalled();
    expect(finalizeOutcomes(cpFetch)).toEqual(["retry"]);
  });

  it("keeps the close-out for a retry when the status write fails transiently", async () => {
    vi.mocked(postCommitStatus).mockResolvedValue({
      ok: false,
      status: 502,
      error: "GitHub API returned 502",
    });
    const { env, cpFetch } = createEnv();

    const outcome = await completeCloseOut(env, createMockLogger(), grant(), "trace-1");

    expect(outcome).toBe("status_write_failed");
    expect(finalizeOutcomes(cpFetch)).toEqual(["retry"]);
  });

  it("abandons a status write GitHub rejects outright", async () => {
    vi.mocked(postCommitStatus).mockResolvedValue({
      ok: false,
      status: 422,
      error: "GitHub API returned 422",
    });
    const { env, cpFetch } = createEnv();
    const log = createMockLogger();

    const outcome = await completeCloseOut(env, log, grant(), "trace-1");

    expect(outcome).toBe("status_write_rejected");
    expect(finalizeOutcomes(cpFetch)).toEqual(["done"]);
    expect(log.error).toHaveBeenCalledWith(
      "review_close_out.abandoned",
      expect.objectContaining({ github_status: 422 })
    );
  });

  it("keeps the close-out for a retry when the installation token cannot be minted", async () => {
    vi.mocked(generateInstallationToken).mockRejectedValue(new Error("token failure"));
    const { env, cpFetch } = createEnv();

    await expect(completeCloseOut(env, createMockLogger(), grant(), "trace-1")).rejects.toThrow(
      "token failure"
    );
    expect(finalizeOutcomes(cpFetch)).toEqual(["retry"]);
  });

  it("writes nothing once too little of the lease is left to finish a write inside it", async () => {
    const { env, cpFetch } = createEnv();

    const outcome = await completeCloseOut(
      env,
      createMockLogger(),
      grant({ requestedAt: Date.now() - 110_000 }),
      "trace-1"
    );

    expect(outcome).toBe("lease_budget_exhausted");
    expect(postCommitStatus).not.toHaveBeenCalled();
    expect(finalizeOutcomes(cpFetch)).toEqual(["retry"]);
  });
});

describe("closeOutReviewStatus", () => {
  it.each([
    [202, "deferred"],
    [409, "not owned"],
  ])("touches nothing on GitHub when the close-out is %i (%s)", async (status) => {
    const { env, cpFetch } = createEnv(() => Response.json({}, { status }));

    await closeOutReviewStatus(env, createMockLogger(), "trace-1", {
      sessionId: "session-1",
      request: { owner: "acme", repo: "widgets", description: "Review failed to start" },
    });

    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getReviewStatusState).not.toHaveBeenCalled();
    expect(postCommitStatus).not.toHaveBeenCalled();
    expect(finalizeOutcomes(cpFetch)).toEqual([]);
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
