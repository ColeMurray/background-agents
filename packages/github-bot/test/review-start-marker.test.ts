/**
 * A review's "pending" start marker against the writers that can end that review before it lands,
 * and against a control plane or GitHub that answers late or not at all.
 */
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GitHubAuthModule from "../src/github-auth";
import type { Logger } from "../src/logger";
import type { Env, PullRequestReviewTriggerPayload } from "../src/types";

vi.mock("../src/github-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAuthModule>()),
  generateInstallationToken: vi.fn(),
  postCommitStatus: vi.fn(),
  postReaction: vi.fn(),
  checkSenderPermission: vi.fn(),
  getPullRequestSnapshot: vi.fn(),
  getReviewStatusState: vi.fn(),
}));

vi.mock("../src/utils/integration-config", () => ({ getGitHubConfig: vi.fn() }));

// Request signing runs on real WebCrypto, which fake timers cannot hold back. These scenarios are
// about ordering and lease timing, so the control plane is reached unsigned: every step of a
// review is then a microtask, and fake time moves only when the review waits on a timer.
vi.mock("../src/internal-auth", () => ({
  signedControlPlaneFetch: (
    env: Env,
    request: { method: string; url: string; body?: string },
    init?: { signal?: AbortSignal }
  ) =>
    env.CONTROL_PLANE.fetch(request.url, {
      method: request.method,
      body: request.body,
      signal: init?.signal,
    }),
}));

import {
  checkSenderPermission,
  generateInstallationToken,
  getPullRequestSnapshot,
  getReviewStatusState,
  postCommitStatus,
  postReaction,
} from "../src/github-auth";
import { handlePullRequestReviewTrigger, START_MARKER_LEASE_WAIT_MS } from "../src/handlers";
import { completeCloseOut, requestCloseOut } from "../src/review-close-out";
import { START_MARKER_RELEASE_TIMEOUT_MS } from "../src/review-supersession";
import { getGitHubConfig } from "../src/utils/integration-config";

const CP = "https://internal/internal/github-reviews";

/** The control plane's lease TTLs: REVIEW_SUBMISSION_LEASE_MS, and START_MARKER_LEASE_MS. */
const SUBMISSION_LEASE_MS = 120_000;
const START_MARKER_LEASE_MS = 30_000;

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

interface FenceRow {
  generation: number;
  headSha: string;
  /** The first close-out request recorded for the row. */
  closeOut?: { owner: string; repo: string; description: string | null };
}

/**
 * The control plane's review fence for one PR, reduced to the rules of routes/github-reviews.ts
 * that decide who may write a head's status: claimed generations, one fence row per review, and
 * the PR's single submission lease. A session is named after its generation.
 */
function createControlPlane() {
  let latestGeneration = 0;
  const rows = new Map<string, FenceRow>();
  const cancelled = new Set<string>();
  let lease: { holder: string; expiresAt: number } | null = null;
  let grants = 0;
  const afterSweep = new Map<number, () => Promise<void>>();
  const stalledUrls = new Set<string>();
  /** Every request to a stalled route: when it was sent, and when its sender gave up on it. */
  const stalledRequests: Array<{ url: string; sentAt: number; abortedAt?: number }> = [];
  /** The status of every answer to a start marker's lease request, in order. */
  const startMarkerAnswers: number[] = [];

  function grantLease(holder: string, ttlMs: number): string {
    lease = { holder, expiresAt: Date.now() + ttlMs };
    return holder;
  }

  /** No answer ever comes; like fetch, the request rejects with its signal's reason once aborted. */
  function unanswered(url: string, signal: AbortSignal | undefined): Promise<Response> {
    const request: (typeof stalledRequests)[number] = { url, sentAt: Date.now() };
    stalledRequests.push(request);
    const { promise, reject } = Promise.withResolvers<Response>();
    signal?.addEventListener(
      "abort",
      () => {
        request.abortedAt = Date.now();
        reject(signal.reason);
      },
      { once: true }
    );
    return promise;
  }

  /** A newer review of the same head owns its status. */
  const reclaimed = (row: FenceRow) =>
    [...rows.values()].some(
      (other) => other.generation > row.generation && other.headSha === row.headSha
    );

  async function answer(url: string, body: Record<string, any>): Promise<Response> {
    switch (url) {
      case `${CP}/claim`:
        latestGeneration += 1;
        return Response.json({ generation: latestGeneration });
      case "https://internal/sessions": {
        const { generation, headSha } = body.githubReview;
        if (generation !== latestGeneration) return new Response("superseded", { status: 409 });
        rows.set(`session-${generation}`, { generation, headSha });
        return Response.json({ sessionId: `session-${generation}`, status: "created" });
      }
      case `${CP}/sweep`: {
        for (const [sessionId, row] of rows) {
          if (row.generation >= body.generation) continue;
          cancelled.add(sessionId);
          if (reclaimed(row)) rows.delete(sessionId);
          else row.closeOut ??= { owner: body.owner, repo: body.repo, description: null };
        }
        await afterSweep.get(body.generation)?.();
        return Response.json({
          cancelledSessionIds: [],
          deferredSessionIds: [],
          failedSessionIds: [],
        });
      }
      case `${CP}/start-marker`: {
        const row = rows.get(body.sessionId);
        if (!row || row.generation !== latestGeneration || row.closeOut) {
          return new Response("superseded", { status: 409 });
        }
        if (lease && lease.expiresAt >= Date.now()) {
          return new Response("busy", { status: 423, headers: { "Retry-After": "1" } });
        }
        const grantId = grantLease(
          `start-marker:${body.sessionId}:${++grants}`,
          START_MARKER_LEASE_MS
        );
        return Response.json({ grantId, leaseExpiresInMs: START_MARKER_LEASE_MS });
      }
      case `${CP}/start-marker/release`:
        if (lease?.holder === body.grantId) lease = null;
        return new Response(null, { status: 204 });
      case `${CP}/close-out`: {
        const row = rows.get(body.sessionId);
        if (row && body.request) row.closeOut ??= body.request;
        if (!row?.closeOut) return Response.json({ outcome: "not_owned" }, { status: 409 });
        if (reclaimed(row)) {
          rows.delete(body.sessionId);
          return Response.json({ outcome: "not_owned" }, { status: 409 });
        }
        if (lease && lease.expiresAt >= Date.now()) {
          return Response.json({ outcome: "deferred" }, { status: 202 });
        }
        const grantId = grantLease(`close-out:${body.sessionId}:${++grants}`, SUBMISSION_LEASE_MS);
        return Response.json({
          outcome: "granted",
          owner: row.closeOut.owner,
          repo: row.closeOut.repo,
          prNumber: 42,
          headSha: row.headSha,
          description: row.closeOut.description,
          superseded: row.generation < latestGeneration,
          leaseExpiresInMs: SUBMISSION_LEASE_MS,
          grantId,
        });
      }
      case `${CP}/close-out/finalize`:
        if (lease?.holder === body.grantId) {
          if (body.outcome === "done") rows.delete(body.sessionId);
          lease = null;
        }
        return new Response(null, { status: 204 });
    }
    const prompt = /^https:\/\/internal\/sessions\/([^/]+)\/prompt$/.exec(url);
    if (prompt) {
      return cancelled.has(prompt[1])
        ? new Response("Session is cancelled", { status: 409 })
        : Response.json({ messageId: `message-${prompt[1]}` });
    }
    if (url.endsWith("/metadata")) return Response.json({ repo: "acme/widgets", metadata: null });
    throw new Error(`Unexpected control-plane call: ${url}`);
  }

  return {
    fetch: vi.fn(async (url: string, init: { body?: string; signal?: AbortSignal }) => {
      // Like fetch, a request whose signal has already fired is never sent.
      if (init.signal?.aborted) throw init.signal.reason;
      if (stalledUrls.has(url)) return unanswered(url, init.signal);
      const response = await answer(url, init.body ? JSON.parse(init.body) : {});
      if (url === `${CP}/start-marker`) startMarkerAnswers.push(response.status);
      return response;
    }),
    /** Hold the answer to `generation`'s sweep — made, but not yet seen by its handler. */
    pauseAfterSweep(generation: number) {
      const reached = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      afterSweep.set(generation, () => {
        reached.resolve();
        return resume.promise;
      });
      return { reached: reached.promise, resume: resume.resolve };
    },
    /** Another writer takes the PR's lease for `ttlMs`, as an agent mid-submission would. */
    holdLease(holder: string, ttlMs: number) {
      lease = { holder, expiresAt: Date.now() + ttlMs };
    },
    leaseHolder: () => lease?.holder ?? null,
    /** Leave every request to `url` unanswered, as a stalled control plane would. */
    stall(url: string) {
      stalledUrls.add(url);
    },
    stalledRequests,
    startMarkerAnswers,
  };
}

/** GitHub for one PR: its head, and each commit's `open-inspect` status. */
function createGitHub() {
  const statuses = new Map<string, { state: string; description: string }>();
  /** Every status write that landed, with the time it landed. */
  const writes: Array<{ sha: string; state: string; at: number }> = [];
  const github = {
    headSha: "abc123",
    status: (sha: string) => statuses.get(sha),
    writes,
  };

  vi.mocked(postCommitStatus).mockImplementation(async (_token, _owner, _repo, sha, status) => {
    statuses.set(sha, { state: status.state, description: status.description });
    writes.push({ sha, state: status.state, at: Date.now() });
    return { ok: true };
  });
  vi.mocked(getReviewStatusState).mockImplementation(async (_token, _owner, _repo, sha) => ({
    ok: true,
    state: statuses.get(sha)?.state ?? null,
  }));
  vi.mocked(getPullRequestSnapshot).mockImplementation(async () => ({
    ok: true,
    headSha: github.headSha,
    state: "open",
    draft: false,
  }));
  return github;
}

function createEnv(controlPlaneFetch: unknown): Env {
  return {
    CONTROL_PLANE: { fetch: controlPlaneFetch },
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_APP_INSTALLATION_ID: "67890",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    SERVICE_AUTH_SECRET: "test-internal-secret",
    LOG_LEVEL: "error",
  } as unknown as Env;
}

function event(
  action: PullRequestReviewTriggerPayload["action"],
  headSha: string
): PullRequestReviewTriggerPayload {
  return {
    action,
    pull_request: {
      number: 42,
      title: "Add caching",
      body: null,
      user: { login: "alice" },
      head: { ref: "feature/cache", sha: headSha },
      base: { ref: "main" },
      draft: false,
    },
    repository: { id: 501, owner: { login: "acme" }, name: "widgets", private: false },
    sender: {
      login: "alice",
      id: 1001,
      avatar_url: "https://avatars.githubusercontent.com/u/1001",
    },
  };
}

/** The control plane's reaper re-driving an owed close-out, as `/callbacks/review-close-out` runs it. */
async function driveCloseOut(env: Env, sessionId: string): Promise<string> {
  const result = await requestCloseOut(env, "trace-reaper", sessionId);
  if (result.outcome !== "granted") return result.outcome;
  return completeCloseOut(env, createLogger(), result.grant, "trace-reaper");
}

/**
 * Settle `review` under fake timers, firing the next timer only once a real macrotask has let
 * every step the review queued run: fake time moves only while the review waits on a timer, so
 * each wait and deadline fires in order. Fails once the review is still running with no timer
 * left to end its wait.
 */
async function settleUnderFakeTimers<T>(review: Promise<T>): Promise<T> {
  let settled = false;
  const done = () => (settled = true);
  review.then(done, done);
  for (;;) {
    await nextMacrotask();
    if (settled) return review;
    if (vi.getTimerCount() === 0) {
      throw new Error("The review is waiting on something no timer will end");
    }
    await vi.advanceTimersToNextTimerAsync();
  }
}

const SUPERSEDED = { state: "error", description: "Superseded by a newer commit" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateInstallationToken).mockResolvedValue("installation-token");
  vi.mocked(postReaction).mockResolvedValue(true);
  vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: true });
  vi.mocked(getGitHubConfig).mockResolvedValue({
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    autoReviewOnOpen: true,
    enabledRepos: null,
    allowedTriggerUsers: null,
    codeReviewInstructions: null,
    commentActionInstructions: null,
  });
});

describe("a review's start marker", () => {
  it("never lands on a replaced head after that head's close-out", async () => {
    const controlPlane = createControlPlane();
    const github = createGitHub();
    const env = createEnv(controlPlane.fetch);
    const paused = controlPlane.pauseAfterSweep(1);

    // Review A claims generation 1, creates its session, and sweeps; then stalls.
    const reviewA = handlePullRequestReviewTrigger(
      env,
      createLogger(),
      event("synchronize", "abc123"),
      "trace-a"
    );
    await paused.reached;

    // A push replaces the head: review B claims generation 2, creates its session, and sweeps A,
    // recording A's close-out; the reaper then closes out the replaced head.
    github.headSha = "def456";
    await expect(
      handlePullRequestReviewTrigger(env, createLogger(), event("synchronize", "def456"), "trace-b")
    ).resolves.toMatchObject({ outcome: "processed", session_id: "session-2" });
    await expect(driveCloseOut(env, "session-1")).resolves.toBe("closed_out");

    paused.resume();
    await expect(reviewA).rejects.toThrow("Prompt delivery failed: 409");

    expect(github.status("abc123")).toEqual(SUPERSEDED);
    expect(github.status("def456")).toEqual({
      state: "pending",
      description: "Review in progress",
    });
  });
});

describe("a start marker while another writer holds the PR's lease", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the lease to lapse, then writes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const controlPlane = createControlPlane();
    const github = createGitHub();
    const env = createEnv(controlPlane.fetch);
    // An older review's agent is mid-submission.
    const lapsesAt = Date.now() + 1_500;
    controlPlane.holdLease("session-0", 1_500);

    const review = handlePullRequestReviewTrigger(
      env,
      createLogger(),
      event("synchronize", "abc123"),
      "trace-a"
    );

    await expect(settleUnderFakeTimers(review)).resolves.toMatchObject({ outcome: "processed" });
    // Refused while the lease is live, asked again each second, granted once it lapsed.
    expect(controlPlane.startMarkerAnswers).toEqual([423, 423, 200]);
    expect(github.writes).toEqual([{ sha: "abc123", state: "pending", at: expect.any(Number) }]);
    expect(github.writes[0].at).toBeGreaterThan(lapsesAt);
    expect(controlPlane.leaseHolder()).toBeNull();
  });

  it("starts the review without a start marker once the lease stays busy past the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const controlPlane = createControlPlane();
    const github = createGitHub();
    const env = createEnv(controlPlane.fetch);
    controlPlane.holdLease("session-0", 60_000);

    const review = handlePullRequestReviewTrigger(
      env,
      createLogger(),
      event("synchronize", "abc123"),
      "trace-a"
    );

    await expect(settleUnderFakeTimers(review)).resolves.toMatchObject({
      outcome: "processed",
      session_id: "session-1",
    });
    expect(github.writes).toEqual([]);
    expect(controlPlane.leaseHolder()).toBe("session-0");
  });
});

describe("a start marker when the control plane does not answer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the review without one once its lease request outlasts the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const controlPlane = createControlPlane();
    const github = createGitHub();
    const env = createEnv(controlPlane.fetch);
    controlPlane.stall(`${CP}/start-marker`);

    const review = handlePullRequestReviewTrigger(
      env,
      createLogger(),
      event("synchronize", "abc123"),
      "trace-a"
    );

    await expect(settleUnderFakeTimers(review)).resolves.toMatchObject({
      outcome: "processed",
      message_id: "message-session-1",
    });
    const [request] = controlPlane.stalledRequests;
    expect(request.abortedAt! - request.sentAt).toBeLessThanOrEqual(START_MARKER_LEASE_WAIT_MS);
    expect(github.writes).toEqual([]);
  });

  it("sends the prompt once its lease release outlasts the release timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const controlPlane = createControlPlane();
    const github = createGitHub();
    const env = createEnv(controlPlane.fetch);
    controlPlane.stall(`${CP}/start-marker/release`);

    const review = handlePullRequestReviewTrigger(
      env,
      createLogger(),
      event("synchronize", "abc123"),
      "trace-a"
    );

    await expect(settleUnderFakeTimers(review)).resolves.toMatchObject({
      outcome: "processed",
      message_id: "message-session-1",
    });
    expect(github.writes).toEqual([{ sha: "abc123", state: "pending", at: expect.any(Number) }]);
    const [release] = controlPlane.stalledRequests;
    expect(release.abortedAt! - release.sentAt).toBeLessThanOrEqual(
      START_MARKER_RELEASE_TIMEOUT_MS
    );
    // The lease it could not hand back is left to expire.
    expect(controlPlane.leaseHolder()).toMatch(/^start-marker:session-1:/);
  });
});

describe("a start marker's lease after its write", () => {
  it.each([
    [
      "is released once GitHub has rejected the write",
      { ok: false as const, status: 403, error: "GitHub API returned 403" },
      null,
    ],
    [
      "is kept until it expires when GitHub never answered, since the write may still land",
      { ok: false as const, error: "The operation was aborted due to timeout" },
      expect.stringMatching(/^start-marker:session-1:/),
    ],
    [
      "is kept until it expires when GitHub answered with a 5xx, since the write may still land",
      { ok: false as const, status: 502, error: "GitHub API returned 502" },
      expect.stringMatching(/^start-marker:session-1:/),
    ],
  ])("%s", async (_name, writeResult, holder) => {
    const controlPlane = createControlPlane();
    createGitHub();
    vi.mocked(postCommitStatus).mockResolvedValueOnce(writeResult);
    const env = createEnv(controlPlane.fetch);

    await expect(
      handlePullRequestReviewTrigger(env, createLogger(), event("synchronize", "abc123"), "trace-a")
    ).resolves.toMatchObject({ outcome: "processed" });

    expect(controlPlane.leaseHolder()).toEqual(holder);
  });
});
