import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeSession,
  ReviewGenerationSupersededError,
  type SessionInitInput,
} from "./initialize";
import { SessionIndexStore } from "../db/session-index";
import { SessionInternalPaths } from "./contracts";

vi.mock("../db/session-index", () => ({
  SessionIndexStore: vi.fn(),
}));

describe("initializeSession", () => {
  const baseInput: SessionInitInput = {
    sessionId: "session-123",
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
    scmLogin: "acmedev",
    scmName: "Acme Dev",
    scmEmail: "dev@acme.test",
    scmUserId: "scm-1",
    scmTokenEncrypted: "enc-token",
    scmRefreshTokenEncrypted: "enc-refresh",
    scmTokenExpiresAt: 1700000000000,
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    codeServerEnabled: false,
    vncEnabled: true,
    sandboxSettings: {},
    automationId: null,
    automationRunId: null,
  };

  const ctx = {
    trace_id: "trace-abc",
    request_id: "req-xyz",
    metrics: { queries: [], totalQueryDurationMs: 0 },
  };

  let createMock: ReturnType<typeof vi.fn>;
  let updateStatusMock: ReturnType<typeof vi.fn>;
  let stubFetchMock: ReturnType<typeof vi.fn>;

  function createEnv() {
    return {
      DB: {} as D1Database,
      SESSION: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: stubFetchMock }),
      },
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

  it("writes D1 before calling DO init", async () => {
    await initializeSession(createEnv(), baseInput, ctx as never);

    expect(createMock).toHaveBeenCalledOnce();
    expect(stubFetchMock).toHaveBeenCalledOnce();
    expect(createMock.mock.invocationCallOrder[0]).toBeLessThan(
      stubFetchMock.mock.invocationCallOrder[0]
    );
  });

  it("throws when D1 write fails and does not call DO init", async () => {
    createMock.mockRejectedValue(new Error("D1 unavailable"));

    await expect(initializeSession(createEnv(), baseInput, ctx as never)).rejects.toThrow(
      "D1 unavailable"
    );
    expect(createMock).toHaveBeenCalledOnce();
    expect(stubFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["repoId without repository context", { repoOwner: null, repoName: null, repoId: 42 }],
    ["repository context without repoId", { repoOwner: "acme", repoName: "web-app", repoId: null }],
  ])("rejects invalid repository tuples before writing D1: %s", async (_name, repoFields) => {
    await expect(
      initializeSession(createEnv(), { ...baseInput, ...repoFields }, ctx as never)
    ).rejects.toThrow("Repository context must include repoOwner, repoName, and repoId together");

    expect(createMock).not.toHaveBeenCalled();
    expect(stubFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["branch", { branch: "feature-1", defaultBranch: null }],
    ["defaultBranch", { branch: null, defaultBranch: "main" }],
  ])("rejects %s for no-repository sessions before writing D1", async (_name, branchFields) => {
    await expect(
      initializeSession(
        createEnv(),
        {
          ...baseInput,
          repoOwner: null,
          repoName: null,
          repoId: null,
          ...branchFields,
        },
        ctx as never
      )
    ).rejects.toThrow("No-repository sessions must not include branch context");

    expect(createMock).not.toHaveBeenCalled();
    expect(stubFetchMock).not.toHaveBeenCalled();
  });

  it("normalizes branch fields to null for no-repository sessions", async () => {
    await initializeSession(
      createEnv(),
      {
        ...baseInput,
        repoOwner: null,
        repoName: null,
        repoId: null,
        branch: null,
        defaultBranch: null,
      },
      ctx as never
    );

    const d1Entry = createMock.mock.calls[0][0];
    expect(d1Entry.baseBranch).toBeNull();

    const request = stubFetchMock.mock.calls[0][0] as Request;
    const body = (await request.json()) as Record<string, unknown>;
    expect(body.defaultBranch).toBeNull();
    expect(body.branch).toBeNull();
  });

  it("throws when DO init returns a non-ok response", async () => {
    stubFetchMock.mockResolvedValue(new Response("Internal error", { status: 500 }));

    await expect(initializeSession(createEnv(), baseInput, ctx as never)).rejects.toThrow(
      "Failed to initialize session DO: 500"
    );
    expect(createMock).toHaveBeenCalledOnce();
    expect(stubFetchMock).toHaveBeenCalledOnce();
  });

  it("marks D1 row as failed when DO init returns a non-ok response", async () => {
    stubFetchMock.mockResolvedValue(new Response("Internal error", { status: 500 }));

    await expect(initializeSession(createEnv(), baseInput, ctx as never)).rejects.toThrow();
    expect(updateStatusMock).toHaveBeenCalledWith("session-123", "failed");
  });

  it("marks D1 row as failed when DO init throws a transport error", async () => {
    stubFetchMock.mockRejectedValue(new Error("network failure"));

    await expect(initializeSession(createEnv(), baseInput, ctx as never)).rejects.toThrow(
      "network failure"
    );
    expect(updateStatusMock).toHaveBeenCalledWith("session-123", "failed");
  });

  it("passes the correct fields to D1 session index", async () => {
    await initializeSession(createEnv(), baseInput, ctx as never);

    const d1Entry = createMock.mock.calls[0][0];
    expect(d1Entry.id).toBe("session-123");
    expect(d1Entry.title).toBe("Test session");
    expect(d1Entry.repoOwner).toBe("acme");
    expect(d1Entry.repoName).toBe("web-app");
    expect(d1Entry.model).toBe("anthropic/claude-sonnet-4-6");
    expect(d1Entry.reasoningEffort).toBeNull();
    expect(d1Entry.baseBranch).toBe("feature-1");
    expect(d1Entry.status).toBe("created");
    expect(d1Entry.parentSessionId).toBeNull();
    expect(d1Entry.spawnSource).toBe("user");
    expect(d1Entry.spawnDepth).toBe(0);
    expect(d1Entry.automationId).toBeNull();
    expect(d1Entry.automationRunId).toBeNull();
    expect(d1Entry.scmLogin).toBe("acmedev");
    expect(d1Entry.userId).toBe("platform-user-1");
    expect(d1Entry.createdAt).toBeTypeOf("number");
    expect(d1Entry.updatedAt).toBeTypeOf("number");
  });

  it("passes automation lineage to D1 session index", async () => {
    await initializeSession(
      createEnv(),
      {
        ...baseInput,
        spawnSource: "automation",
        automationId: "auto-1",
        automationRunId: "run-1",
      },
      ctx as never
    );

    const d1Entry = createMock.mock.calls[0][0];
    expect(d1Entry.spawnSource).toBe("automation");
    expect(d1Entry.automationId).toBe("auto-1");
    expect(d1Entry.automationRunId).toBe("run-1");
  });

  it("sends the correct body to DO init endpoint", async () => {
    await initializeSession(createEnv(), baseInput, ctx as never);

    const request = stubFetchMock.mock.calls[0][0] as Request;
    expect(new URL(request.url).pathname).toBe(SessionInternalPaths.init);
    expect(request.method).toBe("POST");

    const body = (await request.json()) as Record<string, unknown>;
    expect(body.sessionName).toBe("session-123");
    expect(body.repoOwner).toBe("acme");
    expect(body.repoName).toBe("web-app");
    expect(body.repoId).toBe(42);
    expect(body.defaultBranch).toBe("main");
    expect(body.branch).toBe("feature-1");
    expect(body.title).toBe("Test session");
    expect(body.model).toBe("anthropic/claude-sonnet-4-6");
    expect(body.reasoningEffort).toBeNull();
    expect(body.userId).toBe("user-1");
    expect(body.canonicalUserId).toBe("platform-user-1");
    expect(body.scmLogin).toBe("acmedev");
    expect(body.scmName).toBe("Acme Dev");
    expect(body.scmEmail).toBe("dev@acme.test");
    expect(body.scmTokenEncrypted).toBe("enc-token");
    expect(body.scmRefreshTokenEncrypted).toBe("enc-refresh");
    expect(body.scmTokenExpiresAt).toBe(1700000000000);
    expect(body.scmUserId).toBe("scm-1");
    expect(body.codeServerEnabled).toBe(false);
    expect(body.vncEnabled).toBe(true);
    expect(body.sandboxSettings).toEqual({});
    expect(body.parentSessionId).toBeNull();
    expect(body.spawnSource).toBe("user");
    expect(body.spawnDepth).toBe(0);
  });

  it("sets correlation headers on the DO init request", async () => {
    await initializeSession(createEnv(), baseInput, ctx as never);

    const request = stubFetchMock.mock.calls[0][0] as Request;
    expect(request.headers.get("x-trace-id")).toBe("trace-abc");
    expect(request.headers.get("x-request-id")).toBe("req-xyz");
    expect(request.headers.get("Content-Type")).toBe("application/json");
  });

  it("returns sessionId and status on success", async () => {
    const result = await initializeSession(createEnv(), baseInput, ctx as never);
    expect(result).toEqual({ sessionId: "session-123", status: "created" });
  });

  it("falls back to defaultBranch when branch is not set", async () => {
    const input = { ...baseInput, branch: undefined, defaultBranch: "develop" };

    await initializeSession(createEnv(), input, ctx as never);

    const d1Entry = createMock.mock.calls[0][0];
    expect(d1Entry.baseBranch).toBe("develop");
  });

  it('falls back to "main" when neither branch nor defaultBranch is set', async () => {
    const input = { ...baseInput, branch: undefined, defaultBranch: undefined };

    await initializeSession(createEnv(), input, ctx as never);

    const d1Entry = createMock.mock.calls[0][0];
    expect(d1Entry.baseBranch).toBe("main");
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
