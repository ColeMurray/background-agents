/**
 * End-to-end GitHub review supersession (design: review-supersede, fix A):
 * claim a generation, fence a session-create on it, claim again, verify the
 * now-stale generation is rejected, then sweep cancels the superseded
 * session and drops its row while the current one survives.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

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

  it("rejects claim, create, and sweep from callers other than the github-bot service", async () => {
    const claimFromWrongService = await serviceFetch(
      "https://test.local/internal/github-reviews/claim",
      {
        method: "POST",
        service: "slack-bot",
        body: JSON.stringify({ repoId: 1, prNumber: 1 }),
      }
    );
    expect(claimFromWrongService.status).toBe(401);

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
    expect(sweepFromWrongService.status).toBe(401);
  });
});
