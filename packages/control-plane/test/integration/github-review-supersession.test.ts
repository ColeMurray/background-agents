/**
 * End-to-end GitHub review supersession (design: review-supersede, fix A):
 * claim a generation, fence a session-create on it, claim again, verify the
 * now-stale generation is rejected, then sweep cancels the superseded
 * session and drops its row while the current one survives.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { handleReviewOwnership } from "../../src/routes/github-reviews";
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

describe("GitHub review close-out (a turn ended; who writes the terminal status)", () => {
  beforeEach(cleanD1Tables);

  function closeOut(sessionId: string, service: "github-bot" | "slack-bot" = "github-bot") {
    return serviceFetch("https://test.local/internal/github-reviews/close-out", {
      method: "POST",
      service,
      body: JSON.stringify({ sessionId }),
    });
  }

  async function createLatestReview(repoId: number, prNumber: number, headSha: string) {
    const generation = await claimGeneration(repoId, prNumber);
    const create = await createReviewSession({ repoId, prNumber, generation, headSha });
    expect(create.status).toBe(201);
    return (await create.json<CreateSessionResponse>()).sessionId;
  }

  /** The agent's own submission fence, run against the real D1 exactly as its route runs it. */
  function agentOwnershipCheck(sessionId: string): Promise<Response> {
    const ctx = {
      db: sqlDatabase(env.DB),
      metrics: {},
      request_id: "request-id",
      trace_id: "trace-id",
      executionCtx: { submit: () => {} },
      principal: { kind: "sandbox", sessionId },
    } as unknown as RequestContext;
    return handleReviewOwnership(
      new Request(`https://test.local/sessions/${sessionId}/review-ownership`),
      env as unknown as Env,
      { id: sessionId },
      ctx
    );
  }

  it("grants the latest review's close-out once, and fences its agent out of any later publish", async () => {
    const sessionId = await createLatestReview(616161, 5, "sha-a");

    expect((await closeOut(sessionId)).status).toBe(204);

    const rows = await env.DB.prepare("SELECT session_id FROM github_review_sessions").all<{
      session_id: string;
    }>();
    expect(rows.results).toEqual([]);
    // An agent that wakes after its turn was failed can no longer take the lease.
    expect((await agentOwnershipCheck(sessionId)).status).toBe(409);
    // A redelivered completion finds nothing left to own.
    expect((await closeOut(sessionId)).status).toBe(409);
  });

  it("declines a superseded review, leaving the successor's fence intact", async () => {
    const repoId = 626262;
    const prNumber = 6;
    const sessionA = await createLatestReview(repoId, prNumber, "sha-a");
    const sessionB = await createLatestReview(repoId, prNumber, "sha-b");

    expect((await closeOut(sessionA)).status).toBe(409);

    const rows = await env.DB.prepare(
      "SELECT session_id FROM github_review_sessions WHERE repo_id = ? AND pr_number = ? ORDER BY generation"
    )
      .bind(repoId, prNumber)
      .all<{ session_id: string }>();
    expect(rows.results).toEqual([{ session_id: sessionA }, { session_id: sessionB }]);
    expect((await agentOwnershipCheck(sessionB)).status).toBe(204);
  });

  it("defers while the session holds a live submission lease, and grants once it has expired", async () => {
    const repoId = 636363;
    const prNumber = 7;
    const sessionId = await createLatestReview(repoId, prNumber, "sha-a");

    expect((await agentOwnershipCheck(sessionId)).status).toBe(204);
    expect((await closeOut(sessionId)).status).toBe(409);

    await env.DB.prepare(
      "UPDATE github_review_state SET lease_expires_at = ? WHERE repo_id = ? AND pr_number = ?"
    )
      .bind(Date.now() - 1, repoId, prNumber)
      .run();
    expect((await closeOut(sessionId)).status).toBe(204);
  });

  it("rejects a close-out from any caller other than the github-bot service", async () => {
    const sessionId = await createLatestReview(646464, 8, "sha-a");

    expect((await closeOut(sessionId, "slack-bot")).status).toBe(403);

    const rows = await env.DB.prepare("SELECT session_id FROM github_review_sessions").all<{
      session_id: string;
    }>();
    expect(rows.results).toEqual([{ session_id: sessionId }]);
  });
});
