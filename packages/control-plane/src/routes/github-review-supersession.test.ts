import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubPrReviewStore } from "../db/github-pr-review-store";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import type { SqlDatabase } from "../db/sql-database";
import { SessionInternalPaths } from "../session/contracts";
import type { SessionRouteContext } from "./session-route";
import { handleGitHubReviewSupersession } from "./github-review-supersession";

const migration = readFileSync(
  fileURLToPath(
    new NodeURL(
      "../../../../terraform/d1/migrations/0095_github_pr_review_sessions.sql",
      import.meta.url
    )
  ),
  "utf8"
);

function claimRequest(sessionId: string): Request {
  return new Request("https://internal/internal/github-reviews/supersede", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, repositoryId: 99, pullNumber: 42 }),
  });
}

describe("POST /internal/github-reviews/supersede cancellation", () => {
  let sqlite: DatabaseSync;
  let db: SqlDatabase;
  let cancelled: string[];
  let cancelResult: (sessionId: string) => Response | Promise<Response>;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(migration);
    db = createNodeSqlDatabase(sqlite);
    cancelled = [];
    cancelResult = () => Response.json({ status: "cancelled" });
  });

  afterEach(() => sqlite.close());

  function context(): SessionRouteContext {
    return {
      db,
      principal: { kind: "service", service: "github-bot", actor: null },
      trace_id: "trace",
      request_id: "request",
      sessionRuntime: {
        fetch: async (sessionId, path) => {
          expect(path).toBe(SessionInternalPaths.cancel);
          cancelled.push(sessionId);
          return cancelResult(sessionId);
        },
      },
    } as SessionRouteContext;
  }

  it("does not supersede a review whose cancellation fails", async () => {
    cancelResult = (sessionId) =>
      sessionId === "review-old"
        ? new Response("unavailable", { status: 500 })
        : Response.json({ status: "cancelled" });

    const started = await handleGitHubReviewSupersession(
      claimRequest("review-old"),
      {} as never,
      {},
      context()
    );
    expect(started.status).toBe(200);
    expect(cancelled).toEqual([]);

    const failed = await handleGitHubReviewSupersession(
      claimRequest("review-new"),
      {} as never,
      {},
      context()
    );
    expect(failed.status).toBe(503);
    expect(cancelled).toEqual(["review-old"]);

    const store = new GitHubPrReviewStore(db);
    await expect(store.isSuperseded("review-old")).resolves.toBe(false);
    await expect(store.isSuperseded("review-new")).resolves.toBe(true);
    expect(
      sqlite
        .prepare(
          `SELECT session_id FROM github_pr_review_sessions
           WHERE repository_id = 99 AND pull_number = 42 AND superseded_by IS NULL`
        )
        .get()
    ).toEqual({ session_id: "review-old" });

    cancelResult = () => Response.json({ status: "cancelled" });
    const retried = await handleGitHubReviewSupersession(
      claimRequest("review-retry"),
      {} as never,
      {},
      context()
    );
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toEqual({ displacedSessionIds: ["review-old"] });
    expect(cancelled).toEqual(["review-old", "review-old"]);
    await expect(store.isSuperseded("review-old")).resolves.toBe(true);
    await expect(store.isSuperseded("review-retry")).resolves.toBe(false);
  });

  it.each([404, 409])("keeps the supersession when cancel returns %s", async (status) => {
    await handleGitHubReviewSupersession(claimRequest("review-old"), {} as never, {}, context());
    cancelResult = () => new Response(null, { status });

    const replaced = await handleGitHubReviewSupersession(
      claimRequest("review-new"),
      {} as never,
      {},
      context()
    );
    expect(replaced.status).toBe(200);
    const store = new GitHubPrReviewStore(db);
    await expect(store.isSuperseded("review-old")).resolves.toBe(true);
    await expect(store.isSuperseded("review-new")).resolves.toBe(false);
  });
});
