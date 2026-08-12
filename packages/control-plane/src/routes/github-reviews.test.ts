import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import {
  githubReviewRoutes,
  handleClaimReviewGeneration,
  handleReviewLeaseRelease,
  handleReviewOwnership,
  handleSweepStaleReviews,
} from "./github-reviews";
import type { SessionRouteContext } from "./session-route";
import { parsePattern, type RequestContext } from "./shared";

const GITHUB_BOT_PRINCIPAL: Principal = { kind: "service", service: "github-bot", actor: null };
const OTHER_SERVICE_PRINCIPAL: Principal = { kind: "service", service: "slack-bot", actor: null };

function routeMatch(path: string, pattern: string): RegExpMatchArray {
  const match = path.match(parsePattern(pattern));
  if (!match) throw new Error("Expected route match");
  return match;
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Minimal SqlDatabase double: dispatches on the leading SQL keywords the
 * routes actually issue (claim INSERT..RETURNING, sweep SELECT, sweep
 * DELETE) rather than modeling a real engine.
 */
function createFakeDb(
  config: {
    claimGeneration?: number;
    staleSessionIds?: string[];
    staleRowCreatedAt?: number;
    /** Lease columns returned on stale rows (sweep/reaper defer test). */
    staleRowLease?: { lease_session_id: string; lease_expires_at: number };
    /** meta.changes for the lease-acquire UPDATE (ownership handler). */
    leaseAcquireChanges?: number;
  } = {}
): {
  db: SqlDatabase;
  deletedSessionIds: string[];
  leaseReleases: number;
} {
  const deletedSessionIds: string[] = [];
  const counters = { leaseReleases: 0 };
  const db = {
    prepare(sql: string) {
      const trimmed = sql.trim();
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (trimmed.startsWith("INSERT INTO github_review_state")) {
                return { latest_generation: config.claimGeneration ?? 1 } as unknown as T;
              }
              return null;
            },
            async all<T>() {
              if (trimmed.startsWith("SELECT grs.session_id")) {
                const ids = config.staleSessionIds ?? [];
                // Default to epoch 0: rows old enough that a 404 proves a
                // true orphan. Fresh-row tests override staleRowCreatedAt.
                const created_at = config.staleRowCreatedAt ?? 0;
                const lease = config.staleRowLease ?? {
                  lease_session_id: null,
                  lease_expires_at: null,
                };
                return {
                  results: ids.map((session_id) => ({
                    session_id,
                    created_at,
                    ...lease,
                  })) as unknown as T[],
                  meta: { changes: 0 },
                };
              }
              return { results: [] as T[], meta: { changes: 0 } };
            },
            async run<T>() {
              if (trimmed.startsWith("DELETE FROM github_review_sessions")) {
                deletedSessionIds.push(values[2] as string);
              }
              if (trimmed.startsWith("UPDATE github_review_state SET lease_session_id = NULL")) {
                counters.leaseReleases += 1;
                return { results: [] as T[], meta: { changes: 1 } };
              }
              if (trimmed.startsWith("UPDATE github_review_state SET lease_session_id")) {
                return { results: [] as T[], meta: { changes: config.leaseAcquireChanges ?? 1 } };
              }
              return { results: [] as T[], meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch() {
      return [];
    },
  } as unknown as SqlDatabase;
  return {
    db,
    deletedSessionIds,
    get leaseReleases() {
      return counters.leaseReleases;
    },
  };
}

function requestContext(db: SqlDatabase, principal?: Principal): RequestContext {
  return {
    db,
    metrics: {} as RequestContext["metrics"],
    request_id: "request-id",
    trace_id: "trace-id",
    principal,
  };
}

function sweepContext(
  db: SqlDatabase,
  fetchImpl: SessionRuntimeClient["fetch"],
  principal?: Principal
): SessionRouteContext {
  return { ...requestContext(db, principal), sessionRuntime: { fetch: fetchImpl } };
}

describe("auth gating", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["/internal/github-reviews/claim", { repoId: 1, prNumber: 2 }],
    ["/internal/github-reviews/sweep", { repoId: 1, prNumber: 2, generation: 3 }],
  ])("rejects %s from a non-github-bot principal", async (path, body) => {
    const route = githubReviewRoutes.find((r) => r.pattern.test(path));
    if (!route) throw new Error(`No route registered for ${path}`);
    const { db } = createFakeDb();

    const response = await route.handler(
      jsonRequest(`https://test.local${path}`, body),
      {} as Env,
      routeMatch(path, path),
      requestContext(db, OTHER_SERVICE_PRINCIPAL)
    );

    expect(response.status).toBe(401);
  });

  it.each([
    ["/internal/github-reviews/claim", { repoId: 1, prNumber: 2 }],
    ["/internal/github-reviews/sweep", { repoId: 1, prNumber: 2, generation: 3 }],
  ])("rejects %s from an unauthenticated request", async (path, body) => {
    const route = githubReviewRoutes.find((r) => r.pattern.test(path));
    if (!route) throw new Error(`No route registered for ${path}`);
    const { db } = createFakeDb();

    const response = await route.handler(
      jsonRequest(`https://test.local${path}`, body),
      {} as Env,
      routeMatch(path, path),
      requestContext(db, undefined)
    );

    expect(response.status).toBe(401);
  });
});

describe("handleClaimReviewGeneration", () => {
  it("returns the generation the atomic upsert produced", async () => {
    const { db } = createFakeDb({ claimGeneration: 4 });

    const response = await handleClaimReviewGeneration(
      jsonRequest("https://test.local/internal/github-reviews/claim", {
        repoId: 555,
        prNumber: 42,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/claim", "/internal/github-reviews/claim"),
      requestContext(db, GITHUB_BOT_PRINCIPAL)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ generation: 4 });
  });

  it("rejects a non-positive prNumber", async () => {
    const { db } = createFakeDb();

    const response = await handleClaimReviewGeneration(
      jsonRequest("https://test.local/internal/github-reviews/claim", {
        repoId: 555,
        prNumber: 0,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/claim", "/internal/github-reviews/claim"),
      requestContext(db, GITHUB_BOT_PRINCIPAL)
    );

    expect(response.status).toBe(400);
  });
});

describe("handleSweepStaleReviews", () => {
  afterEach(() => vi.restoreAllMocks());

  it("cancels a stale session with no descendants and deletes its row", async () => {
    vi.spyOn(SessionIndexStore.prototype, "listActiveDescendantIds").mockResolvedValue([]);
    const { db, deletedSessionIds } = createFakeDb({ staleSessionIds: ["stale-1"] });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => Response.json({ status: "ok" }));

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: ["stale-1"],
      failedSessionIds: [],
    });
    expect(deletedSessionIds).toEqual(["stale-1"]);
  });

  it("treats a 409 primary cancel as already-terminal and deletes the row", async () => {
    vi.spyOn(SessionIndexStore.prototype, "listActiveDescendantIds").mockResolvedValue([]);
    const { db, deletedSessionIds } = createFakeDb({ staleSessionIds: ["stale-409"] });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
      Response.json({ error: "already terminal" }, { status: 409 })
    );

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: ["stale-409"],
      failedSessionIds: [],
    });
    expect(deletedSessionIds).toEqual(["stale-409"]);
  });

  it("treats a 404 primary cancel on an aged row as an orphaned DO and deletes it", async () => {
    const listActiveDescendantIds = vi.spyOn(
      SessionIndexStore.prototype,
      "listActiveDescendantIds"
    );
    const { db, deletedSessionIds } = createFakeDb({ staleSessionIds: ["stale-404"] });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
      Response.json({ error: "not found" }, { status: 404 })
    );

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: ["stale-404"],
      failedSessionIds: [],
    });
    expect(deletedSessionIds).toEqual(["stale-404"]);
    // A 404 means the DO never existed — no descendants to look up.
    expect(listActiveDescendantIds).not.toHaveBeenCalled();
  });

  it("retains a fresh row on a 404 — its create may still be mid-init", async () => {
    const listActiveDescendantIds = vi.spyOn(
      SessionIndexStore.prototype,
      "listActiveDescendantIds"
    );
    const { db, deletedSessionIds } = createFakeDb({
      staleSessionIds: ["stale-fresh-404"],
      staleRowCreatedAt: Date.now(),
    });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
      Response.json({ error: "not found" }, { status: 404 })
    );

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: [],
      failedSessionIds: ["stale-fresh-404"],
    });
    expect(deletedSessionIds).toEqual([]);
    expect(listActiveDescendantIds).not.toHaveBeenCalled();
  });

  it("keeps the row and reports failure when the primary cancel errors", async () => {
    const { db, deletedSessionIds } = createFakeDb({ staleSessionIds: ["stale-failed"] });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
      Response.json({ error: "internal error" }, { status: 500 })
    );

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: [],
      failedSessionIds: ["stale-failed"],
    });
    expect(deletedSessionIds).toEqual([]);
  });

  it("keeps the row when a descendant cancel fails, but tolerates a 409 descendant", async () => {
    vi.spyOn(SessionIndexStore.prototype, "listActiveDescendantIds").mockImplementation(
      async (sessionId) => (sessionId === "with-bad-descendant" ? ["child-1"] : ["child-2"])
    );
    const { db, deletedSessionIds } = createFakeDb({
      staleSessionIds: ["with-bad-descendant", "with-terminal-descendant"],
    });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async (sessionId) => {
      if (sessionId === "child-1") return Response.json({ error: "failure" }, { status: 500 });
      if (sessionId === "child-2") return Response.json({ error: "terminal" }, { status: 409 });
      return Response.json({ status: "ok" });
    });

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: ["with-terminal-descendant"],
      failedSessionIds: ["with-bad-descendant"],
    });
    expect(deletedSessionIds).toEqual(["with-terminal-descendant"]);
  });

  it("rejects a non-positive generation", async () => {
    const { db } = createFakeDb();

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: -1,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, vi.fn(), GITHUB_BOT_PRINCIPAL)
    );

    expect(response.status).toBe(400);
  });
});

describe("handleReviewOwnership / handleReviewLeaseRelease", () => {
  const OWNERSHIP_PATH = "/sessions/session-1/review-ownership";
  const OWNERSHIP_PATTERN = "/sessions/:id/review-ownership";
  const SANDBOX_PRINCIPAL: Principal = { kind: "sandbox", sessionId: "session-1" };

  function ownershipRequest(method = "GET"): Request {
    return new Request(`https://test.local${OWNERSHIP_PATH}`, { method });
  }

  it("returns 204 and acquires the lease while the caller is the latest generation", async () => {
    const { db } = createFakeDb({ leaseAcquireChanges: 1 });

    const response = await handleReviewOwnership(
      ownershipRequest(),
      {} as Env,
      routeMatch(OWNERSHIP_PATH, OWNERSHIP_PATTERN),
      requestContext(db, SANDBOX_PRINCIPAL)
    );

    expect(response.status).toBe(204);
  });

  it("returns 409 when superseded, swept, or another session holds an unexpired lease", async () => {
    // The atomic UPDATE matches no row in all three cases; the handler only
    // observes changes === 0.
    const { db } = createFakeDb({ leaseAcquireChanges: 0 });

    const response = await handleReviewOwnership(
      ownershipRequest(),
      {} as Env,
      routeMatch(OWNERSHIP_PATH, OWNERSHIP_PATTERN),
      requestContext(db, SANDBOX_PRINCIPAL)
    );

    expect(response.status).toBe(409);
  });

  it("release clears only the caller's lease and returns 204", async () => {
    const fake = createFakeDb();

    const response = await handleReviewLeaseRelease(
      ownershipRequest("DELETE"),
      {} as Env,
      routeMatch(OWNERSHIP_PATH, OWNERSHIP_PATTERN),
      requestContext(fake.db, SANDBOX_PRINCIPAL)
    );

    expect(response.status).toBe(204);
    expect(fake.leaseReleases).toBe(1);
  });

  it.each([
    ["a service principal", GITHUB_BOT_PRINCIPAL],
    [
      "a sandbox principal for a different session",
      { kind: "sandbox", sessionId: "other" } as Principal,
    ],
    ["no principal", undefined],
  ])("rejects %s on acquire and release", async (_name, principal) => {
    const { db } = createFakeDb({ leaseAcquireChanges: 1 });
    const match = routeMatch(OWNERSHIP_PATH, OWNERSHIP_PATTERN);

    const acquire = await handleReviewOwnership(
      ownershipRequest(),
      {} as Env,
      match,
      requestContext(db, principal)
    );
    const release = await handleReviewLeaseRelease(
      ownershipRequest("DELETE"),
      {} as Env,
      match,
      requestContext(db, principal)
    );

    expect(acquire.status).toBe(401);
    expect(release.status).toBe(401);
  });
});

describe("sweep lease deferral", () => {
  it("retains a stale row whose session holds an unexpired submission lease", async () => {
    const { db, deletedSessionIds } = createFakeDb({
      staleSessionIds: ["leaseholder"],
      staleRowLease: { lease_session_id: "leaseholder", lease_expires_at: Date.now() + 60_000 },
    });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => Response.json({ status: "ok" }));

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: [],
      failedSessionIds: ["leaseholder"],
    });
    expect(deletedSessionIds).toEqual([]);
    // The cancel must never even be attempted against the leaseholder's DO.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels normally once the leaseholder's lease has expired", async () => {
    vi.spyOn(SessionIndexStore.prototype, "listActiveDescendantIds").mockResolvedValue([]);
    const { db, deletedSessionIds } = createFakeDb({
      staleSessionIds: ["expired-lease"],
      staleRowLease: { lease_session_id: "expired-lease", lease_expires_at: Date.now() - 1000 },
    });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => Response.json({ status: "ok" }));

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: ["expired-lease"],
      failedSessionIds: [],
    });
    expect(deletedSessionIds).toEqual(["expired-lease"]);
  });
});
