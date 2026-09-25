/**
 * End-to-end GitHub review supersession (design: review-supersede, fix A):
 * claim a generation, fence a session-create on it, claim again, verify the
 * now-stale generation is rejected, then sweep cancels the superseded
 * session and drops its row while the current one survives.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { verifyCallbackSignature } from "@open-inspect/shared/auth";
import { SessionIndexStore } from "../../src/db/session-index";
import {
  handleReviewLeaseRelease,
  handleReviewOwnership,
  reapSupersededReviewSessions,
} from "../../src/routes/github-reviews";
import type { RequestContext } from "../../src/routes/shared";
import type { Env } from "../../src/types";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";

const GITHUB_BOT_ACTOR = "github:90001";

interface ClaimResponse {
  generation: number;
}

interface CreateSessionResponse {
  sessionId: string;
}

interface SweepResponse {
  cancelledSessionIds: string[];
  deferredSessionIds: string[];
  failedSessionIds: string[];
}

async function claimGeneration(repoId: number, prNumber: number): Promise<number> {
  const res = await serviceFetch("https://test.local/internal/github-reviews/claim", {
    method: "POST",
    service: "github-bot",
    body: JSON.stringify({ repoId, prNumber }),
  });
  expect(res.status).toBe(200);
  return (await res.json<ClaimResponse>()).generation;
}

function createReviewSession(params: {
  repoId: number;
  prNumber: number;
  generation: number;
  headSha: string;
}): Promise<Response> {
  return serviceFetch("https://test.local/sessions", {
    method: "POST",
    service: "github-bot",
    actor: GITHUB_BOT_ACTOR,
    body: JSON.stringify({
      title: `Review PR #${params.prNumber} gen ${params.generation}`,
      model: "anthropic/claude-haiku-4-5",
      githubReview: params,
    }),
  });
}

describe("GitHub review supersession (claim -> fenced create -> sweep)", () => {
  beforeEach(cleanD1Tables);

  it("rejects a stale-generation create and sweeps the superseded session on the next claim", async () => {
    const repoId = 424242;
    const prNumber = 17;

    const genA = await claimGeneration(repoId, prNumber);
    expect(genA).toBe(1);
    const createA = await createReviewSession({
      repoId,
      prNumber,
      generation: genA,
      headSha: "sha-a",
    });
    expect(createA.status).toBe(201);
    const { sessionId: sessionA } = await createA.json<CreateSessionResponse>();

    const genB = await claimGeneration(repoId, prNumber);
    expect(genB).toBe(2);

    // A create still fenced on the now-superseded generation A must be
    // rejected outright — no D1 session row, no DO.
    const sessionCountBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions"
    ).first<{ count: number }>();
    const staleCreate = await createReviewSession({
      repoId,
      prNumber,
      generation: genA,
      headSha: "sha-stale",
    });
    expect(staleCreate.status).toBe(409);
    await expect(staleCreate.json()).resolves.toEqual({ error: "review generation superseded" });
    const sessionCountAfter = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{
      count: number;
    }>();
    expect(sessionCountAfter?.count).toBe(sessionCountBefore?.count);

    const createB = await createReviewSession({
      repoId,
      prNumber,
      generation: genB,
      headSha: "sha-b",
    });
    expect(createB.status).toBe(201);
    const { sessionId: sessionB } = await createB.json<CreateSessionResponse>();

    const sweep = await serviceFetch("https://test.local/internal/github-reviews/sweep", {
      method: "POST",
      service: "github-bot",
      body: JSON.stringify({ repoId, prNumber, generation: genB }),
    });
    expect(sweep.status).toBe(200);
    const sweepBody = await sweep.json<SweepResponse>();
    expect(sweepBody).toEqual({
      cancelledSessionIds: [sessionA],
      deferredSessionIds: [],
      failedSessionIds: [],
    });

    const sessionStore = new SessionIndexStore(env.DB);
    expect((await sessionStore.get(sessionA))?.status).toBe("cancelled");
    expect((await sessionStore.get(sessionB))?.status).not.toBe("cancelled");

    const remainingReviewRows = await env.DB.prepare(
      "SELECT session_id, generation FROM github_review_sessions WHERE repo_id = ? AND pr_number = ?"
    )
      .bind(repoId, prNumber)
      .all<{ session_id: string; generation: number }>();
    expect(remainingReviewRows.results).toEqual([{ session_id: sessionB, generation: genB }]);

    // A second sweep at the same generation is idempotent: session B is not
    // older than generation B, so nothing more is cancelled or deleted.
    const secondSweep = await serviceFetch("https://test.local/internal/github-reviews/sweep", {
      method: "POST",
      service: "github-bot",
      body: JSON.stringify({ repoId, prNumber, generation: genB }),
    });
    await expect(secondSweep.json()).resolves.toEqual({
      cancelledSessionIds: [],
      deferredSessionIds: [],
      failedSessionIds: [],
    });
  });

  it("assigns distinct generations to concurrent claims and only the winner's create survives", async () => {
    const repoId = 515151;
    const prNumber = 23;
    const claimCount = 8;

    // Concurrent webhook deliveries race the atomic UPSERT: every claim must
    // get a unique, gap-free generation regardless of interleaving.
    const generations = await Promise.all(
      Array.from({ length: claimCount }, () => claimGeneration(repoId, prNumber))
    );
    expect([...generations].sort((a, b) => a - b)).toEqual(
      Array.from({ length: claimCount }, (_, i) => i + 1)
    );

    // Both racers proceed to create against their own generation; the fence
    // admits only the highest one, in either arrival order.
    const [loserGen, winnerGen] = [claimCount - 1, claimCount];
    const winnerCreate = await createReviewSession({
      repoId,
      prNumber,
      generation: winnerGen,
      headSha: "sha-winner",
    });
    expect(winnerCreate.status).toBe(201);
    const { sessionId: winnerSession } = await winnerCreate.json<CreateSessionResponse>();

    const loserCreate = await createReviewSession({
      repoId,
      prNumber,
      generation: loserGen,
      headSha: "sha-loser",
    });
    expect(loserCreate.status).toBe(409);

    // The winner's sweep sees no registered stale generations — the loser
    // never got a session to leak.
    const sweep = await serviceFetch("https://test.local/internal/github-reviews/sweep", {
      method: "POST",
      service: "github-bot",
      body: JSON.stringify({ repoId, prNumber, generation: winnerGen }),
    });
    await expect(sweep.json()).resolves.toEqual({
      cancelledSessionIds: [],
      deferredSessionIds: [],
      failedSessionIds: [],
    });

    const rows = await env.DB.prepare(
      "SELECT session_id FROM github_review_sessions WHERE repo_id = ? AND pr_number = ?"
    )
      .bind(repoId, prNumber)
      .all<{ session_id: string }>();
    expect(rows.results).toEqual([{ session_id: winnerSession }]);
  });

  it("refuses claim, create, and sweep from callers other than the github-bot service", async () => {
    const claimFromWrongService = await serviceFetch(
      "https://test.local/internal/github-reviews/claim",
      {
        method: "POST",
        service: "slack-bot",
        body: JSON.stringify({ repoId: 1, prNumber: 1 }),
      }
    );
    // Admission authorizes the service after authenticating it, so a wrong
    // bot is 403 (forbidden), not 401 — same as the guarded create below.
    expect(claimFromWrongService.status).toBe(403);

    const createWithGithubReviewFromWrongService = await serviceFetch(
      "https://test.local/sessions",
      {
        method: "POST",
        service: "slack-bot",
        actor: "slack:U0001",
        body: JSON.stringify({
          title: "Forged review session",
          model: "anthropic/claude-haiku-4-5",
          githubReview: { repoId: 1, prNumber: 1, generation: 1, headSha: "sha" },
        }),
      }
    );
    expect(createWithGithubReviewFromWrongService.status).toBe(403);

    const sweepFromWrongService = await serviceFetch(
      "https://test.local/internal/github-reviews/sweep",
      {
        method: "POST",
        service: "slack-bot",
        body: JSON.stringify({ repoId: 1, prNumber: 1, generation: 1 }),
      }
    );
    expect(sweepFromWrongService.status).toBe(403);
  });
});

describe("GitHub review close-out (who writes a review's terminal status)", () => {
  beforeEach(cleanD1Tables);

  const REQUEST = { owner: "acme", repo: "widgets", description: "Review did not finish: timeout" };

  interface Grant {
    outcome: "granted";
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    description: string | null;
    superseded: boolean;
    leaseExpiresInMs: number;
  }

  function closeOut(
    sessionId: string,
    request?: typeof REQUEST,
    service: "github-bot" | "slack-bot" = "github-bot"
  ) {
    return serviceFetch("https://test.local/internal/github-reviews/close-out", {
      method: "POST",
      service,
      body: JSON.stringify(request ? { sessionId, request } : { sessionId }),
    });
  }

  function finalize(
    sessionId: string,
    outcome: "done" | "retry",
    service: "github-bot" | "slack-bot" = "github-bot"
  ) {
    return serviceFetch("https://test.local/internal/github-reviews/close-out/finalize", {
      method: "POST",
      service,
      body: JSON.stringify({ sessionId, outcome }),
    });
  }

  async function createLatestReview(repoId: number, prNumber: number, headSha: string) {
    const generation = await claimGeneration(repoId, prNumber);
    const create = await createReviewSession({ repoId, prNumber, generation, headSha });
    expect(create.status).toBe(201);
    return (await create.json<CreateSessionResponse>()).sessionId;
  }

  function sandboxContext(sessionId: string): RequestContext {
    return {
      db: sqlDatabase(env.DB),
      metrics: {},
      request_id: "request-id",
      trace_id: "trace-id",
      executionCtx: { submit: () => {} },
      principal: { kind: "sandbox", sessionId },
    } as unknown as RequestContext;
  }

  /** The agent's own submission fence, run against the real D1 exactly as its route runs it. */
  function agentAcquire(sessionId: string): Promise<Response> {
    return handleReviewOwnership(
      new Request(`https://test.local/sessions/${sessionId}/review-ownership`, { method: "POST" }),
      env as unknown as Env,
      { id: sessionId },
      sandboxContext(sessionId)
    );
  }

  function agentRelease(sessionId: string): Promise<Response> {
    return handleReviewLeaseRelease(
      new Request(`https://test.local/sessions/${sessionId}/review-ownership`, {
        method: "DELETE",
      }),
      env as unknown as Env,
      { id: sessionId },
      sandboxContext(sessionId)
    );
  }

  async function expireLease(repoId: number, prNumber: number) {
    await env.DB.prepare(
      "UPDATE github_review_state SET lease_expires_at = ? WHERE repo_id = ? AND pr_number = ?"
    )
      .bind(Date.now() - 1, repoId, prNumber)
      .run();
  }

  async function fenceRows(repoId: number, prNumber: number) {
    const rows = await env.DB.prepare(
      "SELECT session_id, close_out_request FROM github_review_sessions WHERE repo_id = ? AND pr_number = ? ORDER BY generation"
    )
      .bind(repoId, prNumber)
      .all<{ session_id: string; close_out_request: string | null }>();
    return rows.results;
  }

  it("grants the latest review's close-out as a lease, fencing its agent until finalized", async () => {
    const sessionId = await createLatestReview(616161, 5, "sha-a");

    const grant = await closeOut(sessionId, REQUEST);
    expect(grant.status).toBe(200);
    await expect(grant.json<Grant>()).resolves.toEqual({
      outcome: "granted",
      owner: "acme",
      repo: "widgets",
      prNumber: 5,
      headSha: "sha-a",
      description: REQUEST.description,
      superseded: false,
      leaseExpiresInMs: expect.any(Number),
    });
    // An agent that wakes after its turn ended can no longer take the lease.
    expect((await agentAcquire(sessionId)).status).toBe(409);
    // A duplicate drive waits behind the close-out's own live lease.
    expect((await closeOut(sessionId)).status).toBe(202);

    expect((await finalize(sessionId, "done")).status).toBe(204);
    expect(await fenceRows(616161, 5)).toEqual([]);
    // A redelivered completion finds nothing left to own.
    expect((await closeOut(sessionId, REQUEST)).status).toBe(409);
  });

  it("holds a same-head successor's agent off until the close-out finalizes", async () => {
    // P1-a: the close-out's status read and write are serialized with the successor's publish.
    const repoId = 617171;
    const prNumber = 5;
    const sessionA = await createLatestReview(repoId, prNumber, "sha-a");
    expect((await closeOut(sessionA, REQUEST)).status).toBe(200);

    const sessionB = await createLatestReview(repoId, prNumber, "sha-a");
    expect((await agentAcquire(sessionB)).status).toBe(423);

    expect((await finalize(sessionA, "done")).status).toBe(204);
    expect((await agentAcquire(sessionB)).status).toBe(204);
  });

  it("tells the latest review to wait (423) while an older review holds the lease", async () => {
    // P1-b: lease-busy is not supersession.
    const repoId = 618181;
    const prNumber = 5;
    const sessionA = await createLatestReview(repoId, prNumber, "sha-a");
    expect((await agentAcquire(sessionA)).status).toBe(204);
    const sessionB = await createLatestReview(repoId, prNumber, "sha-b");

    const busy = await agentAcquire(sessionB);
    expect(busy.status).toBe(423);
    expect(Number(busy.headers.get("Retry-After"))).toBeGreaterThan(0);

    expect((await agentRelease(sessionA)).status).toBe(204);
    expect((await agentAcquire(sessionB)).status).toBe(204);
  });

  it("defers the latest review's close-out, keeping its fence, while an older review holds the lease", async () => {
    // P1-b: a close-out never treats another session's live lease as free.
    const repoId = 619191;
    const prNumber = 5;
    const sessionA = await createLatestReview(repoId, prNumber, "sha-a");
    expect((await agentAcquire(sessionA)).status).toBe(204);
    const sessionB = await createLatestReview(repoId, prNumber, "sha-b");

    expect((await closeOut(sessionB, REQUEST)).status).toBe(202);
    expect((await fenceRows(repoId, prNumber)).map((row) => row.session_id)).toEqual([
      sessionA,
      sessionB,
    ]);

    expect((await agentRelease(sessionA)).status).toBe(204);
    const grant = await closeOut(sessionB);
    expect(grant.status).toBe(200);
    await expect(grant.json<Grant>()).resolves.toMatchObject({
      headSha: "sha-b",
      superseded: false,
    });
  });

  it("records a close-out requested during the session's own lease, and the reaper re-drives it", async () => {
    // P2-d: a completion that arrives mid-write is deferred, not dropped.
    const repoId = 636363;
    const prNumber = 7;
    const sessionId = await createLatestReview(repoId, prNumber, "sha-a");
    expect((await agentAcquire(sessionId)).status).toBe(204);

    expect((await closeOut(sessionId, REQUEST)).status).toBe(202);
    const [row] = await fenceRows(repoId, prNumber);
    expect(JSON.parse(row.close_out_request ?? "null")).toEqual(REQUEST);
    // The turn is over: the agent cannot re-take the lease once it lapses or is released.
    expect((await agentAcquire(sessionId)).status).toBe(409);

    await expireLease(repoId, prNumber);
    const botFetch = vi.fn(async () => Response.json({ ok: true }));
    const drives: Promise<unknown>[] = [];
    await reapSupersededReviewSessions(
      sqlDatabase(env.DB),
      { fetch: vi.fn(async () => new Response(null, { status: 404 })) },
      {
        GITHUB_BOT: { fetch: botFetch },
        SERVICE_AUTH_SECRET_GITHUB_BOT: "reaper-test-secret",
      } as unknown as Env,
      { submit: (task) => void drives.push(task()) }
    );
    await Promise.all(drives);

    expect(botFetch).toHaveBeenCalledTimes(1);
    const [url, init] = botFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://internal/callbacks/review-close-out");
    const payload = JSON.parse(String(init.body)) as { sessionId: string; signature: string };
    expect(payload.sessionId).toBe(sessionId);
    await expect(verifyCallbackSignature(payload, "reaper-test-secret")).resolves.toBe(true);

    expect((await closeOut(sessionId)).status).toBe(200);
  });

  it("keeps the fence and its request after a failed attempt, so the close-out can be retried", async () => {
    // P2-e: nothing is deleted until GitHub has a terminal status.
    const repoId = 646464;
    const prNumber = 8;
    const sessionId = await createLatestReview(repoId, prNumber, "sha-a");
    expect((await closeOut(sessionId, REQUEST)).status).toBe(200);

    expect((await finalize(sessionId, "retry")).status).toBe(204);

    const [row] = await fenceRows(repoId, prNumber);
    expect(row.session_id).toBe(sessionId);
    expect(JSON.parse(row.close_out_request ?? "null")).toEqual(REQUEST);
    expect((await closeOut(sessionId)).status).toBe(200);
  });

  it("retains a replaced head's review for its own close-out instead of deleting it on sweep", async () => {
    // P2-c: the replaced head is closed out through its fence row, under the lease.
    const repoId = 656565;
    const prNumber = 9;
    const sessionA = await createLatestReview(repoId, prNumber, "sha-a");
    expect((await agentAcquire(sessionA)).status).toBe(204);
    const generationB = await claimGeneration(repoId, prNumber);
    const createB = await createReviewSession({
      repoId,
      prNumber,
      generation: generationB,
      headSha: "sha-b",
    });
    expect(createB.status).toBe(201);

    const sweep = await serviceFetch("https://test.local/internal/github-reviews/sweep", {
      method: "POST",
      service: "github-bot",
      body: JSON.stringify({ repoId, prNumber, generation: generationB, owner: "acme", repo: "w" }),
    });
    await expect(sweep.json()).resolves.toMatchObject({ deferredSessionIds: [sessionA] });
    const [rowA] = await fenceRows(repoId, prNumber);
    expect(rowA.session_id).toBe(sessionA);
    expect(JSON.parse(rowA.close_out_request ?? "null")).toEqual({
      owner: "acme",
      repo: "w",
      description: null,
    });

    // A's own lease is live: its in-flight write is never raced.
    expect((await closeOut(sessionA)).status).toBe(202);
    await expireLease(repoId, prNumber);
    const grant = await closeOut(sessionA);
    expect(grant.status).toBe(200);
    await expect(grant.json<Grant>()).resolves.toMatchObject({
      headSha: "sha-a",
      superseded: true,
    });
  });

  it("declines a superseded review whose head a newer review now owns, dropping its fence", async () => {
    const repoId = 626262;
    const prNumber = 6;
    const sessionA = await createLatestReview(repoId, prNumber, "sha-a");
    const sessionB = await createLatestReview(repoId, prNumber, "sha-a");

    expect((await closeOut(sessionA, REQUEST)).status).toBe(409);

    expect((await fenceRows(repoId, prNumber)).map((row) => row.session_id)).toEqual([sessionB]);
    expect((await agentAcquire(sessionB)).status).toBe(204);
  });

  it("grants a superseded review on a replaced head once its session is cancelled", async () => {
    const repoId = 627272;
    const prNumber = 6;
    const sessionA = await createLatestReview(repoId, prNumber, "sha-a");
    await createLatestReview(repoId, prNumber, "sha-b");

    const grant = await closeOut(sessionA, REQUEST);
    expect(grant.status).toBe(200);
    await expect(grant.json<Grant>()).resolves.toMatchObject({
      headSha: "sha-a",
      superseded: true,
    });
    expect((await new SessionIndexStore(env.DB).get(sessionA))?.status).toBe("cancelled");
  });

  it("garbage-collects fence rows older than a day", async () => {
    const repoId = 628282;
    const prNumber = 6;
    const sessionId = await createLatestReview(repoId, prNumber, "sha-a");
    await env.DB.prepare("UPDATE github_review_sessions SET created_at = ? WHERE session_id = ?")
      .bind(Date.now() - 25 * 60 * 60 * 1000, sessionId)
      .run();

    await reapSupersededReviewSessions(
      sqlDatabase(env.DB),
      { fetch: vi.fn(async () => new Response(null, { status: 404 })) },
      {} as Env,
      { submit: () => {} }
    );

    expect(await fenceRows(repoId, prNumber)).toEqual([]);
  });

  it("rejects a close-out or finalize from any caller other than the github-bot service", async () => {
    const sessionId = await createLatestReview(646464, 8, "sha-a");

    expect((await closeOut(sessionId, REQUEST, "slack-bot")).status).toBe(403);
    expect((await finalize(sessionId, "done", "slack-bot")).status).toBe(403);

    expect((await fenceRows(646464, 8)).map((row) => row.session_id)).toEqual([sessionId]);
  });
});
