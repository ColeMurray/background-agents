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
    getActiveRunForKey: vi.fn().mockResolvedValue(null),
    getLatestSteerableRunForThread: vi.fn().mockResolvedValue(null),
    recordSkippedRun: vi.fn().mockResolvedValue(undefined),
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
    bulkFailRuns: vi.fn().mockResolvedValue(undefined),
    bulkIncrementFailures: vi.fn().mockResolvedValue(new Map()),
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

const mockGetSlackAutomationsForChannel = vi.fn().mockResolvedValue([]);
vi.mock("../db/slack-channel-store", () => ({
  SlackChannelStore: vi.fn().mockImplementation(function () {
    return {
      getSlackAutomationsForChannel: mockGetSlackAutomationsForChannel,
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

async function getPromptBody(
  fetchMock: ReturnType<typeof vi.fn>
): Promise<Record<string, unknown>> {
  const promptCall = fetchMock.mock.calls.find((call) => {
    const input = call[0];
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    return new URL(url).pathname === "/internal/prompt";
  });

  expect(promptCall).toBeDefined();
  const [input, init] = promptCall!;
  if (input instanceof Request) {
    return (await input.json()) as Record<string, unknown>;
  }
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function promptCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => {
    const input = call[0];
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    return new URL(url).pathname === "/internal/prompt";
  }).length;
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

const sampleSlackAutomation = {
  ...sampleAutomation,
  id: "auto-slack",
  name: "Slack triage",
  trigger_type: "slack_event",
  schedule_cron: null,
  next_run_at: null,
  event_type: "message.posted",
  trigger_config: JSON.stringify({
    conditions: [
      { type: "slack_channel", operator: "any_of", value: ["C1"] },
      { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
    ],
  }),
};

function makeSlackEvent(overrides?: Record<string, unknown>) {
  const ts = "1700000000.000200";
  return {
    source: "slack",
    eventType: "message.posted",
    triggerKey: `slack:msg:C1:${ts}`,
    concurrencyKey: "slack:C1:thread-root",
    contextBlock: "A message was posted in #ops.",
    meta: {},
    channelId: "C1",
    threadTs: "1700000000.000100",
    ts,
    actorUserId: "U1",
    text: "please deploy the api",
    ...overrides,
  };
}

function slackEventRequest(overrides?: Record<string, unknown>): Request {
  return new Request("http://internal/internal/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeSlackEvent(overrides)),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SchedulerDO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = createMockStore();
    mockGetSlackAutomationsForChannel.mockResolvedValue([]);
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
      mockStore.bulkIncrementFailures.mockResolvedValue(new Map([["auto-1", 1]]));

      const scheduler = createSchedulerDO();
      await scheduler.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

      expect(mockStore.bulkFailRuns).toHaveBeenCalledWith(
        ["orphan-1"],
        "session_creation_timeout",
        expect.any(Number)
      );
      expect(mockStore.bulkIncrementFailures).toHaveBeenCalledWith(new Map([["auto-1", 1]]));
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
      mockStore.bulkIncrementFailures.mockResolvedValue(new Map([["auto-1", 1]]));

      const scheduler = createSchedulerDO();
      await scheduler.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

      expect(mockStore.bulkFailRuns).toHaveBeenCalledWith(
        ["timeout-1"],
        "execution_timeout",
        expect.any(Number)
      );
    });

    it("recovers one category when the other recovery query fails", async () => {
      const timedOutRun = {
        id: "timeout-1",
        automation_id: "auto-1",
        status: "running",
        started_at: now - 2 * 60 * 60 * 1000,
      };
      mockStore.getOrphanedStartingRuns.mockRejectedValue(new Error("D1 orphan query timeout"));
      mockStore.getTimedOutRunningRuns.mockResolvedValue([timedOutRun]);
      mockStore.bulkIncrementFailures.mockResolvedValue(new Map([["auto-1", 1]]));

      const scheduler = createSchedulerDO();
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);
      expect(mockStore.bulkFailRuns).toHaveBeenCalledWith(
        ["timeout-1"],
        "execution_timeout",
        expect.any(Number)
      );
      expect(mockStore.bulkIncrementFailures).toHaveBeenCalledWith(new Map([["auto-1", 1]]));

      const queryErrorCall = errorSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event === "scheduler.recovery.query_error"
      );
      expect(queryErrorCall).toBeDefined();
      expect(queryErrorCall![1]).toMatchObject({
        event: "scheduler.recovery.query_error",
        category: "orphaned",
        error: "D1 orphan query timeout",
      });
    });

    it("batches multiple orphaned runs into a single bulkFailRuns call", async () => {
      const orphanedRuns = [
        { id: "orphan-a", automation_id: "auto-1", status: "starting", created_at: now - 1 },
        { id: "orphan-b", automation_id: "auto-1", status: "starting", created_at: now - 2 },
        { id: "orphan-c", automation_id: "auto-1", status: "starting", created_at: now - 3 },
      ];
      mockStore.getOrphanedStartingRuns.mockResolvedValue(orphanedRuns);
      mockStore.bulkIncrementFailures.mockResolvedValue(new Map([["auto-1", 3]]));

      const scheduler = createSchedulerDO();
      await scheduler.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

      expect(mockStore.bulkFailRuns).toHaveBeenCalledTimes(1);
      expect(mockStore.bulkFailRuns).toHaveBeenCalledWith(
        ["orphan-a", "orphan-b", "orphan-c"],
        "session_creation_timeout",
        expect.any(Number)
      );
      expect(mockStore.bulkIncrementFailures).toHaveBeenCalledWith(new Map([["auto-1", 3]]));
    });

    it("auto-pauses automation when bulk increment reaches threshold", async () => {
      const orphanedRun = {
        id: "orphan-1",
        automation_id: "auto-1",
        status: "starting",
        created_at: now - 10 * 60 * 1000,
      };
      mockStore.getOrphanedStartingRuns.mockResolvedValue([orphanedRun]);
      mockStore.bulkIncrementFailures.mockResolvedValue(new Map([["auto-1", 3]]));

      const scheduler = createSchedulerDO();
      const warnSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "warn")
        .mockImplementation(() => {});

      await scheduler.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

      expect(mockStore.autoPause).toHaveBeenCalledWith("auto-1");
      const autoPauseCall = warnSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event === "scheduler.auto_pause"
      );
      expect(autoPauseCall).toBeDefined();
      expect(autoPauseCall![1]).toMatchObject({
        event: "scheduler.auto_pause",
        automation_id: "auto-1",
        consecutive_failures: 3,
      });
    });

    it("continues auto-pausing later automations when one auto-pause fails", async () => {
      const orphanedRuns = [
        {
          id: "orphan-1",
          automation_id: "auto-1",
          status: "starting",
          created_at: now - 10 * 60 * 1000,
        },
        {
          id: "orphan-2",
          automation_id: "auto-2",
          status: "starting",
          created_at: now - 10 * 60 * 1000,
        },
      ];
      mockStore.getOrphanedStartingRuns.mockResolvedValue(orphanedRuns);
      mockStore.bulkIncrementFailures.mockResolvedValue(
        new Map([
          ["auto-1", 3],
          ["auto-2", 3],
        ])
      );
      mockStore.autoPause.mockImplementation(async (automationId: string) => {
        if (automationId === "auto-1") {
          throw new Error("D1 auto-pause timeout");
        }
      });

      const scheduler = createSchedulerDO();
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});
      const warnSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "warn")
        .mockImplementation(() => {});

      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);
      expect(mockStore.autoPause).toHaveBeenCalledWith("auto-1");
      expect(mockStore.autoPause).toHaveBeenCalledWith("auto-2");

      const autoPauseErrorCall = errorSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event ===
          "scheduler.recovery.auto_pause_error"
      );
      expect(autoPauseErrorCall).toBeDefined();
      expect(autoPauseErrorCall![1]).toMatchObject({
        event: "scheduler.recovery.auto_pause_error",
        automation_id: "auto-1",
        consecutive_failures: 3,
        error: "D1 auto-pause timeout",
      });

      const autoPauseSuccessCall = warnSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event === "scheduler.auto_pause" &&
          (data as Record<string, unknown> | undefined)?.automation_id === "auto-2"
      );
      expect(autoPauseSuccessCall).toBeDefined();
    });

    it("swallows bulkFailRuns errors and logs scheduler.recovery.bulk_fail_error", async () => {
      const orphanedRun = {
        id: "orphan-1",
        automation_id: "auto-1",
        status: "starting",
        created_at: now - 10 * 60 * 1000,
      };
      mockStore.getOrphanedStartingRuns.mockResolvedValue([orphanedRun]);
      mockStore.bulkFailRuns.mockRejectedValue(new Error("D1 timeout"));

      const scheduler = createSchedulerDO();
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);
      const bulkFailErrorCall = errorSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event ===
          "scheduler.recovery.bulk_fail_error"
      );
      expect(bulkFailErrorCall).toBeDefined();
      expect(bulkFailErrorCall![1]).toMatchObject({
        event: "scheduler.recovery.bulk_fail_error",
        category: "orphaned",
        count: 1,
        error: "D1 timeout",
      });
      expect(mockStore.bulkIncrementFailures).not.toHaveBeenCalled();
    });

    it("increments failures for runs marked failed when the other category throws", async () => {
      const orphanedRun = {
        id: "orphan-1",
        automation_id: "auto-1",
        status: "starting",
        created_at: now - 10 * 60 * 1000,
      };
      const timedOutRun = {
        id: "timeout-1",
        automation_id: "auto-2",
        status: "running",
        started_at: now - 2 * 60 * 60 * 1000,
      };
      mockStore.getOrphanedStartingRuns.mockResolvedValue([orphanedRun]);
      mockStore.getTimedOutRunningRuns.mockResolvedValue([timedOutRun]);
      mockStore.bulkFailRuns.mockImplementation(async (runIds: string[]) => {
        if (runIds.includes("timeout-1")) {
          throw new Error("D1 timeout");
        }
      });
      mockStore.bulkIncrementFailures.mockResolvedValue(new Map([["auto-1", 1]]));

      const scheduler = createSchedulerDO();
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);

      expect(mockStore.bulkFailRuns).toHaveBeenCalledWith(
        ["orphan-1"],
        "session_creation_timeout",
        expect.any(Number)
      );
      expect(mockStore.bulkFailRuns).toHaveBeenCalledWith(
        ["timeout-1"],
        "execution_timeout",
        expect.any(Number)
      );

      expect(mockStore.bulkIncrementFailures).toHaveBeenCalledWith(new Map([["auto-1", 1]]));

      const bulkFailErrorCall = errorSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event ===
          "scheduler.recovery.bulk_fail_error"
      );
      expect(bulkFailErrorCall).toBeDefined();
      expect(bulkFailErrorCall![1]).toMatchObject({
        event: "scheduler.recovery.bulk_fail_error",
        category: "timed_out",
        count: 1,
        error: "D1 timeout",
      });
    });

    it("swallows bulkIncrementFailures errors and logs scheduler.recovery.bulk_track_error", async () => {
      const orphanedRun = {
        id: "orphan-1",
        automation_id: "auto-1",
        status: "starting",
        created_at: now - 10 * 60 * 1000,
      };
      mockStore.getOrphanedStartingRuns.mockResolvedValue([orphanedRun]);
      mockStore.bulkIncrementFailures.mockRejectedValue(new Error("D1 timeout"));

      const scheduler = createSchedulerDO();
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      const res = await scheduler.fetch(
        new Request("http://internal/internal/tick", { method: "POST" })
      );

      expect(res.status).toBe(200);
      expect(mockStore.bulkFailRuns).toHaveBeenCalledWith(
        ["orphan-1"],
        "session_creation_timeout",
        expect.any(Number)
      );
      const bulkTrackErrorCall = errorSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event ===
          "scheduler.recovery.bulk_track_error"
      );
      expect(bulkTrackErrorCall).toBeDefined();
      expect(bulkTrackErrorCall![1]).toMatchObject({
        event: "scheduler.recovery.bulk_track_error",
        error: "D1 timeout",
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

    it("propagates failure-tracking errors so the callback caller retries", async () => {
      mockStore.updateRun.mockRejectedValue(new Error("D1 timeout"));

      const scheduler = createSchedulerDO();
      await expect(
        scheduler.fetch(
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
        )
      ).rejects.toThrow("D1 timeout");
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

  describe("/internal/event — slack thread continuity", () => {
    it("steers the thread session even when the follow-up fails trigger conditions", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      mockStore.getLatestSteerableRunForThread.mockResolvedValue({
        id: "active-run",
        status: "running",
        session_id: "sess-running",
      });

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createSchedulerDO(env);
      // A natural follow-up reply won't repeat the "deploy" trigger keyword, yet
      // it must still steer the thread's session — conditions gate new runs only.
      const res = await scheduler.fetch(
        slackEventRequest({ text: "thanks — also update the changelog" })
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ triggered: number; skipped: number; steered: number }>();
      expect(body).toEqual({ triggered: 0, skipped: 0, steered: 1 });

      // The continuity lookup is scoped to the thread's concurrency key and a time
      // window measured from now (24h back).
      expect(mockStore.getLatestSteerableRunForThread).toHaveBeenCalledWith(
        "auto-slack",
        "slack:C1:thread-root",
        expect.any(Number)
      );

      // The follow-up was enqueued onto the existing session as a slack-sourced
      // turn, so its reply posts back in-thread via /callbacks/complete.
      const promptBody = await getPromptBody(fetchMock);
      expect(promptBody.source).toBe("slack");
      expect(promptBody.content).toBe("thanks — also update the changelog");
      expect(promptBody.authorId).toBe("slack:U1");
      expect(promptBody.callbackContext).toMatchObject({
        source: "slack",
        channel: "C1",
        threadTs: "1700000000.000100",
        reactionMessageTs: "1700000000.000200",
        repoFullName: "acme/web-app",
      });

      // A steer is not a new trigger and not a skip.
      expect(mockStore.insertRun).not.toHaveBeenCalled();
      expect(mockStore.recordSkippedRun).not.toHaveBeenCalled();
    });

    it("continues the same session on a reply after the run has completed", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      // The thread's run finished, but its session is still steerable within the
      // window — like replying after an @mention turn ends.
      mockStore.getLatestSteerableRunForThread.mockResolvedValue({
        id: "done-run",
        status: "completed",
        session_id: "sess-done",
      });

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createSchedulerDO(env);
      const res = await scheduler.fetch(
        slackEventRequest({ text: "actually, can you also bump the version?" })
      );

      const body = await res.json<{ triggered: number; skipped: number; steered: number }>();
      expect(body).toEqual({ triggered: 0, skipped: 0, steered: 1 });

      const promptBody = await getPromptBody(fetchMock);
      expect(promptBody.source).toBe("slack");
      expect(promptBody.content).toBe("actually, can you also bump the version?");
      // Routed to the completed run's session — no new run, and the concurrency
      // guard is never consulted (the steer short-circuits the loop).
      expect(mockStore.insertRun).not.toHaveBeenCalled();
      expect(mockStore.getActiveRunForKey).not.toHaveBeenCalled();
    });

    it("anchors the thread to the message ts for a top-level (non-reply) follow-up", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      mockStore.getLatestSteerableRunForThread.mockResolvedValue({
        id: "active-run",
        status: "running",
        session_id: "sess-running",
      });

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createSchedulerDO(env);
      // No threadTs → the follow-up should anchor to its own ts.
      await scheduler.fetch(slackEventRequest({ threadTs: undefined }));

      const promptBody = await getPromptBody(fetchMock);
      expect(promptBody.callbackContext).toMatchObject({
        threadTs: "1700000000.000200",
        reactionMessageTs: "1700000000.000200",
      });
    });

    it("starts a fresh run when no steerable session exists (outside the window)", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      // Outside the continuity window → no steerable run, and no active run.
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
      mockStore.getActiveRunForKey.mockResolvedValue(null);

      const scheduler = createSchedulerDO();
      // Matching text so the trigger conditions pass.
      const res = await scheduler.fetch(slackEventRequest());

      const body = await res.json<{ triggered: number; skipped: number; steered: number }>();
      expect(body).toEqual({ triggered: 1, skipped: 0, steered: 0 });
      expect(mockStore.insertRun).toHaveBeenCalledWith(
        expect.objectContaining({ automation_id: "auto-slack", status: "starting" })
      );
    });

    it("posts the already-active notice for a reply racing the initial trigger (no session yet)", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      // Run is still starting → not yet steerable, but it blocks a second run.
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
      mockStore.getActiveRunForKey.mockResolvedValue({
        id: "starting-run",
        status: "starting",
        session_id: null,
      });

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createSchedulerDO(env);
      const res = await scheduler.fetch(slackEventRequest());

      const body = await res.json<{ triggered: number; skipped: number; steered: number }>();
      expect(body).toEqual({ triggered: 0, skipped: 1, steered: 0 });
      expect(mockStore.recordSkippedRun).toHaveBeenCalled();
      // No prompt reached any session.
      expect(promptCallCount(fetchMock)).toBe(0);
    });

    it("falls through to a new trigger when steering the session fails", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      // A completed run is steerable, but the enqueue will fail; with the run no
      // longer active, the reply is re-evaluated as a new trigger (it matches),
      // mirroring the @mention path's stale-session → new-session recovery.
      mockStore.getLatestSteerableRunForThread.mockResolvedValue({
        id: "done-run",
        status: "completed",
        session_id: "sess-done",
      });
      mockStore.getActiveRunForKey.mockResolvedValue(null);

      // Session DO rejects every fetch → steerSession fails AND the fresh run's
      // session init fails, so the run is created then marked failed.
      const failingStub = {
        fetch: vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
      } as never;
      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createSchedulerDO(env);
      const res = await scheduler.fetch(slackEventRequest());

      const body = await res.json<{ triggered: number; skipped: number; steered: number }>();
      // Steer failed → fell through → matched conditions → fresh run created
      // (insertRun) but its session init failed, so triggered stays 0.
      expect(body).toEqual({ triggered: 0, skipped: 0, steered: 0 });
      expect(mockStore.insertRun).toHaveBeenCalledWith(
        expect.objectContaining({ automation_id: "auto-slack", status: "starting" })
      );
      // Not treated as a concurrency skip.
      expect(mockStore.recordSkippedRun).not.toHaveBeenCalled();
    });
  });

  it("returns 404 for unknown routes", async () => {
    const scheduler = createSchedulerDO();
    const res = await scheduler.fetch(new Request("http://internal/unknown", { method: "GET" }));
    expect(res.status).toBe(404);
  });
});
