import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeSession,
  ReviewGenerationSupersededError,
  type SessionInitInput,
} from "./initialize";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import { fakeSessionRuntimeDispatch } from "../router.test-support";
import { resolvedPin } from "./pinned";

vi.mock("../db/session-index", () => ({
  SessionIndexStore: vi.fn(),
}));

describe("initializeSession", () => {
  const baseInput: SessionInitInput = {
    sessionId: "session-123",
    ownerTeamId: null,
    visibility: "workspace",
    harness: "opencode",
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 42,
    defaultBranch: "main",
    branch: "feature-1",
    title: "Test session",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    participantUserId: "user-1",
    platformUserId: "platform-user-1",
    participantCanonicalUserId: "platform-user-1",
    scmLogin: "acmedev",
    scmName: "Acme Dev",
    scmEmail: "dev@acme.test",
    scmUserId: "scm-1",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    codeServerEnabled: false,
    vncEnabled: true,
    sandboxSettings: {},
    automationId: null,
    automationRunId: null,
    memory: resolvedPin({
      selectionVersion: 1,
      manifestSha256: "0".repeat(64),
      resolvedAt: 1,
      personalOwnerUserId: null,
      directiveChars: 0,
      catalogChars: 0,
      estimatedTokens: 0,
      omittedCount: 0,
      items: [],
    }),
    managedSkills: resolvedPin({
      selection: { mode: "all" },
      resolverVersion: 1,
      manifestSha256: "0".repeat(64),
      resolvedAt: 1,
      skills: [],
    }),
    providerAuth: [
      {
        provider: "openai",
        authMode: "provider_account",
        providerAccountId: "1".repeat(32),
        selectionSource: "installation_default",
      },
      { provider: "xai", authMode: "api_key", selectionSource: "fallback_api_key" },
    ],
  };

  const ctx = {
    trace_id: "trace-abc",
    request_id: "req-xyz",
    metrics: { queries: [], totalQueryDurationMs: 0 },
  };

  let createMock: ReturnType<typeof vi.fn>;
  let updateStatusMock: ReturnType<typeof vi.fn>;
  let stubFetchMock: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>;

  function createEnv(sandboxProvider?: string) {
    return {
      DB: {} as SqlDatabase,
      SESSION: fakeSessionRuntimeDispatch((request) => stubFetchMock(request)),
      SANDBOX_PROVIDER: sandboxProvider,
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    createMock = vi.fn().mockResolvedValue(undefined);
    updateStatusMock = vi.fn().mockResolvedValue(true);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create: createMock, updateStatus: updateStatusMock } as never;
    });

    stubFetchMock = vi.fn(async () => Response.json({ status: "created" }));
  });

  describe("github review supersession", () => {
    const reviewInput: SessionInitInput = {
      ...baseInput,
      githubReview: { repoId: 7, prNumber: 9, generation: 1, headSha: "sha-1" },
    };

    function createReviewDb(config: { fenceChanges?: number; latestGeneration: number | null }): {
      db: unknown;
      deletes: unknown[][];
    } {
      const deletes: unknown[][] = [];
      const db = {
        prepare(sql: string) {
          const trimmed = sql.trim();
          return {
            bind(...values: unknown[]) {
              return {
                async run() {
                  if (trimmed.startsWith("DELETE FROM github_review_sessions")) {
                    deletes.push(values);
                    return { meta: { changes: 1 } };
                  }
                  return { meta: { changes: config.fenceChanges ?? 1 } };
                },
                async first() {
                  if (
                    trimmed.startsWith("SELECT latest_generation") &&
                    config.latestGeneration !== null
                  ) {
                    return { latest_generation: config.latestGeneration };
                  }
                  return null;
                },
              };
            },
          };
        },
      };
      return { db, deletes };
    }

    function reviewCtx(db: unknown) {
      return { ...ctx, db } as never;
    }

    it("rejects a stale-generation create before any D1 row or DO init", async () => {
      const { db } = createReviewDb({ fenceChanges: 0, latestGeneration: 2 });

      await expect(initializeSession(createEnv(), reviewInput, reviewCtx(db))).rejects.toThrow(
        ReviewGenerationSupersededError
      );
      expect(createMock).not.toHaveBeenCalled();
      expect(stubFetchMock).not.toHaveBeenCalled();
    });

    it("deletes the review fence when the D1 session insert fails", async () => {
      const { db, deletes } = createReviewDb({ latestGeneration: 1 });
      createMock.mockRejectedValue(new Error("D1 unavailable"));

      await expect(initializeSession(createEnv(), reviewInput, reviewCtx(db))).rejects.toThrow(
        "D1 unavailable"
      );

      expect(deletes).toEqual([[7, 9, 1]]);
      expect(stubFetchMock).not.toHaveBeenCalled();
    });

    it("deletes the review fence when DO init returns a non-ok response", async () => {
      const { db, deletes } = createReviewDb({ latestGeneration: 1 });
      stubFetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));

      await expect(initializeSession(createEnv(), reviewInput, reviewCtx(db))).rejects.toThrow(
        "Failed to initialize session DO: 503"
      );

      expect(deletes).toEqual([[7, 9, 1]]);
      expect(updateStatusMock).toHaveBeenCalledWith("session-123", "failed");
    });

    /** DO init rejects in transport; the draft-expiry probe answers with `probe`. */
    function initRejectsThenProbe(probe: () => Promise<Response>) {
      return vi.fn(async (req: Request) =>
        req.url.includes("/internal/expire-draft")
          ? probe()
          : Promise.reject(new Error("transport"))
      );
    }

    it("retains the review fence when DO init throws and the session cannot be confirmed idle", async () => {
      // The runtime may have committed init and scheduled warming before the transport failed.
      const { db, deletes } = createReviewDb({ latestGeneration: 1 });
      stubFetchMock = initRejectsThenProbe(() => Promise.reject(new Error("still down")));

      await expect(initializeSession(createEnv(), reviewInput, reviewCtx(db))).rejects.toThrow(
        "transport"
      );

      expect(deletes).toEqual([]);
      expect(updateStatusMock).toHaveBeenCalledWith("session-123", "failed");
    });

    it("retains the review fence when DO init throws but the session reports it is not a draft", async () => {
      const { db, deletes } = createReviewDb({ latestGeneration: 1 });
      stubFetchMock = initRejectsThenProbe(async () =>
        Response.json({ outcome: "not_draft", status: "active" })
      );

      await expect(initializeSession(createEnv(), reviewInput, reviewCtx(db))).rejects.toThrow(
        "transport"
      );

      expect(deletes).toEqual([]);
    });

    it("retains the review fence when DO init throws and no session exists yet", async () => {
      // F9: an init still in flight can land after a 404, so it proves nothing.
      const { db, deletes } = createReviewDb({ latestGeneration: 1 });
      stubFetchMock = initRejectsThenProbe(async () => Response.json({}, { status: 404 }));

      await expect(initializeSession(createEnv(), reviewInput, reviewCtx(db))).rejects.toThrow(
        "transport"
      );

      expect(deletes).toEqual([]);
    });

    it("deletes the review fence when DO init throws and its never-prompted session was archived", async () => {
      const { db, deletes } = createReviewDb({ latestGeneration: 1 });
      stubFetchMock = initRejectsThenProbe(async () =>
        Response.json({ outcome: "archived", status: "archived" })
      );

      await expect(initializeSession(createEnv(), reviewInput, reviewCtx(db))).rejects.toThrow(
        "transport"
      );

      expect(deletes).toEqual([[7, 9, 1]]);
      expect(updateStatusMock).toHaveBeenCalledWith("session-123", "failed");
    });

    it("completes when the generation is still the latest after DO init", async () => {
      const { db, deletes } = createReviewDb({ latestGeneration: 1 });

      const result = await initializeSession(createEnv(), reviewInput, reviewCtx(db));

      expect(result).toEqual({ sessionId: "session-123", status: "created" });
      expect(deletes).toEqual([]);
      const cancelCalls = (stubFetchMock.mock.calls as unknown as [Request][]).filter(([req]) =>
        req.url.includes("/internal/cancel")
      );
      expect(cancelCalls).toEqual([]);
    });

    it("self-cancels and deletes its fence row when a newer generation claimed during init", async () => {
      const { db, deletes } = createReviewDb({ latestGeneration: 2 });
      stubFetchMock = vi.fn(async (req: Request) =>
        req.url.includes("/internal/cancel")
          ? new Response(null, { status: 200 })
          : Response.json({ status: "created" })
      );

      await expect(initializeSession(createEnv(), reviewInput, reviewCtx(db))).rejects.toThrow(
        ReviewGenerationSupersededError
      );
      const cancelCalls = (stubFetchMock.mock.calls as unknown as [Request][]).filter(([req]) =>
        req.url.includes("/internal/cancel")
      );
      expect(cancelCalls).toHaveLength(1);
      expect(deletes).toHaveLength(1);
      expect(updateStatusMock).toHaveBeenCalledWith("session-123", "failed");
    });

    it("retains the fence row when the self-cancel is not confirmed", async () => {
      const { db, deletes } = createReviewDb({ latestGeneration: 2 });
      stubFetchMock = vi.fn(async (req: Request) =>
        req.url.includes("/internal/cancel")
          ? Response.json({ error: "unavailable" }, { status: 503 })
          : Response.json({ status: "created" })
      );

      await expect(initializeSession(createEnv(), reviewInput, reviewCtx(db))).rejects.toThrow(
        ReviewGenerationSupersededError
      );
      expect(deletes).toEqual([]);
      expect(updateStatusMock).toHaveBeenCalledWith("session-123", "failed");
    });
  });
});
