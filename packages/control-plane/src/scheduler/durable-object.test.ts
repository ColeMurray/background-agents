/**
 * Unit tests for SchedulerDO.
 *
 * Uses mocked D1 and SESSION namespace. For full integration tests
 * (with real D1 + workerd), see test/integration/scheduler.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../types";
import type { Logger } from "../logger";

// Mock cloudflare:workers before importing SchedulerDO (extends DurableObject)
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Must import AFTER vi.mock so the hoisted mock is in place
const { SchedulerDO } = await import("./durable-object");

// ─── Mock factories ──────────────────────────────────────────────────────────

/** Minimal AutomationStore mock returned by new AutomationStore(db). */
function createMockStore() {
  return {
    getOverdueAutomations: vi.fn().mockResolvedValue([]),
    getActiveRunForAutomation: vi.fn().mockResolvedValue(null),
    createRunAndAdvanceSchedule: vi.fn().mockResolvedValue(undefined),
    insertRun: vi.fn().mockResolvedValue(undefined),
    updateRun: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue(null),
    getRunById: vi.fn().mockResolvedValue(null),
    countOverdue: vi.fn().mockResolvedValue(0),
    getOrphanedStartingRuns: vi.fn().mockResolvedValue([]),
    getTimedOutRunningRuns: vi.fn().mockResolvedValue([]),
    incrementConsecutiveFailures: vi.fn().mockResolvedValue(1),
    resetConsecutiveFailures: vi.fn().mockResolvedValue(undefined),
    autoPause: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

let mockStore: ReturnType<typeof createMockStore>;

vi.mock("../db/automation-store", () => ({
  AutomationStore: vi.fn().mockImplementation(function () {
    return mockStore;
  }),
  toAutomationRun: vi.fn((row: unknown) => row),
}));

const mockSessionStoreCreate = vi.fn().mockResolvedValue(undefined);
const mockSessionStoreUpdateStatus = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/session-index", () => ({
  SessionIndexStore: vi.fn().mockImplementation(function () {
    return {
      create: mockSessionStoreCreate,
      updateStatus: mockSessionStoreUpdateStatus,
    };
  }),
}));

const mockUserStoreGetIdentity = vi.fn().mockResolvedValue(null);
vi.mock("../db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(function () {
    return {
      getIdentity: mockUserStoreGetIdentity,
    };
  }),
}));

vi.mock("../auth/crypto", () => ({
  generateId: vi.fn(() => `id-${Math.random().toString(36).slice(2, 8)}`),
}));

function createMockSessionStub(): DurableObjectStub {
  return {
    fetch: vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const path = new URL(url).pathname;
      if (path === "/internal/init") return Response.json({ status: "ok" });
      if (path === "/internal/prompt")
        return Response.json({ messageId: "msg-1", status: "queued" });
      return new Response("Not Found", { status: 404 });
    }),
  } as never;
}

function createEmptyDbMock(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => null),
      })),
    })),
  } as unknown as D1Database;
}

function createIntegrationSettingsDbMock(): D1Database {
  return {
    prepare: vi.fn((query: string) => ({
      bind: vi.fn((integrationId: string, repo?: string) => ({
        first: vi.fn(async () => {
          if (query.includes("integration_settings")) {
            if (integrationId === "code-server") {
              return {
                settings: JSON.stringify({ enabledRepos: null, defaults: { enabled: true } }),
              };
            }
            if (integrationId === "sandbox") {
              return {
                settings: JSON.stringify({
                  enabledRepos: null,
                  defaults: { tunnelPorts: [3000], terminalEnabled: true },
                }),
              };
            }
          }

          if (query.includes("integration_repo_settings") && repo === "acme/web-app") {
            if (integrationId === "sandbox") {
              return { settings: JSON.stringify({ tunnelPorts: [5173] }) };
            }
          }

          return null;
        }),
      })),
    })),
  } as unknown as D1Database;
}

async function getInitBody(fetchMock: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
  const initCall = fetchMock.mock.calls.find((call) => {
    const input = call[0];
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    return new URL(url).pathname === "/internal/init";
  });

  expect(initCall).toBeDefined();
  const [input, init] = initCall!;
  if (input instanceof Request) {
    return (await input.json()) as Record<string, unknown>;
  }
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function createEnv(overrides?: Partial<Env>): Env {
  const sessionStub = createMockSessionStub();
  return {
    DB: createEmptyDbMock(),
    SESSION: {
      idFromName: vi.fn().mockReturnValue("fake-do-id"),
      get: vi.fn().mockReturnValue(sessionStub),
    } as unknown as DurableObjectNamespace,
    DEPLOYMENT_NAME: "test",
    TOKEN_ENCRYPTION_KEY: "test-key",
    ...overrides,
  } as Env;
}

function createSchedulerDO(env?: Env): InstanceType<typeof SchedulerDO> {
  const ctx = { storage: {} } as unknown as DurableObjectState;
  return new SchedulerDO(ctx, env ?? createEnv());
}

// ─── Sample data ─────────────────────────────────────────────────────────────

const now = Date.now();

const sampleAutomation = {
  id: "auto-1",
  name: "Daily sync",
  repo_owner: "acme",
  repo_name: "web-app",
  base_branch: "main",
  repo_id: 12345,
  instructions: "Run tests",
  trigger_type: "schedule",
  schedule_cron: "0 9 * * *",
  schedule_tz: "UTC",
  model: "anthropic/claude-sonnet-4-6",
  reasoning_effort: null,
  enabled: 1,
  next_run_at: now - 60000,
  consecutive_failures: 0,
  created_by: "user-1",
  user_id: null as string | null,
  created_at: now - 86400000,
  updated_at: now - 86400000,
  deleted_at: null,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SchedulerDO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = createMockStore();
  });

  describe("/internal/health", () => {
    it("returns healthy status with overdue count", async () => {
      mockStore.countOverdue.mockResolvedValue(5);

      const scheduler = createSchedulerDO();
      const res = await scheduler.fetch(
        new Request("http://internal/internal/health", { method: "GET" })
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ status: string; overdueCount: number }>();
      expect(body.status).toBe("healthy");
      expect(body.overdueCount).toBe(5);
    });
  });

  describe("/internal/tick", () => {
    it("returns empty summary when no overdue automations", async () => {
      const scheduler = createSchedulerDO();
      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ processed: number; skipped: number; failed: number }>();
      expect(body.processed).toBe(0);
      expect(body.skipped).toBe(0);
      expect(body.failed).toBe(0);
    });

    it("processes overdue automation and creates run", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);

      const scheduler = createSchedulerDO();
      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ processed: number; skipped: number; failed: number }>();
      expect(body.processed).toBe(1);

      expect(mockStore.createRunAndAdvanceSchedule).toHaveBeenCalledTimes(1);
      expect(mockStore.updateRun).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "running" })
      );
    });

    it("passes automation reasoning effort into created sessions", async () => {
      const automation = { ...sampleAutomation, reasoning_effort: "high" };
      mockStore.getOverdueAutomations.mockResolvedValue([automation]);

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createSchedulerDO(env);
      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);
      const initBody = await getInitBody(fetchMock);
      expect(initBody.reasoningEffort).toBe("high");
    });

    it("passes resolved code-server and sandbox settings into automation sessions", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);

      const env = createEnv({ DB: createIntegrationSettingsDbMock() });
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createSchedulerDO(env);
      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);
      const initBody = await getInitBody(fetchMock);
      expect(initBody.codeServerEnabled).toBe(true);
      expect(initBody.sandboxSettings).toEqual({ tunnelPorts: [5173], terminalEnabled: true });
    });

    it("skips automation with active run (concurrency guard)", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      mockStore.getActiveRunForAutomation.mockResolvedValue({
        id: "existing-run",
        status: "running",
      });

      const scheduler = createSchedulerDO();
      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ processed: number; skipped: number; failed: number }>();
      expect(body.skipped).toBe(1);
      expect(body.processed).toBe(0);

      expect(mockStore.insertRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "skipped",
          skip_reason: "concurrent_run_active",
        })
      );

      // Verify next_run_at was advanced to prevent repeat skip inserts
      expect(mockStore.update).toHaveBeenCalledWith(
        sampleAutomation.id,
        expect.objectContaining({ next_run_at: expect.any(Number) })
      );
    });

    it("marks run as failed when session creation throws", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);

      const failingStub = {
        fetch: vi.fn().mockRejectedValue(new Error("Session init failed")),
      } as never;

      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createSchedulerDO(env);
      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ processed: number; skipped: number; failed: number }>();
      expect(body.failed).toBe(1);

      expect(mockStore.updateRun).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "failed" })
      );
      expect(mockStore.incrementConsecutiveFailures).toHaveBeenCalledWith("auto-1");
    });

    it("auto-pauses after 3 consecutive failures", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      mockStore.incrementConsecutiveFailures.mockResolvedValue(3);

      const failingStub = {
        fetch: vi.fn().mockRejectedValue(new Error("Session init failed")),
      } as never;

      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createSchedulerDO(env);
      await scheduler.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

      expect(mockStore.autoPause).toHaveBeenCalledWith("auto-1");
    });

    it("does not auto-pause at fewer than 3 failures", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      mockStore.incrementConsecutiveFailures.mockResolvedValue(2);

      const failingStub = {
        fetch: vi.fn().mockRejectedValue(new Error("fail")),
      } as never;

      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createSchedulerDO(env);
      await scheduler.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

      expect(mockStore.autoPause).not.toHaveBeenCalled();
    });

    it("recovers orphaned starting runs", async () => {
      const orphanedRun = {
        id: "orphan-1",
        automation_id: "auto-1",
        status: "starting",
        created_at: now - 10 * 60 * 1000,
      };
      mockStore.getOrphanedStartingRuns.mockResolvedValue([orphanedRun]);

      const scheduler = createSchedulerDO();
      await scheduler.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

      expect(mockStore.updateRun).toHaveBeenCalledWith("orphan-1", {
        status: "failed",
        failure_reason: "session_creation_timeout",
        completed_at: expect.any(Number),
      });
      expect(mockStore.incrementConsecutiveFailures).toHaveBeenCalledWith("auto-1");
    });

    it("passes automation user_id to session index", async () => {
      const automation = { ...sampleAutomation, user_id: "canonical-user-1" };
      mockStore.getOverdueAutomations.mockResolvedValue([automation]);

      const scheduler = createSchedulerDO();
      await scheduler.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

      expect(mockSessionStoreCreate).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "canonical-user-1" })
      );
    });

    it("falls back to identity lookup for legacy automations without user_id", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      mockUserStoreGetIdentity.mockResolvedValue({ userId: "looked-up-user" });

      const scheduler = createSchedulerDO();
      await scheduler.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

      expect(mockUserStoreGetIdentity).toHaveBeenCalledWith("github", "user-1");
      expect(mockSessionStoreCreate).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "looked-up-user" })
      );
    });

    it("creates session with null userId when identity lookup finds nothing", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      mockUserStoreGetIdentity.mockResolvedValue(null);

      const scheduler = createSchedulerDO();
      await scheduler.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

      expect(mockSessionStoreCreate).toHaveBeenCalledWith(
        expect.objectContaining({ userId: null })
      );
    });

    it("recovers timed-out running runs", async () => {
      const timedOutRun = {
        id: "timeout-1",
        automation_id: "auto-1",
        status: "running",
        started_at: now - 2 * 60 * 60 * 1000,
      };
      mockStore.getTimedOutRunningRuns.mockResolvedValue([timedOutRun]);

      const scheduler = createSchedulerDO();
      await scheduler.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

      expect(mockStore.updateRun).toHaveBeenCalledWith("timeout-1", {
        status: "failed",
        failure_reason: "execution_timeout",
        completed_at: expect.any(Number),
      });
    });

    it("swallows failRunAndTrack errors and logs scheduler.fail_track_error", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      mockStore.updateRun.mockRejectedValue(new Error("D1 timeout"));

      const failingStub = {
        fetch: vi.fn().mockRejectedValue(new Error("Session init failed")),
      } as never;

      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createSchedulerDO(env);
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ processed: number; skipped: number; failed: number }>();
      expect(body.failed).toBe(1);

      const failTrackCall = errorSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event === "scheduler.fail_track_error"
      );
      expect(failTrackCall).toBeDefined();
      expect(failTrackCall![1]).toMatchObject({
        event: "scheduler.fail_track_error",
        automation_id: "auto-1",
        run_id: expect.any(String),
        original_reason: "Session init failed",
        error: "D1 timeout",
      });

      const tickErrorCall = errorSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event === "scheduler.tick_error"
      );
      expect(tickErrorCall).toBeUndefined();

      expect(mockStore.incrementConsecutiveFailures).not.toHaveBeenCalled();
    });
  });

  describe("/internal/run-complete", () => {
    beforeEach(() => {
      // run-complete handler validates that the run exists and is active
      mockStore.getRunById.mockResolvedValue({
        id: "run-1",
        automation_id: "auto-1",
        status: "running",
        session_id: "sess-1",
        scheduled_at: now,
        started_at: now,
        completed_at: null,
        created_at: now,
        skip_reason: null,
        failure_reason: null,
      });
    });

    it("marks run as completed and resets failures on success", async () => {
      const scheduler = createSchedulerDO();
      const res = await scheduler.fetch(
        new Request("http://internal/internal/run-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            automationId: "auto-1",
            runId: "run-1",
            sessionId: "sess-1",
            success: true,
          }),
        })
      );

      expect(res.status).toBe(200);
      expect(mockStore.updateRun).toHaveBeenCalledWith("run-1", {
        status: "completed",
        completed_at: expect.any(Number),
      });
      expect(mockStore.resetConsecutiveFailures).toHaveBeenCalledWith("auto-1");
    });

    it("marks run as failed and increments failures on failure", async () => {
      const scheduler = createSchedulerDO();
      const res = await scheduler.fetch(
        new Request("http://internal/internal/run-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            automationId: "auto-1",
            runId: "run-1",
            sessionId: "sess-1",
            success: false,
            error: "Sandbox crashed",
          }),
        })
      );

      expect(res.status).toBe(200);
      expect(mockStore.updateRun).toHaveBeenCalledWith("run-1", {
        status: "failed",
        failure_reason: "Sandbox crashed",
        completed_at: expect.any(Number),
      });
      expect(mockStore.incrementConsecutiveFailures).toHaveBeenCalledWith("auto-1");
    });

    it("ignores callback for already-completed run", async () => {
      mockStore.getRunById.mockResolvedValue({
        id: "run-1",
        automation_id: "auto-1",
        status: "failed",
        session_id: "sess-1",
        scheduled_at: now,
        started_at: now,
        completed_at: now,
        created_at: now,
        skip_reason: null,
        failure_reason: "execution_timeout",
      });

      const scheduler = createSchedulerDO();
      const res = await scheduler.fetch(
        new Request("http://internal/internal/run-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            automationId: "auto-1",
            runId: "run-1",
            sessionId: "sess-1",
            success: true,
          }),
        })
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ ok: boolean; ignored: boolean }>();
      expect(body.ignored).toBe(true);
      expect(mockStore.updateRun).not.toHaveBeenCalled();
      expect(mockStore.resetConsecutiveFailures).not.toHaveBeenCalled();
    });

    it("auto-pauses after run-complete pushes failures to 3", async () => {
      mockStore.incrementConsecutiveFailures.mockResolvedValue(3);

      const scheduler = createSchedulerDO();
      await scheduler.fetch(
        new Request("http://internal/internal/run-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            automationId: "auto-1",
            runId: "run-1",
            sessionId: "sess-1",
            success: false,
            error: "Third failure",
          }),
        })
      );

      expect(mockStore.autoPause).toHaveBeenCalledWith("auto-1");
    });
  });

  describe("/internal/trigger", () => {
    it("returns 400 when automationId is missing", async () => {
      const scheduler = createSchedulerDO();
      const res = await scheduler.fetch(
        new Request("http://internal/internal/trigger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const scheduler = createSchedulerDO();
      const res = await scheduler.fetch(
        new Request("http://internal/internal/trigger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ automationId: "nonexistent" }),
        })
      );
      expect(res.status).toBe(404);
    });

    it("returns 409 when active run exists", async () => {
      mockStore.getById.mockResolvedValue(sampleAutomation);
      mockStore.getActiveRunForAutomation.mockResolvedValue({ id: "run-active" });

      const scheduler = createSchedulerDO();
      const res = await scheduler.fetch(
        new Request("http://internal/internal/trigger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ automationId: "auto-1" }),
        })
      );
      expect(res.status).toBe(409);
    });

    it("creates run and session on successful trigger", async () => {
      mockStore.getById.mockResolvedValue(sampleAutomation);
      mockStore.getActiveRunForAutomation.mockResolvedValue(null);

      const scheduler = createSchedulerDO();
      const res = await scheduler.fetch(
        new Request("http://internal/internal/trigger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ automationId: "auto-1" }),
        })
      );

      expect(res.status).toBe(201);
      expect(mockStore.insertRun).toHaveBeenCalledWith(
        expect.objectContaining({ automation_id: "auto-1", status: "starting" })
      );
      expect(mockStore.updateRun).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "running" })
      );
    });

    it("returns the normal 500 response when failRunAndTrack itself throws", async () => {
      mockStore.getById.mockResolvedValue(sampleAutomation);
      mockStore.getActiveRunForAutomation.mockResolvedValue(null);
      mockStore.updateRun.mockRejectedValue(new Error("D1 timeout"));

      const failingStub = {
        fetch: vi.fn().mockRejectedValue(new Error("Session init failed")),
      } as never;

      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createSchedulerDO(env);
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      const res = await scheduler.fetch(
        new Request("http://internal/internal/trigger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ automationId: "auto-1" }),
        })
      );

      expect(res.status).toBe(500);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe("Failed to trigger automation");

      const failTrackCall = errorSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event === "scheduler.fail_track_error"
      );
      expect(failTrackCall).toBeDefined();
    });
  });

  it("returns 404 for unknown routes", async () => {
    const scheduler = createSchedulerDO();
    const res = await scheduler.fetch(new Request("http://internal/unknown", { method: "GET" }));
    expect(res.status).toBe(404);
  });
});
