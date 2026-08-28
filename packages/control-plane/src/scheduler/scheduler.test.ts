/**
 * Unit tests for Scheduler.
 *
 * Uses mocked D1 and SESSION namespace. For full integration tests
 * (with real D1 + workerd), see test/integration/scheduler.test.ts and
 * test/integration/automation-invocations.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { InvocationRunAggregate } from "../db/automation-store";
import type { SlackAutomationEvent } from "@open-inspect/shared/triggers";

const mockCheckRepositoryAccess = vi.hoisted(() => vi.fn());
const mockResolveSessionProviderAuth = vi.hoisted(() =>
  vi.fn().mockResolvedValue([
    { provider: "openai", authMode: "api_key", selectionSource: "unattended_policy" },
    { provider: "xai", authMode: "api_key", selectionSource: "unattended_policy" },
  ])
);

vi.mock("../source-control", () => ({
  createSourceControlProviderFromEnv: vi.fn(() => ({
    checkRepositoryAccess: mockCheckRepositoryAccess,
  })),
}));

vi.mock("../session/provider-account-resolution", () => ({
  resolveSessionProviderAuth: mockResolveSessionProviderAuth,
}));

vi.mock("../session/skill-resolution", () => ({
  resolveManagedSkills: vi.fn(async () => ({
    selection: { mode: "all" },
    resolverVersion: 1,
    manifestSha256: "0".repeat(64),
    resolvedAt: 1,
    skills: [],
  })),
}));

const { Scheduler } = await import("./scheduler");

// ─── Mock factories ──────────────────────────────────────────────────────────

function aggregate(overrides?: Partial<InvocationRunAggregate>): InvocationRunAggregate {
  return {
    total: 1,
    active: 1,
    failed: 0,
    completed: 0,
    skipped: 0,
    lastCompletedAt: null,
    ...overrides,
  };
}

/**
 * insertInvocationGuarded params snapshotted at call time — the launch loop
 * mutates its local child objects afterwards, so assertions about the
 * inserted state must read these clones, not mock.calls.
 */
let capturedInvocationParams: Array<{ children: Array<Record<string, unknown>> }> = [];

/** Minimal AutomationStore mock returned by new AutomationStore(db). */
function createMockStore() {
  return {
    getOverdueAutomations: vi.fn().mockResolvedValue([]),
    getActiveRunForAutomation: vi.fn().mockResolvedValue(null),
    getActiveRunForKey: vi.fn().mockResolvedValue(null),
    getLatestSteerableRunForThread: vi.fn().mockResolvedValue(null),
    getRepositoriesForAutomation: vi.fn().mockResolvedValue([]),
    getRepositoriesForAutomationIds: vi.fn().mockResolvedValue(new Map()),
    getEnvironmentsForAutomation: vi.fn().mockResolvedValue([]),
    getEnvironmentsForAutomationIds: vi.fn().mockResolvedValue(new Map()),
    insertInvocationGuarded: vi.fn().mockImplementation(async (params: unknown) => {
      capturedInvocationParams.push(
        structuredClone(params) as { children: Array<Record<string, unknown>> }
      );
      return { inserted: true };
    }),
    insertSkippedInvocation: vi.fn().mockResolvedValue({ inserted: true }),
    getInvocationById: vi.fn().mockResolvedValue(null),
    getInvocationRunAggregate: vi.fn().mockResolvedValue(aggregate()),
    tryMarkInvocationFailureCounted: vi.fn().mockResolvedValue(true),
    getUncountedFailedInvocations: vi.fn().mockResolvedValue([]),
    getStaleFailureResetCandidates: vi.fn().mockResolvedValue([]),
    updateRun: vi.fn().mockResolvedValue(true),
    claimRunSession: vi.fn().mockResolvedValue(true),
    getById: vi.fn().mockResolvedValue(null),
    getRunById: vi.fn().mockResolvedValue(null),
    countOverdue: vi.fn().mockResolvedValue(0),
    getOrphanedStartingRuns: vi.fn().mockResolvedValue([]),
    getTimedOutRunningRuns: vi.fn().mockResolvedValue([]),
    incrementConsecutiveFailures: vi.fn().mockResolvedValue(1),
    resetConsecutiveFailures: vi.fn().mockResolvedValue(undefined),
    autoPause: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    advanceNextRunAt: vi.fn().mockResolvedValue(true),
    bulkFailStartingRuns: vi.fn().mockResolvedValue(undefined),
    bulkFailRunningRuns: vi.fn().mockResolvedValue(undefined),
  };
}

let mockStore: ReturnType<typeof createMockStore>;

vi.mock("../db/automation-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationStore: vi.fn().mockImplementation(function () {
      return mockStore;
    }),
    toAutomationRun: vi.fn((row: unknown) => row),
  };
});

const mockProviderAuthList = vi.fn().mockResolvedValue([]);
vi.mock("../db/automation-model-provider-auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationModelProviderAuthStore: vi.fn().mockImplementation(function () {
      return { list: mockProviderAuthList };
    }),
  };
});

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

vi.mock("../db/provider-account-defaults", () => ({
  ProviderDefaultStore: vi.fn().mockImplementation(function () {
    return { get: vi.fn().mockResolvedValue(null) };
  }),
}));

vi.mock("../db/model-provider-accounts", () => ({
  ModelProviderAccountStore: vi.fn().mockImplementation(function () {
    return { getById: vi.fn().mockResolvedValue(null) };
  }),
}));

const mockEnvironmentGetById = vi.fn().mockResolvedValue(null);
const mockEnvironmentRepositories = vi.fn().mockResolvedValue([]);
vi.mock("../db/environments", () => ({
  EnvironmentStore: vi.fn().mockImplementation(function () {
    return {
      getById: mockEnvironmentGetById,
      getRepositoriesForEnvironment: mockEnvironmentRepositories,
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

function createIntegrationSettingsDbMock(
  slackSessionInstructions?: string,
  throwOnSlackSettings = false
): D1Database {
  return {
    prepare: vi.fn((query: string) => ({
      bind: vi.fn((integrationId: string, repo?: string) => ({
        first: vi.fn(async () => {
          if (query.includes("integration_settings")) {
            if (integrationId === "slack" && throwOnSlackSettings) {
              throw new Error("settings unavailable");
            }
            if (integrationId === "code-server") {
              return {
                settings: JSON.stringify({ enabledRepos: null, defaults: { enabled: true } }),
              };
            }
            if (integrationId === "vnc") {
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
            if (integrationId === "slack" && slackSessionInstructions) {
              return {
                settings: JSON.stringify({
                  defaults: { sessionInstructions: slackSessionInstructions },
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

function createScheduler(env = createEnv()): InstanceType<typeof Scheduler> {
  return new Scheduler(env.DB, env, createTestBackgroundTasks());
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

function repositoryRow(automationId: string, overrides?: Record<string, unknown>) {
  return {
    automation_id: automationId,
    repo_owner: "acme",
    repo_name: "web-app",
    repo_id: 12345,
    base_branch: "release",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** Point the tick's batched repository fetch at a selection for one automation. */
function selectRepositories(automationId: string, rows: unknown[]) {
  mockStore.getRepositoriesForAutomationIds.mockResolvedValue(new Map([[automationId, rows]]));
  mockStore.getRepositoriesForAutomation.mockResolvedValue(rows);
}

/** Point the tick's batched environment fetch at a selection for one automation. */
function selectEnvironments(automationId: string, environmentIds: string[]) {
  const rows = environmentIds.map((environmentId) => ({
    automation_id: automationId,
    environment_id: environmentId,
    created_at: now,
    updated_at: now,
  }));
  mockStore.getEnvironmentsForAutomationIds.mockResolvedValue(new Map([[automationId, rows]]));
  mockStore.getEnvironmentsForAutomation.mockResolvedValue(rows);
}

function sampleRunRow(overrides?: Record<string, unknown>) {
  return {
    id: "run-1",
    automation_id: "auto-1",
    invocation_id: "inv-1",
    status: "running",
    session_id: "sess-1",
    scheduled_at: now,
    started_at: now,
    completed_at: null,
    created_at: now,
    skip_reason: null,
    failure_reason: null,
    trigger_key: null,
    concurrency_key: null,
    repo_owner: "acme",
    repo_name: "web-app",
    repo_id: 12345,
    base_branch: "main",
    ...overrides,
  };
}

function runCompletion(overrides?: Record<string, unknown>) {
  return {
    automationId: "auto-1",
    runId: "run-1",
    sessionId: "sess-1",
    messageId: "msg-1",
    success: true,
    ...overrides,
  };
}

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

const sampleSlackPermalink = "https://example.slack.com/archives/C1/p1700000000000200";
const sampleSlackContextBlock = `A message was posted in #ops.\nPermalink: ${sampleSlackPermalink}`;

function makeSlackEvent(overrides?: Partial<SlackAutomationEvent>): SlackAutomationEvent {
  const ts = "1700000000.000200";
  return {
    source: "slack",
    eventType: "message.posted",
    triggerKey: `slack:msg:C1:${ts}`,
    concurrencyKey: "slack:C1:thread-root",
    contextBlock: sampleSlackContextBlock,
    meta: {},
    channelId: "C1",
    permalink: sampleSlackPermalink,
    threadTs: "1700000000.000100",
    ts,
    actorUserId: "U1",
    text: "please deploy the api",
    ...overrides,
  };
}

/** All children handed to the last insertInvocationGuarded call, as inserted. */
function lastInsertedChildren(): Array<Record<string, unknown>> {
  const params = capturedInvocationParams.at(-1);
  expect(params).toBeDefined();
  return params!.children;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSessionProviderAuth.mockResolvedValue([
      { provider: "openai", authMode: "api_key", selectionSource: "unattended_policy" },
      { provider: "xai", authMode: "api_key", selectionSource: "unattended_policy" },
    ]);
    mockProviderAuthList.mockResolvedValue([]);
    capturedInvocationParams = [];
    mockStore = createMockStore();
    mockGetSlackAutomationsForChannel.mockResolvedValue([]);
    mockCheckRepositoryAccess.mockResolvedValue({
      repoId: 12345,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "main",
    });
  });

  describe("tick", () => {
    it("returns empty summary when no overdue automations", async () => {
      const scheduler = createScheduler();
      const result = await scheduler.tick();

      expect(result).toEqual({ processed: 0, skipped: 0, failed: 0 });
    });

    it("starts an invocation for an overdue automation and launches its run", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);

      const scheduler = createScheduler();
      const result = await scheduler.tick();

      expect(result).toMatchObject({ processed: 1 });

      expect(mockStore.insertInvocationGuarded).toHaveBeenCalledTimes(1);
      const params = mockStore.insertInvocationGuarded.mock.calls[0][0];
      expect(params.invocation).toMatchObject({
        automation_id: "auto-1",
        source: "schedule",
        scheduled_at: sampleAutomation.next_run_at,
      });
      expect(params.overlapScope).toEqual({ kind: "automation" });
      expect(params.advanceSchedule).toEqual({
        fromSlot: sampleAutomation.next_run_at,
        nextRunAt: expect.any(Number),
      });
      expect(params.children).toHaveLength(1);

      expect(mockStore.claimRunSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number)
      );
    });

    it("does not enqueue a prompt when recovery wins the launch transition", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      mockStore.claimRunSession.mockResolvedValue(false);

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      const result = await scheduler.tick();

      expect(result).toMatchObject({ processed: 0, failed: 1 });
      expect(promptCallCount(fetchMock)).toBe(0);
      expect(mockStore.claimRunSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number)
      );
      expect(mockStore.updateRun).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "failed" })
      );
    });

    it("fans out one child per selected repository", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [
        repositoryRow("auto-1", { repo_name: "web-app" }),
        repositoryRow("auto-1", { repo_name: "api", base_branch: null }),
      ]);
      mockCheckRepositoryAccess.mockImplementation(
        async ({ name }: { owner: string; name: string }) => ({
          repoId: name === "api" ? 222 : 111,
          repoOwner: "acme",
          repoName: name,
          defaultBranch: "main",
        })
      );

      const scheduler = createScheduler();
      await scheduler.tick();
      const children = lastInsertedChildren();
      expect(children).toHaveLength(2);
      expect(children[0]).toMatchObject({
        repo_owner: "acme",
        repo_name: "web-app",
        repo_id: 111,
        base_branch: "release",
        status: "starting",
      });
      expect(children[1]).toMatchObject({
        repo_owner: "acme",
        repo_name: "api",
        repo_id: 222,
        base_branch: "main",
        status: "starting",
      });
      // Both children share the invocation id.
      expect(children[0].invocation_id).toBe(children[1].invocation_id);
      // Both launched.
      expect(mockStore.claimRunSession).toHaveBeenCalledTimes(2);
    });

    it("resolves one provider auth snapshot for every child in a fan-out invocation", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [
        repositoryRow("auto-1", { repo_name: "web-app" }),
        repositoryRow("auto-1", { repo_name: "api", base_branch: null }),
      ]);
      const invocationProviderAuth = [
        {
          provider: "openai" as const,
          authMode: "provider_account" as const,
          providerAccountId: "a".repeat(32),
          selectionSource: "provider_default",
        },
        {
          provider: "xai" as const,
          authMode: "api_key" as const,
          selectionSource: "unattended_policy",
        },
      ];
      mockResolveSessionProviderAuth
        .mockResolvedValueOnce(invocationProviderAuth)
        .mockResolvedValueOnce([
          {
            provider: "openai",
            authMode: "provider_account",
            providerAccountId: "b".repeat(32),
            selectionSource: "provider_default",
          },
          { provider: "xai", authMode: "api_key", selectionSource: "unattended_policy" },
        ]);

      const scheduler = createScheduler();
      await scheduler.tick();
      expect(mockResolveSessionProviderAuth).toHaveBeenCalledTimes(1);
      expect(mockSessionStoreCreate).toHaveBeenCalledTimes(2);
      expect(mockSessionStoreCreate.mock.calls.map(([session]) => session.providerAuth)).toEqual([
        invocationProviderAuth,
        invocationProviderAuth,
      ]);
    });

    it("freezes provider routing before invocation admission", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      const firstAccountId = "a".repeat(32);
      const editedAccountId = "b".repeat(32);
      let selectedAccountId = firstAccountId;
      mockProviderAuthList.mockReset();
      mockProviderAuthList.mockImplementation(async () => [
        {
          automation_id: "auto-1",
          provider: "openai",
          auth_mode: "provider_account",
          provider_account_id: selectedAccountId,
          created_at: 1,
          updated_at: 1,
        },
      ]);
      mockResolveSessionProviderAuth.mockReset();
      mockResolveSessionProviderAuth.mockImplementation(async (_db, options) => [
        {
          provider: "openai",
          authMode: "provider_account",
          providerAccountId: options.explicit.openai.accountId,
          selectionSource: "explicit",
        },
        { provider: "xai", authMode: "api_key", selectionSource: "unattended_policy" },
      ]);
      mockStore.insertInvocationGuarded.mockImplementation(async (params: unknown) => {
        capturedInvocationParams.push(
          structuredClone(params) as { children: Array<Record<string, unknown>> }
        );
        // Simulate an automation edit racing immediately after the firing is
        // admitted. The launched session must retain the pre-admission pin.
        selectedAccountId = editedAccountId;
        return { inserted: true };
      });

      const scheduler = createScheduler();
      await scheduler.tick();
      expect(mockSessionStoreCreate.mock.calls[0][0].providerAuth).toContainEqual({
        provider: "openai",
        authMode: "provider_account",
        providerAccountId: firstAccountId,
        selectionSource: "automation_pin",
      });
    });

    it("starts later child launches before earlier child sessions finish initializing", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [
        repositoryRow("auto-1", { repo_name: "web-app" }),
        repositoryRow("auto-1", { repo_name: "api", base_branch: null }),
      ]);

      const firstInit = deferred<Response>();
      const firstInitStarted = deferred<void>();
      let initCalls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        const path = new URL(url).pathname;

        if (path === "/internal/init") {
          initCalls++;
          if (initCalls === 1) {
            firstInitStarted.resolve();
            return firstInit.promise;
          }
          return Response.json({ status: "ok" });
        }

        if (path === "/internal/prompt") {
          return Response.json({ messageId: "msg-1", status: "queued" });
        }

        return new Response("Not Found", { status: 404 });
      });

      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue({ fetch: fetchMock } as never);

      const scheduler = createScheduler(env);
      const tickPromise = scheduler.tick();

      await firstInitStarted.promise;

      try {
        await vi.waitFor(() => {
          expect(initCalls).toBe(2);
        });
      } finally {
        firstInit.resolve(Response.json({ status: "ok" }));
        await tickPromise;
      }

      expect(initCalls).toBe(2);
      expect(mockStore.claimRunSession).toHaveBeenCalledTimes(2);
    });

    it("passes automation reasoning effort into created sessions", async () => {
      const automation = { ...sampleAutomation, reasoning_effort: "high" };
      mockStore.getOverdueAutomations.mockResolvedValue([automation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      await scheduler.tick();
      const initBody = await getInitBody(fetchMock);
      expect(initBody.reasoningEffort).toBe("high");
      expect(initBody).not.toHaveProperty("providerAuth");
    });

    it("snapshots the resolved repository onto the child and the session", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      mockCheckRepositoryAccess.mockResolvedValue({
        repoId: 98765,
        repoOwner: "acme",
        repoName: "web-app",
        defaultBranch: "main",
      });

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      await scheduler.tick();
      expect(mockCheckRepositoryAccess).toHaveBeenCalledWith({
        owner: "acme",
        name: "web-app",
      });

      // The selection's fixed branch wins over the repo default.
      expect(lastInsertedChildren()[0]).toMatchObject({
        repo_owner: "acme",
        repo_name: "web-app",
        repo_id: 98765,
        base_branch: "release",
      });

      const initBody = await getInitBody(fetchMock);
      expect(initBody.repoOwner).toBe("acme");
      expect(initBody.repoName).toBe("web-app");
      expect(initBody.repoId).toBe(98765);
      expect(initBody.defaultBranch).toBe("release");
      expect(mockSessionStoreCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          repoOwner: "acme",
          repoName: "web-app",
          baseBranch: "release",
        })
      );
    });

    it("creates sessions with null repo fields for repo-less automations", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", []);

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      await scheduler.tick();
      expect(mockCheckRepositoryAccess).not.toHaveBeenCalled();

      expect(lastInsertedChildren()).toEqual([
        expect.objectContaining({
          repo_owner: null,
          repo_name: null,
          repo_id: null,
          base_branch: null,
          status: "starting",
        }),
      ]);

      const initBody = await getInitBody(fetchMock);
      expect(initBody.repoOwner).toBeNull();
      expect(initBody.repoName).toBeNull();
      expect(initBody.repoId).toBeNull();
      expect(initBody.defaultBranch).toBeNull();
      expect(initBody.codeServerEnabled).toBe(false);
      expect(initBody.vncEnabled).toBe(false);
      expect(mockSessionStoreCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          repoOwner: null,
          repoName: null,
          baseBranch: null,
        })
      );
    });

    it("fans out one workspace session per selected environment", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", []);
      selectEnvironments("auto-1", ["env_1"]);
      mockEnvironmentGetById.mockResolvedValue({ id: "env_1", name: "Fullstack" });
      mockEnvironmentRepositories.mockResolvedValue([
        { repo_owner: "acme", repo_name: "web-app", repo_id: 12345, base_branch: "main" },
        { repo_owner: "acme", repo_name: "api", repo_id: 67890, base_branch: "develop" },
      ]);
      mockCheckRepositoryAccess.mockImplementation(async ({ owner, name }) => ({
        repoId: name === "api" ? 67890 : 12345,
        repoOwner: owner,
        repoName: name,
        defaultBranch: "main",
      }));

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      await scheduler.tick();
      // One child per environment, snapshotting the environment id — no
      // repository snapshot of its own.
      expect(lastInsertedChildren()).toEqual([
        expect.objectContaining({
          repo_owner: null,
          repo_name: null,
          repo_id: null,
          base_branch: null,
          environment_id: "env_1",
          status: "starting",
        }),
      ]);

      const initBody = await getInitBody(fetchMock);
      expect(initBody.environmentId).toBe("env_1");
      expect(initBody.repositories).toEqual([
        { repoOwner: "acme", repoName: "web-app", repoId: 12345, baseBranch: "main" },
        { repoOwner: "acme", repoName: "api", repoId: 67890, baseBranch: "develop" },
      ]);
      // Primary member mirrored into the scalar fields.
      expect(initBody.repoOwner).toBe("acme");
      expect(initBody.repoName).toBe("web-app");
      expect(initBody.repoId).toBe(12345);
      expect(initBody.defaultBranch).toBe("main");
      expect(promptCallCount(fetchMock)).toBe(1);
    });

    it("fans out repository and environment targets together", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      selectEnvironments("auto-1", ["env_1", "env_2"]);
      mockEnvironmentGetById.mockImplementation(async (id: string) => ({
        id,
        name: `Env ${id}`,
      }));
      mockEnvironmentRepositories.mockResolvedValue([
        { repo_owner: "acme", repo_name: "api", repo_id: 67890, base_branch: "develop" },
      ]);
      mockCheckRepositoryAccess.mockImplementation(async ({ owner, name }) => ({
        repoId: name === "api" ? 67890 : 12345,
        repoOwner: owner,
        repoName: name,
        defaultBranch: "main",
      }));

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      await scheduler.tick();
      expect(lastInsertedChildren()).toEqual([
        expect.objectContaining({
          repo_owner: "acme",
          repo_name: "web-app",
          environment_id: null,
          status: "starting",
        }),
        expect.objectContaining({
          repo_owner: null,
          environment_id: "env_1",
          status: "starting",
        }),
        expect.objectContaining({
          repo_owner: null,
          environment_id: "env_2",
          status: "starting",
        }),
      ]);
      expect(promptCallCount(fetchMock)).toBe(3);
    });

    it("fails the environment child when its environment no longer exists", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", []);
      selectEnvironments("auto-1", ["env_gone"]);
      mockEnvironmentGetById.mockResolvedValue(null);

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      await scheduler.tick();
      expect(promptCallCount(fetchMock)).toBe(0);
      expect(mockStore.updateRun).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: "failed",
          failure_reason: expect.stringContaining("Environment not found: env_gone"),
        })
      );
      // Launch failures have no callback coming — the strike applies now.
      expect(mockStore.getInvocationRunAggregate).toHaveBeenCalled();
    });

    it("fails the environment child when a workspace member is inaccessible", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", []);
      selectEnvironments("auto-1", ["env_1"]);
      mockEnvironmentGetById.mockResolvedValue({ id: "env_1", name: "Fullstack" });
      mockEnvironmentRepositories.mockResolvedValue([
        { repo_owner: "acme", repo_name: "web-app", repo_id: 12345, base_branch: "main" },
        { repo_owner: "acme", repo_name: "api", repo_id: 67890, base_branch: "develop" },
      ]);
      mockCheckRepositoryAccess.mockImplementation(async ({ owner, name }) =>
        name === "api"
          ? null
          : { repoId: 12345, repoOwner: owner, repoName: name, defaultBranch: "main" }
      );

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      await scheduler.tick();
      expect(promptCallCount(fetchMock)).toBe(0);
      expect(mockStore.updateRun).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: "failed",
          failure_reason: expect.stringContaining("acme/api"),
        })
      );
    });

    it("falls back to the repository default branch when the selection has none", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1", { base_branch: null })]);
      mockCheckRepositoryAccess.mockResolvedValue({
        repoId: 12345,
        repoOwner: "acme",
        repoName: "web-app",
        defaultBranch: "develop",
      });

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      await scheduler.tick();
      const initBody = await getInitBody(fetchMock);
      expect(initBody.defaultBranch).toBe("develop");
    });

    it("pre-fails the child when its repository is inaccessible (born-terminal invocation)", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      mockCheckRepositoryAccess.mockResolvedValue(null);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ active: 0, failed: 1, completed: 0 })
      );

      const scheduler = createScheduler();
      const result = await scheduler.tick();

      expect(result).toMatchObject({ processed: 0, failed: 1 });

      // The child is born failed inside the atomic batch — no separate update.
      expect(lastInsertedChildren()[0]).toMatchObject({
        status: "failed",
        failure_reason: "Repository is not accessible for the configured SCM provider",
        repo_owner: "acme",
        repo_name: "web-app",
      });

      // Born-terminal: finalized immediately with one CAS-guarded strike.
      expect(mockStore.tryMarkInvocationFailureCounted).toHaveBeenCalledTimes(1);
      expect(mockStore.incrementConsecutiveFailures).toHaveBeenCalledWith("auto-1");
    });

    it("one inaccessible repository never blocks its siblings", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [
        repositoryRow("auto-1", { repo_name: "broken" }),
        repositoryRow("auto-1", { repo_name: "web-app" }),
      ]);
      mockCheckRepositoryAccess.mockImplementation(
        async ({ name }: { owner: string; name: string }) =>
          name === "broken"
            ? null
            : { repoId: 1, repoOwner: "acme", repoName: name, defaultBranch: "main" }
      );
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 2, active: 1, failed: 1 })
      );

      const scheduler = createScheduler();
      const result = await scheduler.tick();

      expect(result).toMatchObject({ processed: 1 });

      const children = lastInsertedChildren();
      expect(children[0]).toMatchObject({ repo_name: "broken", status: "failed" });
      expect(children[1]).toMatchObject({ repo_name: "web-app", status: "starting" });
      // The healthy sibling launched.
      expect(mockStore.claimRunSession).toHaveBeenCalledWith(
        children[1].id,
        expect.any(String),
        expect.any(Number)
      );
      // One strike for the invocation, not per failed child.
      expect(mockStore.tryMarkInvocationFailureCounted).toHaveBeenCalledTimes(1);
    });

    it("passes resolved code-server and sandbox settings into automation sessions", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1", { base_branch: "main" })]);

      const env = createEnv({ DB: createIntegrationSettingsDbMock() });
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      await scheduler.tick();
      const initBody = await getInitBody(fetchMock);
      expect(initBody.codeServerEnabled).toBe(true);
      expect(initBody.vncEnabled).toBe(true);
      expect(initBody.sandboxSettings).toEqual({ tunnelPorts: [5173], terminalEnabled: true });
    });

    it("records an atomic childless skip when a run is active (concurrency guard)", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      mockStore.getActiveRunForAutomation.mockResolvedValue({
        id: "existing-run",
        status: "running",
      });

      const scheduler = createScheduler();
      const result = await scheduler.tick();

      expect(result).toMatchObject({ skipped: 1, processed: 0 });

      // Childless skip invocation + schedule advance in ONE atomic call.
      expect(mockStore.insertSkippedInvocation).toHaveBeenCalledWith(
        expect.objectContaining({
          automation_id: "auto-1",
          source: "schedule",
          scheduled_at: sampleAutomation.next_run_at,
          skip_reason: "concurrent_run_active",
        }),
        { fromSlot: sampleAutomation.next_run_at, nextRunAt: expect.any(Number) }
      );
      expect(mockStore.insertInvocationGuarded).not.toHaveBeenCalled();
    });

    it("records the skip without re-advancing when the guarded insert loses the race", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      // Pre-check passes, but the batch's overlap predicate suppressed the
      // insert (a run went active in between). The batch already advanced.
      mockStore.insertInvocationGuarded.mockResolvedValue({ inserted: false });

      const scheduler = createScheduler();
      const result = await scheduler.tick();

      expect(result.skipped).toBe(1);

      expect(mockStore.insertSkippedInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ skip_reason: "concurrent_run_active" }),
        undefined
      );
    });

    it("re-advances the schedule and stands down on a cron double-fire", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      // UNIQUE violation on the idempotency index rolls back the whole batch
      // including the advance.
      mockStore.insertInvocationGuarded.mockRejectedValue(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: automation_invocations.automation_id, automation_invocations.scheduled_at"
        )
      );

      const scheduler = createScheduler();
      const result = await scheduler.tick();

      expect(result).toMatchObject({ skipped: 1, failed: 0 });

      expect(mockStore.advanceNextRunAt).toHaveBeenCalledWith("auto-1", expect.any(Number));
      expect(mockStore.insertSkippedInvocation).not.toHaveBeenCalled();
    });

    it("stops pulling overdue automations once the child launch budget is spent", async () => {
      // 6 automations × 10 repos = 60 children; the budget (50) admits 5.
      const overdue = Array.from({ length: 6 }, (_, i) => ({
        ...sampleAutomation,
        id: `auto-${i}`,
      }));
      mockStore.getOverdueAutomations.mockResolvedValue(overdue);
      mockStore.getRepositoriesForAutomationIds.mockResolvedValue(
        new Map(
          overdue.map((automation) => [
            automation.id,
            Array.from({ length: 10 }, (_, r) =>
              repositoryRow(automation.id, { repo_name: `repo-${r}` })
            ),
          ])
        )
      );
      mockCheckRepositoryAccess.mockImplementation(
        async ({ name }: { owner: string; name: string }) => ({
          repoId: 1,
          repoOwner: "acme",
          repoName: name,
          defaultBranch: "main",
        })
      );

      const scheduler = createScheduler();
      const result = await scheduler.tick();

      expect(result.processed).toBe(5);
      expect(mockStore.insertInvocationGuarded).toHaveBeenCalledTimes(5);
    });

    it("defers an automation whose children would overshoot the budget", async () => {
      // Repo counts fill the budget unevenly: 10+10+10+10+9 = 49 admitted, so
      // the sixth 10-repo firing (→59) must be deferred rather than launched.
      // The pre-check catches this; the old check-after-launch path would have
      // materialized all 10 children before noticing the overshoot.
      const repoCounts = [10, 10, 10, 10, 9, 10];
      const overdue = repoCounts.map((_, i) => ({ ...sampleAutomation, id: `auto-${i}` }));
      mockStore.getOverdueAutomations.mockResolvedValue(overdue);
      mockStore.getRepositoriesForAutomationIds.mockResolvedValue(
        new Map(
          overdue.map((automation, i) => [
            automation.id,
            Array.from({ length: repoCounts[i] }, (_, r) =>
              repositoryRow(automation.id, { repo_name: `repo-${r}` })
            ),
          ])
        )
      );
      mockCheckRepositoryAccess.mockImplementation(
        async ({ name }: { owner: string; name: string }) => ({
          repoId: 1,
          repoOwner: "acme",
          repoName: name,
          defaultBranch: "main",
        })
      );

      const scheduler = createScheduler();
      await scheduler.tick();
      // Five automations admitted (49 children); the sixth deferred to next tick.
      expect(mockStore.insertInvocationGuarded).toHaveBeenCalledTimes(5);
    });

    it("marks the child as failed when session creation throws", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ active: 0, failed: 1, completed: 0 })
      );

      const failingStub = {
        fetch: vi.fn().mockRejectedValue(new Error("Session init failed")),
      } as never;

      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createScheduler(env);
      const result = await scheduler.tick();

      expect(result.failed).toBe(1);

      expect(mockStore.updateRun).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "failed" })
      );
      expect(mockStore.incrementConsecutiveFailures).toHaveBeenCalledWith("auto-1");
    });

    it("claims the run session before initializing it", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);

      const scheduler = createScheduler();
      await scheduler.tick();

      expect(mockStore.claimRunSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number)
      );
      expect(mockStore.claimRunSession.mock.invocationCallOrder[0]).toBeLessThan(
        mockSessionStoreCreate.mock.invocationCallOrder[0]
      );
    });

    it("does not initialize a session after recovery wins the launch claim", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      mockStore.claimRunSession.mockResolvedValue(false);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ active: 0, failed: 1, completed: 0 })
      );

      const scheduler = createScheduler();
      await scheduler.tick();

      expect(mockSessionStoreCreate).not.toHaveBeenCalled();
    });

    it("auto-pauses after 3 consecutive failures", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ active: 0, failed: 1, completed: 0 })
      );
      mockStore.incrementConsecutiveFailures.mockResolvedValue(3);

      const failingStub = {
        fetch: vi.fn().mockRejectedValue(new Error("Session init failed")),
      } as never;

      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createScheduler(env);
      await scheduler.tick();

      expect(mockStore.autoPause).toHaveBeenCalledWith("auto-1");
    });

    it("does not auto-pause at fewer than 3 failures", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ active: 0, failed: 1, completed: 0 })
      );
      mockStore.incrementConsecutiveFailures.mockResolvedValue(2);

      const failingStub = {
        fetch: vi.fn().mockRejectedValue(new Error("fail")),
      } as never;

      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createScheduler(env);
      await scheduler.tick();

      expect(mockStore.autoPause).not.toHaveBeenCalled();
    });

    it("strikes once per invocation even when the CAS is already taken", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ active: 0, failed: 1, completed: 0 })
      );
      mockStore.tryMarkInvocationFailureCounted.mockResolvedValue(false);

      const failingStub = {
        fetch: vi.fn().mockRejectedValue(new Error("fail")),
      } as never;
      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createScheduler(env);
      await scheduler.tick();

      expect(mockStore.incrementConsecutiveFailures).not.toHaveBeenCalled();
    });

    it("passes automation user_id to session index", async () => {
      const automation = { ...sampleAutomation, user_id: "canonical-user-1" };
      mockStore.getOverdueAutomations.mockResolvedValue([automation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);

      const scheduler = createScheduler();
      await scheduler.tick();

      expect(mockSessionStoreCreate).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "canonical-user-1" })
      );
    });

    it("falls back to identity lookup for legacy automations without user_id", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      mockUserStoreGetIdentity.mockResolvedValue({ userId: "looked-up-user" });

      const scheduler = createScheduler();
      await scheduler.tick();

      expect(mockUserStoreGetIdentity).toHaveBeenCalledWith("github", "user-1");
      expect(mockSessionStoreCreate).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "looked-up-user" })
      );
    });

    it("creates session with null userId when identity lookup finds nothing", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      mockUserStoreGetIdentity.mockResolvedValue(null);

      const scheduler = createScheduler();
      await scheduler.tick();

      expect(mockSessionStoreCreate).toHaveBeenCalledWith(
        expect.objectContaining({ userId: null })
      );
    });

    it("swallows launch-failure tracking errors and logs scheduler.fail_track_error", async () => {
      mockStore.getOverdueAutomations.mockResolvedValue([sampleAutomation]);
      selectRepositories("auto-1", [repositoryRow("auto-1")]);
      mockStore.updateRun.mockRejectedValueOnce(new Error("D1 timeout"));
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ active: 0, failed: 1, completed: 0 })
      );

      const failingStub = {
        fetch: vi.fn().mockRejectedValue(new Error("Session init failed")),
      } as never;

      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createScheduler(env);
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      const result = await scheduler.tick();

      expect(result.failed).toBe(1);

      const failTrackCall = errorSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event === "scheduler.fail_track_error" &&
          (data as Record<string, unknown> | undefined)?.original_reason === "Session init failed"
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
    });

    // ── Recovery sweep ──────────────────────────────────────────────────────

    it("applies one CAS-guarded strike per invocation for recovered children", async () => {
      // Two stuck children of the SAME invocation → one strike, not two.
      const orphanedRuns = [
        {
          id: "orphan-a",
          automation_id: "auto-1",
          invocation_id: "inv-9",
          status: "starting",
          created_at: now - 1,
        },
        {
          id: "orphan-b",
          automation_id: "auto-1",
          invocation_id: "inv-9",
          status: "starting",
          created_at: now - 2,
        },
      ];
      mockStore.getOrphanedStartingRuns.mockResolvedValue(orphanedRuns);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 2, active: 0, failed: 2 })
      );

      const scheduler = createScheduler();
      await scheduler.tick();

      expect(mockStore.bulkFailStartingRuns).toHaveBeenCalledWith(
        ["orphan-a", "orphan-b"],
        "session_creation_timeout",
        expect.any(Number)
      );
      expect(mockStore.getInvocationRunAggregate).toHaveBeenCalledTimes(1);
      expect(mockStore.tryMarkInvocationFailureCounted).toHaveBeenCalledExactlyOnceWith("inv-9");
      expect(mockStore.incrementConsecutiveFailures).toHaveBeenCalledExactlyOnceWith("auto-1");
    });

    it("recovers timed-out running runs", async () => {
      const timedOutRun = {
        id: "timeout-1",
        automation_id: "auto-1",
        invocation_id: "inv-timeout",
        status: "running",
        started_at: now - 2 * 60 * 60 * 1000,
      };
      mockStore.getTimedOutRunningRuns.mockResolvedValue([timedOutRun]);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 1, active: 0, failed: 1 })
      );

      const scheduler = createScheduler();
      await scheduler.tick();

      expect(mockStore.bulkFailRunningRuns).toHaveBeenCalledWith(
        ["timeout-1"],
        "execution_timeout",
        expect.any(Number)
      );
    });

    it("recovers one category when the other recovery query fails", async () => {
      const timedOutRun = {
        id: "timeout-1",
        automation_id: "auto-1",
        invocation_id: "inv-timeout",
        status: "running",
        started_at: now - 2 * 60 * 60 * 1000,
      };
      mockStore.getOrphanedStartingRuns.mockRejectedValue(new Error("D1 orphan query timeout"));
      mockStore.getTimedOutRunningRuns.mockResolvedValue([timedOutRun]);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 1, active: 0, failed: 1 })
      );

      const scheduler = createScheduler();
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      await scheduler.tick();
      expect(mockStore.bulkFailRunningRuns).toHaveBeenCalledWith(
        ["timeout-1"],
        "execution_timeout",
        expect.any(Number)
      );
      expect(mockStore.tryMarkInvocationFailureCounted).toHaveBeenCalledWith("inv-timeout");

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

    it("batches multiple orphaned runs into a single recovery write", async () => {
      const orphanedRuns = [
        {
          id: "orphan-a",
          automation_id: "auto-1",
          invocation_id: "inv-batch",
          status: "starting",
          created_at: now - 1,
        },
        {
          id: "orphan-b",
          automation_id: "auto-1",
          invocation_id: "inv-batch",
          status: "starting",
          created_at: now - 2,
        },
        {
          id: "orphan-c",
          automation_id: "auto-1",
          invocation_id: "inv-batch",
          status: "starting",
          created_at: now - 3,
        },
      ];
      mockStore.getOrphanedStartingRuns.mockResolvedValue(orphanedRuns);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 3, active: 0, failed: 3 })
      );

      const scheduler = createScheduler();
      await scheduler.tick();

      expect(mockStore.bulkFailStartingRuns).toHaveBeenCalledTimes(1);
      expect(mockStore.bulkFailStartingRuns).toHaveBeenCalledWith(
        ["orphan-a", "orphan-b", "orphan-c"],
        "session_creation_timeout",
        expect.any(Number)
      );
      expect(mockStore.getInvocationRunAggregate).toHaveBeenCalledExactlyOnceWith("inv-batch");
    });

    it("auto-pauses automation when recovered invocation reaches threshold", async () => {
      const orphanedRun = {
        id: "orphan-1",
        automation_id: "auto-1",
        invocation_id: "inv-threshold",
        status: "starting",
        created_at: now - 10 * 60 * 1000,
      };
      mockStore.getOrphanedStartingRuns.mockResolvedValue([orphanedRun]);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 1, active: 0, failed: 1 })
      );
      mockStore.incrementConsecutiveFailures.mockResolvedValue(3);

      const scheduler = createScheduler();
      const warnSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "warn")
        .mockImplementation(() => {});

      await scheduler.tick();

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

    it("continues accounting later invocations when one auto-pause fails", async () => {
      const orphanedRuns = [
        {
          id: "orphan-1",
          automation_id: "auto-1",
          invocation_id: "inv-auto-1",
          status: "starting",
          created_at: now - 10 * 60 * 1000,
        },
        {
          id: "orphan-2",
          automation_id: "auto-2",
          invocation_id: "inv-auto-2",
          status: "starting",
          created_at: now - 10 * 60 * 1000,
        },
      ];
      mockStore.getOrphanedStartingRuns.mockResolvedValue(orphanedRuns);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 1, active: 0, failed: 1 })
      );
      mockStore.incrementConsecutiveFailures.mockResolvedValue(3);
      mockStore.autoPause.mockImplementation(async (automationId: string) => {
        if (automationId === "auto-1") {
          throw new Error("D1 auto-pause timeout");
        }
      });

      const scheduler = createScheduler();
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});
      const warnSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "warn")
        .mockImplementation(() => {});

      await scheduler.tick();
      expect(mockStore.autoPause).toHaveBeenCalledWith("auto-1");
      expect(mockStore.autoPause).toHaveBeenCalledWith("auto-2");

      const autoPauseErrorCall = errorSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event ===
          "scheduler.recovery.bulk_track_error"
      );
      expect(autoPauseErrorCall).toBeDefined();
      expect(autoPauseErrorCall![1]).toMatchObject({
        event: "scheduler.recovery.bulk_track_error",
        automation_id: "auto-1",
        invocation_id: "inv-auto-1",
        error: "D1 auto-pause timeout",
      });

      const autoPauseSuccessCall = warnSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event === "scheduler.auto_pause" &&
          (data as Record<string, unknown> | undefined)?.automation_id === "auto-2"
      );
      expect(autoPauseSuccessCall).toBeDefined();
    });

    it("swallows orphan recovery write errors and logs scheduler.recovery.bulk_fail_error", async () => {
      const orphanedRun = {
        id: "orphan-1",
        automation_id: "auto-1",
        invocation_id: "inv-orphan",
        status: "starting",
        created_at: now - 10 * 60 * 1000,
      };
      mockStore.getOrphanedStartingRuns.mockResolvedValue([orphanedRun]);
      mockStore.bulkFailStartingRuns.mockRejectedValue(new Error("D1 timeout"));

      const scheduler = createScheduler();
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      await scheduler.tick();
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
      expect(mockStore.getInvocationRunAggregate).not.toHaveBeenCalled();
    });

    it("increments failures for runs marked failed when the other category throws", async () => {
      const orphanedRun = {
        id: "orphan-1",
        automation_id: "auto-1",
        invocation_id: "inv-orphan",
        status: "starting",
        created_at: now - 10 * 60 * 1000,
      };
      const timedOutRun = {
        id: "timeout-1",
        automation_id: "auto-2",
        invocation_id: "inv-timeout",
        status: "running",
        started_at: now - 2 * 60 * 60 * 1000,
      };
      mockStore.getOrphanedStartingRuns.mockResolvedValue([orphanedRun]);
      mockStore.getTimedOutRunningRuns.mockResolvedValue([timedOutRun]);
      mockStore.bulkFailRunningRuns.mockRejectedValue(new Error("D1 timeout"));
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 1, active: 0, failed: 1 })
      );

      const scheduler = createScheduler();
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      await scheduler.tick();

      expect(mockStore.bulkFailStartingRuns).toHaveBeenCalledWith(
        ["orphan-1"],
        "session_creation_timeout",
        expect.any(Number)
      );
      expect(mockStore.bulkFailRunningRuns).toHaveBeenCalledWith(
        ["timeout-1"],
        "execution_timeout",
        expect.any(Number)
      );

      expect(mockStore.tryMarkInvocationFailureCounted).toHaveBeenCalledWith("inv-orphan");

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

    it("swallows invocation accounting errors and logs scheduler.recovery.bulk_track_error", async () => {
      const orphanedRun = {
        id: "orphan-1",
        automation_id: "auto-1",
        invocation_id: "inv-orphan",
        status: "starting",
        created_at: now - 10 * 60 * 1000,
      };
      mockStore.getOrphanedStartingRuns.mockResolvedValue([orphanedRun]);
      mockStore.getInvocationRunAggregate.mockRejectedValue(new Error("D1 timeout"));

      const scheduler = createScheduler();
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      await scheduler.tick();
      expect(mockStore.bulkFailStartingRuns).toHaveBeenCalledWith(
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
        automation_id: "auto-1",
        invocation_id: "inv-orphan",
        error: "D1 timeout",
      });
    });

    // ── Finalization sweep (D2c) ────────────────────────────────────────────

    it("counts missed failures for all-terminal invocations found by the sweep", async () => {
      mockStore.getUncountedFailedInvocations.mockResolvedValue([
        { id: "inv-crashed", automation_id: "auto-1" },
      ]);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 2, active: 0, failed: 1, completed: 1 })
      );

      const scheduler = createScheduler();
      await scheduler.tick();

      expect(mockStore.tryMarkInvocationFailureCounted).toHaveBeenCalledWith("inv-crashed");
      expect(mockStore.incrementConsecutiveFailures).toHaveBeenCalledWith("auto-1");
    });

    it("applies missed resets for failing automations whose latest invocation completed", async () => {
      mockStore.getStaleFailureResetCandidates.mockResolvedValue([
        { automation_id: "auto-1", invocation_id: "inv-ok" },
      ]);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 2, active: 0, failed: 0, completed: 2 })
      );

      const scheduler = createScheduler();
      await scheduler.tick();

      expect(mockStore.resetConsecutiveFailures).toHaveBeenCalledWith("auto-1");
      expect(mockStore.incrementConsecutiveFailures).not.toHaveBeenCalled();
    });
  });

  describe("runComplete", () => {
    beforeEach(() => {
      mockStore.getRunById.mockResolvedValue(sampleRunRow());
    });

    it("marks run as completed and resets failures once every sibling completed", async () => {
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 1, active: 0, failed: 0, completed: 1 })
      );

      const scheduler = createScheduler();
      const result = await scheduler.runComplete(runCompletion());

      expect(result).toBeUndefined();
      expect(mockStore.updateRun).toHaveBeenCalledWith("run-1", {
        status: "completed",
        completed_at: expect.any(Number),
      });
      expect(mockStore.getInvocationRunAggregate).toHaveBeenCalledWith("inv-1");
      expect(mockStore.resetConsecutiveFailures).toHaveBeenCalledWith("auto-1");
    });

    it("does not reset while siblings are still active", async () => {
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 2, active: 1, failed: 0, completed: 1 })
      );

      const scheduler = createScheduler();
      await expect(scheduler.runComplete(runCompletion())).resolves.toBeUndefined();

      expect(mockStore.resetConsecutiveFailures).not.toHaveBeenCalled();
      expect(mockStore.incrementConsecutiveFailures).not.toHaveBeenCalled();
    });

    it("never resets after a partial failure, even when the invocation finishes", async () => {
      // Sibling failed earlier (strike already taken via CAS); this success
      // finishes the invocation as partial_failed — no reset.
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 2, active: 0, failed: 1, completed: 1 })
      );
      mockStore.tryMarkInvocationFailureCounted.mockResolvedValue(false);

      const scheduler = createScheduler();
      await expect(scheduler.runComplete(runCompletion())).resolves.toBeUndefined();

      expect(mockStore.resetConsecutiveFailures).not.toHaveBeenCalled();
      expect(mockStore.incrementConsecutiveFailures).not.toHaveBeenCalled();
    });

    it("reads slack coordinates from the invocation and labels from the run snapshot", async () => {
      mockStore.getRunById.mockResolvedValue(
        sampleRunRow({
          automation_id: "auto-slack",
          invocation_id: "inv-slack",
          trigger_run_metadata: null,
        })
      );
      mockStore.getInvocationById.mockResolvedValue({
        id: "inv-slack",
        automation_id: "auto-slack",
        source: "event",
        scheduled_at: null,
        trigger_key: "slack:msg:C1:1700000000.000200",
        concurrency_key: "slack:C1:thread-root",
        trigger_metadata: JSON.stringify({ channel: "C1", messageTs: "1700000000.000200" }),
        skip_reason: null,
        failure_counted_at: null,
        created_at: now,
        updated_at: now,
      });
      mockStore.getById.mockResolvedValue(sampleSlackAutomation);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 1, active: 0, failed: 0, completed: 1 })
      );

      const slackFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
      const scheduler = createScheduler(
        createEnv({
          SLACK_BOT: { fetch: slackFetch } as unknown as Fetcher,
          SERVICE_AUTH_SECRET_SLACK_BOT: "test-secret",
        })
      );

      const result = await scheduler.runComplete(runCompletion({ automationId: "auto-slack" }));

      expect(result).toBeUndefined();
      expect(slackFetch).toHaveBeenCalledOnce();
      const [, init] = slackFetch.mock.calls[0];
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        channel: "C1",
        reactionMessageTs: "1700000000.000200",
        // Label reads the run's snapshot, not the automation row.
        repoFullName: "acme/web-app",
        sessionId: "sess-1",
        messageId: "msg-1",
      });
      expect(body.signature).toEqual(expect.any(String));
    });

    it("labels a repo-less run as No repository", async () => {
      mockStore.getRunById.mockResolvedValue(
        sampleRunRow({
          automation_id: "auto-slack",
          invocation_id: "inv-slack",
          repo_owner: null,
          repo_name: null,
          repo_id: null,
          base_branch: null,
        })
      );
      mockStore.getInvocationById.mockResolvedValue({
        id: "inv-slack",
        automation_id: "auto-slack",
        source: "event",
        scheduled_at: null,
        trigger_key: "slack:msg:C1:1700000000.000200",
        concurrency_key: "slack:C1:thread-root",
        trigger_metadata: JSON.stringify({ channel: "C1", messageTs: "1700000000.000200" }),
        skip_reason: null,
        failure_counted_at: null,
        created_at: now,
        updated_at: now,
      });
      mockStore.getById.mockResolvedValue({
        ...sampleSlackAutomation,
        repo_owner: null,
        repo_name: null,
        repo_id: null,
        base_branch: null,
      });

      const slackFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
      const scheduler = createScheduler(
        createEnv({
          SLACK_BOT: { fetch: slackFetch } as unknown as Fetcher,
          SERVICE_AUTH_SECRET_SLACK_BOT: "test-secret",
        })
      );

      const result = await scheduler.runComplete(runCompletion({ automationId: "auto-slack" }));

      expect(result).toBeUndefined();
      expect(slackFetch).toHaveBeenCalledOnce();
      const [, init] = slackFetch.mock.calls[0];
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        channel: "C1",
        reactionMessageTs: "1700000000.000200",
        repoFullName: "No repository",
      });
    });

    it("marks run as failed and takes the CAS-guarded strike on failure", async () => {
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 1, active: 0, failed: 1, completed: 0 })
      );

      const scheduler = createScheduler();
      const result = await scheduler.runComplete(
        runCompletion({ success: false, error: "Sandbox crashed" })
      );

      expect(result).toBeUndefined();
      expect(mockStore.updateRun).toHaveBeenCalledWith("run-1", {
        status: "failed",
        failure_reason: "Sandbox crashed",
        completed_at: expect.any(Number),
      });
      expect(mockStore.tryMarkInvocationFailureCounted).toHaveBeenCalledWith("inv-1");
      expect(mockStore.incrementConsecutiveFailures).toHaveBeenCalledWith("auto-1");
    });

    it("ignores callback when the guarded update finds the run already terminal", async () => {
      mockStore.getRunById.mockResolvedValue(
        sampleRunRow({ status: "failed", failure_reason: "execution_timeout", completed_at: now })
      );
      // The SQL guard suppresses the write.
      mockStore.updateRun.mockResolvedValue(false);

      const scheduler = createScheduler();
      const result = await scheduler.runComplete(runCompletion());

      expect(result).toBeUndefined();
      expect(mockStore.resetConsecutiveFailures).not.toHaveBeenCalled();
      expect(mockStore.getInvocationRunAggregate).not.toHaveBeenCalled();
    });

    it("auto-pauses after run-complete pushes failures to 3", async () => {
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 1, active: 0, failed: 1, completed: 0 })
      );
      mockStore.incrementConsecutiveFailures.mockResolvedValue(3);

      const scheduler = createScheduler();
      await expect(
        scheduler.runComplete(runCompletion({ success: false, error: "Third failure" }))
      ).resolves.toBeUndefined();

      expect(mockStore.autoPause).toHaveBeenCalledWith("auto-1");
    });

    it("propagates failure-tracking errors so the callback caller retries", async () => {
      mockStore.updateRun.mockRejectedValue(new Error("D1 timeout"));

      const scheduler = createScheduler();
      await expect(
        scheduler.runComplete(runCompletion({ success: false, error: "Sandbox crashed" }))
      ).rejects.toThrow("D1 timeout");
    });
  });

  describe("trigger", () => {
    it("rejects when automation is missing", async () => {
      mockStore.getById.mockResolvedValue(null);

      const scheduler = createScheduler();
      await expect(scheduler.trigger("nonexistent")).rejects.toThrow("Automation not found");
    });

    it("rejects when active run exists, recording nothing", async () => {
      mockStore.getById.mockResolvedValue(sampleAutomation);
      mockStore.getActiveRunForAutomation.mockResolvedValue({ id: "run-active" });

      const scheduler = createScheduler();
      await expect(scheduler.trigger("auto-1")).rejects.toThrow("An active run already exists");
      expect(mockStore.insertSkippedInvocation).not.toHaveBeenCalled();
      expect(mockStore.insertInvocationGuarded).not.toHaveBeenCalled();
    });

    it("creates an invocation and launches runs on successful trigger", async () => {
      mockStore.getById.mockResolvedValue(sampleAutomation);
      mockStore.getActiveRunForAutomation.mockResolvedValue(null);
      mockStore.getRepositoriesForAutomation.mockResolvedValue([repositoryRow("auto-1")]);

      const scheduler = createScheduler();
      const result = await scheduler.trigger("auto-1");

      expect(result).toEqual({
        invocationId: expect.any(String),
        runs: [expect.objectContaining({ status: "running" })],
      });
      const params = mockStore.insertInvocationGuarded.mock.calls[0][0];
      expect(params.invocation).toMatchObject({
        automation_id: "auto-1",
        source: "manual",
        scheduled_at: null,
      });
      expect(params.advanceSchedule).toBeUndefined();
      expect(mockStore.claimRunSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number)
      );
    });

    it("rejects when every launch fails, still recording the failed children", async () => {
      mockStore.getById.mockResolvedValue(sampleAutomation);
      mockStore.getActiveRunForAutomation.mockResolvedValue(null);
      mockStore.getRepositoriesForAutomation.mockResolvedValue([repositoryRow("auto-1")]);
      mockStore.updateRun.mockRejectedValue(new Error("D1 timeout"));
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 1, active: 0, failed: 1, completed: 0 })
      );

      const failingStub = {
        fetch: vi.fn().mockRejectedValue(new Error("Session init failed")),
      } as never;

      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createScheduler(env);
      const errorSpy = vi
        .spyOn((scheduler as unknown as { log: Logger }).log, "error")
        .mockImplementation(() => {});

      await expect(scheduler.trigger("auto-1")).rejects.toThrow("Failed to trigger automation");

      const failTrackCall = errorSpy.mock.calls.find(
        ([, data]) =>
          (data as Record<string, unknown> | undefined)?.event === "scheduler.fail_track_error"
      );
      expect(failTrackCall).toBeDefined();
    });
  });

  describe("event", () => {
    describe("lazy thread context", () => {
      /** A slack-bot binding that records thread-context calls. */
      function threadContextEnv(threadContext = "<thread_context>[]</thread_context>") {
        const slackFetch = vi.fn(async () => Response.json({ threadContext }));
        return {
          slackFetch,
          env: createEnv({
            SLACK_BOT: { fetch: slackFetch } as unknown as Fetcher,
            SERVICE_AUTH_SECRET_SLACK_BOT: "test-secret",
          } as Partial<Env>),
        };
      }

      function threadContextCalls(slackFetch: ReturnType<typeof vi.fn>) {
        return slackFetch.mock.calls.filter((call) => {
          const input = call[0];
          const url = input instanceof Request ? input.url : String(input);
          return url.includes("/internal/thread-context");
        });
      }

      it("does not request context for an unmatched reply", async () => {
        mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
        mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
        const { slackFetch, env } = threadContextEnv();

        // Fails the automation's text condition, so no run is admitted.
        expect(
          await createScheduler(env).event(makeSlackEvent({ text: "unrelated chatter" }))
        ).toEqual({ triggered: 0, skipped: 0, steered: 0 });

        expect(threadContextCalls(slackFetch)).toHaveLength(0);
      });

      it("does not request context for a successfully steered reply", async () => {
        mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
        mockStore.getLatestSteerableRunForThread.mockResolvedValue(
          sampleRunRow({ id: "active-run", session_id: "sess-running" })
        );
        const { slackFetch, env } = threadContextEnv();

        expect(
          await createScheduler(env).event(makeSlackEvent({ text: "also update the changelog" }))
        ).toEqual({ triggered: 0, skipped: 0, steered: 1 });

        expect(threadContextCalls(slackFetch)).toHaveLength(0);
      });

      it("does not request context when admission is skipped for concurrency", async () => {
        mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
        mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
        mockStore.getActiveRunForKey.mockResolvedValue(sampleRunRow({ id: "busy" }));
        const { slackFetch, env } = threadContextEnv();

        expect(await createScheduler(env).event(makeSlackEvent())).toEqual({
          triggered: 0,
          skipped: 1,
          steered: 0,
        });

        expect(threadContextCalls(slackFetch)).toHaveLength(0);
      });

      it("does not request context when the invocation is deduplicated", async () => {
        mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
        mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
        mockStore.insertInvocationGuarded.mockRejectedValue(
          new Error("UNIQUE constraint failed: automation_invocations.trigger_key")
        );
        const { slackFetch, env } = threadContextEnv();

        expect(await createScheduler(env).event(makeSlackEvent())).toEqual({
          triggered: 0,
          skipped: 1,
          steered: 0,
        });

        expect(threadContextCalls(slackFetch)).toHaveLength(0);
      });

      it("requests context once for an admitted run and splices it into the prompt", async () => {
        mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
        mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
        const { slackFetch, env } = threadContextEnv();
        const stub = env.SESSION.get(env.SESSION.idFromName("any"));

        expect(await createScheduler(env).event(makeSlackEvent())).toEqual({
          triggered: 1,
          skipped: 0,
          steered: 0,
        });

        expect(threadContextCalls(slackFetch)).toHaveLength(1);
        const prompt = await getPromptBody(vi.mocked(stub.fetch));
        const content = String(prompt.content);
        // Rebuilt block: history sits ahead of the triggering message. Assert both
        // markers exist first — indexOf returns -1 when absent, and -1 < n passes.
        const threadIndex = content.indexOf("<thread_context>");
        const userIndex = content.indexOf("<user_content>");
        expect(threadIndex).toBeGreaterThanOrEqual(0);
        expect(userIndex).toBeGreaterThanOrEqual(0);
        expect(threadIndex).toBeLessThan(userIndex);
        expect(content).toContain("please deploy the api");
        expect(content).toContain(sampleSlackPermalink);
      });

      it("reuses one context result across several matching automations", async () => {
        mockGetSlackAutomationsForChannel.mockResolvedValue([
          sampleSlackAutomation,
          { ...sampleSlackAutomation, id: "auto-slack-2" },
        ]);
        mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
        const { slackFetch, env } = threadContextEnv();

        expect(await createScheduler(env).event(makeSlackEvent())).toEqual({
          triggered: 2,
          skipped: 0,
          steered: 0,
        });

        expect(mockStore.insertInvocationGuarded).toHaveBeenCalledTimes(2);
        // Two admitted runs, one Slack read.
        expect(threadContextCalls(slackFetch)).toHaveLength(1);
      });

      it("launches without history when the context request fails", async () => {
        mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
        mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
        const slackFetch = vi.fn(async () => new Response("nope", { status: 500 }));
        const env = createEnv({
          SLACK_BOT: { fetch: slackFetch } as unknown as Fetcher,
          SERVICE_AUTH_SECRET_SLACK_BOT: "test-secret",
        } as Partial<Env>);
        const stub = env.SESSION.get(env.SESSION.idFromName("any"));

        expect(await createScheduler(env).event(makeSlackEvent())).toEqual({
          triggered: 1,
          skipped: 0,
          steered: 0,
        });

        const prompt = await getPromptBody(vi.mocked(stub.fetch));
        expect(String(prompt.content)).toContain("A message was posted in #ops.");
        expect(String(prompt.content)).not.toContain("<thread_context>");
      });

      it("launches without history when the context request is aborted", async () => {
        mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
        mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
        // What a timed-out binding fetch looks like to the caller.
        const slackFetch = vi.fn(async () => {
          throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
        });
        const env = createEnv({
          SLACK_BOT: { fetch: slackFetch } as unknown as Fetcher,
          SERVICE_AUTH_SECRET_SLACK_BOT: "test-secret",
        } as Partial<Env>);
        const stub = env.SESSION.get(env.SESSION.idFromName("any"));

        expect(await createScheduler(env).event(makeSlackEvent())).toEqual({
          triggered: 1,
          skipped: 0,
          steered: 0,
        });

        // The run still launches — a slow Slack read must not strand children.
        const prompt = await getPromptBody(vi.mocked(stub.fetch));
        expect(String(prompt.content)).toContain("A message was posted in #ops.");
        expect(String(prompt.content)).not.toContain("<thread_context>");
      });

      it("uses the baseline prompt when lazy prompt construction rejects", async () => {
        mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
        mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
        const { env } = threadContextEnv();
        const stub = env.SESSION.get(env.SESSION.idFromName("any"));
        const scheduler = createScheduler(env);
        const promptBuilder = scheduler as unknown as {
          buildSlackContextWithThread: () => Promise<string>;
        };
        vi.spyOn(promptBuilder, "buildSlackContextWithThread").mockRejectedValue(
          new Error("prompt provider failed")
        );

        expect(await scheduler.event(makeSlackEvent())).toEqual({
          triggered: 1,
          skipped: 0,
          steered: 0,
        });

        const prompt = await getPromptBody(vi.mocked(stub.fetch));
        expect(String(prompt.content)).toContain("A message was posted in #ops.");
        expect(String(prompt.content)).not.toContain("<thread_context>");
        expect(mockStore.claimRunSession).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          expect.any(Number)
        );
      });

      it("skips the request entirely for a top-level message", async () => {
        mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
        mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
        const { slackFetch, env } = threadContextEnv();

        expect(await createScheduler(env).event(makeSlackEvent({ threadTs: undefined }))).toEqual({
          triggered: 1,
          skipped: 0,
          steered: 0,
        });

        expect(threadContextCalls(slackFetch)).toHaveLength(0);
      });
    });

    it("steers the thread session even when the follow-up fails trigger conditions", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(
        sampleRunRow({ id: "active-run", session_id: "sess-running" })
      );

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      // A natural follow-up reply won't repeat the "deploy" trigger keyword, yet
      // it must still steer the thread's session — conditions gate new runs only.
      const result = await scheduler.event(
        makeSlackEvent({ text: "thanks — also update the changelog" })
      );

      expect(result).toEqual({ triggered: 0, skipped: 0, steered: 1 });

      // The continuity lookup is scoped to the thread's concurrency key and a
      // 7-day window measured from now.
      expect(mockStore.getLatestSteerableRunForThread).toHaveBeenCalledWith(
        "auto-slack",
        "slack:C1:thread-root",
        expect.any(Number)
      );
      const sinceMs = mockStore.getLatestSteerableRunForThread.mock.calls[0]?.[2] as number;
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(sinceMs).toBeGreaterThanOrEqual(Date.now() - sevenDaysMs - 1000);
      expect(sinceMs).toBeLessThanOrEqual(Date.now() - sevenDaysMs + 1000);

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
        // Label reads the steered run's snapshot.
        repoFullName: "acme/web-app",
        // Marks the turn as automation-owned even though it completes through
        // the interactive callback route.
        automationId: "auto-slack",
      });

      // A steer is not a new trigger and not a skip.
      expect(mockStore.insertInvocationGuarded).not.toHaveBeenCalled();
      expect(mockStore.insertSkippedInvocation).not.toHaveBeenCalled();
    });

    it("continues the same session on a reply after the run has completed", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      // The thread's run finished, but its session is still steerable within the
      // window — like replying after an @mention turn ends.
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(
        sampleRunRow({ id: "done-run", status: "completed", session_id: "sess-done" })
      );

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      const result = await scheduler.event(
        makeSlackEvent({ text: "actually, can you also bump the version?" })
      );

      expect(result).toEqual({ triggered: 0, skipped: 0, steered: 1 });

      const promptBody = await getPromptBody(fetchMock);
      expect(promptBody.source).toBe("slack");
      expect(promptBody.content).toBe("actually, can you also bump the version?");
      // Routed to the completed run's session — no new run, and the concurrency
      // guard is never consulted (the steer short-circuits the loop).
      expect(mockStore.insertInvocationGuarded).not.toHaveBeenCalled();
      expect(mockStore.getActiveRunForKey).not.toHaveBeenCalled();
    });

    it("uses a no-repository label when steering a repo-less run's thread", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(
        sampleRunRow({
          id: "active-run",
          session_id: "sess-running",
          repo_owner: null,
          repo_name: null,
          repo_id: null,
          base_branch: null,
        })
      );

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      const result = await scheduler.event(
        makeSlackEvent({ text: "thanks — also check the rollout" })
      );

      expect(result).toEqual({ triggered: 0, skipped: 0, steered: 1 });

      const promptBody = await getPromptBody(fetchMock);
      expect(promptBody.callbackContext).toMatchObject({
        source: "slack",
        repoFullName: "No repository",
      });
    });

    it("anchors the thread to the message ts for a top-level (non-reply) follow-up", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(
        sampleRunRow({ id: "active-run", session_id: "sess-running" })
      );

      const env = createEnv();
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const fetchMock = vi.mocked(stub.fetch);

      const scheduler = createScheduler(env);
      // No threadTs → the follow-up should anchor to its own ts.
      expect(await scheduler.event(makeSlackEvent({ threadTs: undefined }))).toEqual({
        triggered: 0,
        skipped: 0,
        steered: 1,
      });

      const promptBody = await getPromptBody(fetchMock);
      expect(promptBody.callbackContext).toMatchObject({
        threadTs: "1700000000.000200",
        reactionMessageTs: "1700000000.000200",
      });
    });

    it("starts a fresh event invocation when no steerable session exists (outside the window)", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      // Outside the continuity window → no steerable run, and no active run.
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
      mockStore.getActiveRunForKey.mockResolvedValue(null);

      const scheduler = createScheduler();
      // Matching text so the trigger conditions pass.
      const result = await scheduler.event(makeSlackEvent());

      expect(result).toEqual({ triggered: 1, skipped: 0, steered: 0 });

      const params = mockStore.insertInvocationGuarded.mock.calls[0][0];
      expect(params.invocation).toMatchObject({
        automation_id: "auto-slack",
        source: "event",
        trigger_key: "slack:msg:C1:1700000000.000200",
        concurrency_key: "slack:C1:thread-root",
        trigger_metadata: JSON.stringify({ channel: "C1", messageTs: "1700000000.000200" }),
      });
      expect(params.overlapScope).toEqual({
        kind: "concurrencyKey",
        concurrencyKey: "slack:C1:thread-root",
      });
      // Event children carry no firing keys — the keys live on the invocation.
      expect(lastInsertedChildren()[0]).toMatchObject({
        automation_id: "auto-slack",
        status: "starting",
      });
    });

    it("appends workspace session instructions to a new Slack automation session", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
      mockStore.getActiveRunForKey.mockResolvedValue(null);

      const env = createEnv({ DB: createIntegrationSettingsDbMock("Always run tests.") });
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const scheduler = createScheduler(env);

      const result = await scheduler.event(makeSlackEvent());

      expect(result).toEqual({ triggered: 1, skipped: 0, steered: 0 });
      const prompt = await getPromptBody(vi.mocked(stub.fetch));
      expect(prompt.content).toBe(
        `${sampleSlackContextBlock}\n---\n\nRun tests\n\n` +
          "## Additional Instructions\n\nAlways run tests."
      );
    });

    it("does not append whitespace-only workspace instructions", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
      mockStore.getActiveRunForKey.mockResolvedValue(null);

      const env = createEnv({ DB: createIntegrationSettingsDbMock("   \n") });
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const scheduler = createScheduler(env);

      expect(await scheduler.event(makeSlackEvent())).toEqual({
        triggered: 1,
        skipped: 0,
        steered: 0,
      });

      const prompt = await getPromptBody(vi.mocked(stub.fetch));
      expect(prompt.content).toBe(`${sampleSlackContextBlock}\n---\n\nRun tests`);
    });

    it("launches without workspace instructions when the settings read fails", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
      mockStore.getActiveRunForKey.mockResolvedValue(null);

      const env = createEnv({ DB: createIntegrationSettingsDbMock(undefined, true) });
      const stub = env.SESSION.get(env.SESSION.idFromName("any"));
      const scheduler = createScheduler(env);

      const result = await scheduler.event(makeSlackEvent());

      expect(result).toEqual({ triggered: 1, skipped: 0, steered: 0 });
      const prompt = await getPromptBody(vi.mocked(stub.fetch));
      expect(prompt.content).toBe(`${sampleSlackContextBlock}\n---\n\nRun tests`);
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

      const scheduler = createScheduler(env);
      const result = await scheduler.event(makeSlackEvent());

      expect(result).toEqual({ triggered: 0, skipped: 1, steered: 0 });
      // The skip is a childless invocation carrying the message coordinates
      // but never the dedup trigger_key (a skip must not consume the slot).
      expect(mockStore.insertSkippedInvocation).toHaveBeenCalledWith(
        expect.objectContaining({
          automation_id: "auto-slack",
          source: "event",
          skip_reason: "concurrent_run_active",
          trigger_key: null,
          concurrency_key: "slack:C1:thread-root",
          trigger_metadata: JSON.stringify({ channel: "C1", messageTs: "1700000000.000200" }),
        }),
        undefined
      );
      // No prompt reached any session.
      expect(promptCallCount(fetchMock)).toBe(0);
    });

    it("deduplicates a redelivered event via the invocation trigger-key index", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(null);
      mockStore.getActiveRunForKey.mockResolvedValue(null);
      mockStore.insertInvocationGuarded.mockRejectedValue(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: automation_invocations.automation_id, automation_invocations.trigger_key"
        )
      );

      const scheduler = createScheduler();
      const result = await scheduler.event(makeSlackEvent());

      expect(result).toEqual({ triggered: 0, skipped: 1, steered: 0 });
      // Dedup is a silent no-op — no skip row, no schedule advance.
      expect(mockStore.insertSkippedInvocation).not.toHaveBeenCalled();
      expect(mockStore.update).not.toHaveBeenCalled();
    });

    it("falls through to a new trigger when steering the session fails", async () => {
      mockGetSlackAutomationsForChannel.mockResolvedValue([sampleSlackAutomation]);
      // A completed run is steerable, but the enqueue will fail; with the run no
      // longer active, the reply is re-evaluated as a new trigger (it matches),
      // mirroring the @mention path's stale-session → new-session recovery.
      mockStore.getLatestSteerableRunForThread.mockResolvedValue(
        sampleRunRow({ id: "done-run", status: "completed", session_id: "sess-done" })
      );
      mockStore.getActiveRunForKey.mockResolvedValue(null);
      mockStore.getInvocationRunAggregate.mockResolvedValue(
        aggregate({ total: 1, active: 0, failed: 1, completed: 0 })
      );

      // Session DO rejects every fetch → steerSession fails AND the fresh run's
      // session init fails, so the child is created then marked failed.
      const failingStub = {
        fetch: vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
      } as never;
      const env = createEnv();
      vi.mocked(env.SESSION.get).mockReturnValue(failingStub);

      const scheduler = createScheduler(env);
      const result = await scheduler.event(makeSlackEvent());

      // Steer failed → fell through → matched conditions → invocation created
      // but its only child failed to launch, so triggered stays 0.
      expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0 });
      expect(mockStore.insertInvocationGuarded).toHaveBeenCalledWith(
        expect.objectContaining({
          invocation: expect.objectContaining({ automation_id: "auto-slack", source: "event" }),
        })
      );
      // Not treated as a concurrency skip.
      expect(mockStore.insertSkippedInvocation).not.toHaveBeenCalled();
    });
  });
});
