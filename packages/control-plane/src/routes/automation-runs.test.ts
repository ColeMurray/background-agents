/**
 * Unit tests for the automation run routes.
 *
 * Tests run in Node (not workerd) with mocked stores and source control.
 * Requests dispatch through the production module, so admission (including
 * the automation ownership requirement) runs; authentication is mocked to
 * supply the principal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import type { Principal } from "../auth/principal";
import type { PermissionId } from "@open-inspect/shared/rbac";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  emptyStatement,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SESSION_ROW,
} from "../router.test-support";
import {
  MAX_AUTOMATION_INVOCATION_LIST_LIMIT,
  type AutomationRun,
  type ListAutomationInvocationsResponse,
} from "@open-inspect/shared/types/automations";
import { toAutomationRun, type EnrichedRunRow } from "../db/automation-store";
import type { SessionRow } from "../db/session-row";
import type { SqlStatement } from "../db/sql-database";
import { automationRoutes } from "./automations";
import { DEFAULT_INVOCATION_LIST_LIMIT, MAX_INVOCATION_LIST_OFFSET } from "./automation-runs";
import {
  mocks,
  mockStore,
  mockProviderAuthStore,
  mockProviderAccountStore,
  mockUserStore,
  mockEnvironmentStore,
  sampleRow,
  applyMockDefaults,
  automationRequest,
  USER_PRINCIPAL,
} from "./automations.test-support";

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: (...args: Parameters<typeof mocks.authenticate>) => mocks.authenticate(...args),
}));

vi.mock("../db/automation-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationStore: vi.fn().mockImplementation(function () {
      return mockStore;
    }),
    toAutomation: vi.fn((row: unknown) => row),
  };
});

vi.mock("../db/automation-model-provider-auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationModelProviderAuthStore: vi.fn().mockImplementation(function () {
      return mockProviderAuthStore;
    }),
  };
});

vi.mock("../db/model-provider-accounts", () => ({
  ModelProviderAccountStore: vi.fn().mockImplementation(function () {
    return mockProviderAccountStore;
  }),
}));

vi.mock("../db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(function () {
    return mockUserStore;
  }),
}));

vi.mock("../db/environments", () => ({
  EnvironmentStore: vi.fn().mockImplementation(function () {
    return mockEnvironmentStore;
  }),
}));

const handleRequest = createTestRequestHandler([automationRoutes]);
const callRoute = automationRequest(handleRequest);
const linkedRunRow: EnrichedRunRow = {
  id: "run-1",
  automation_id: "auto-1",
  invocation_id: "inv-1",
  session_id: "session-1",
  status: "completed",
  skip_reason: null,
  failure_reason: null,
  scheduled_at: 1000,
  started_at: 1100,
  execution_deadline_at: 3000,
  completed_at: 2000,
  created_at: 1000,
  repo_owner: "group/subgroup",
  repo_name: "app",
  repo_id: 42,
  base_branch: "main",
  environment_id: "env_run_snapshot",
  session_title: "Confidential session title",
  artifact_summary: "Confidential pull request summary",
};
const privateSession: SessionRow = {
  ...TEST_SESSION_ROW,
  title: linkedRunRow.session_title,
  user_id: "another-user",
  visibility: "private",
};

describe("automation run routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyMockDefaults();
  });

  describe("GET /automations/:id/invocations (list invocations)", () => {
    it("returns invocations for automation", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listInvocations.mockResolvedValue({
        invocations: [{ id: "inv-1", status: "completed", runs: [{ id: "run-1" }] }],
        total: 1,
      });

      const res = await callRoute("GET", "/automations/auto-1/invocations");
      expect(res.status).toBe(200);

      const body = await res.json<{ invocations: unknown[]; total: number }>();
      expect(body.invocations).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("GET", "/automations/missing/invocations");
      expect(res.status).toBe(404);
    });

    it("respects limit and offset params", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listInvocations.mockResolvedValue({ invocations: [], total: 0 });

      await callRoute("GET", "/automations/auto-1/invocations", {
        query: { limit: "5", offset: "10" },
      });

      expect(mockStore.listInvocations).toHaveBeenCalledWith("auto-1", {
        limit: 5,
        offset: 10,
      });
    });

    it("lists the first default-sized page when the query names no page", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listInvocations.mockResolvedValue({ invocations: [], total: 0 });

      await callRoute("GET", "/automations/auto-1/invocations");

      expect(mockStore.listInvocations).toHaveBeenCalledWith("auto-1", {
        limit: DEFAULT_INVOCATION_LIST_LIMIT,
        offset: 0,
      });
    });

    it("serves the deepest page and the largest page size", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listInvocations.mockResolvedValue({ invocations: [], total: 0 });

      const res = await callRoute("GET", "/automations/auto-1/invocations", {
        query: {
          limit: String(MAX_AUTOMATION_INVOCATION_LIST_LIMIT),
          offset: String(MAX_INVOCATION_LIST_OFFSET),
        },
      });

      expect(res.status).toBe(200);
      expect(mockStore.listInvocations).toHaveBeenCalledWith("auto-1", {
        limit: MAX_AUTOMATION_INVOCATION_LIST_LIMIT,
        offset: MAX_INVOCATION_LIST_OFFSET,
      });
    });

    it.each<{ query: Record<string, string | string[]>; error: string }>([
      { query: { limit: "0" }, error: "Invalid limit" },
      { query: { limit: "abc" }, error: "Invalid limit" },
      {
        query: { limit: String(MAX_AUTOMATION_INVOCATION_LIST_LIMIT + 1) },
        error: "Invalid limit",
      },
      { query: { limit: ["5", "6"] }, error: "Invalid limit" },
      { query: { offset: "-1" }, error: "Invalid offset" },
      { query: { offset: "abc" }, error: "Invalid offset" },
      { query: { offset: "1.5" }, error: "Invalid offset" },
      { query: { offset: String(MAX_INVOCATION_LIST_OFFSET + 1) }, error: "Invalid offset" },
      { query: { offset: ["0", "20"] }, error: "Invalid offset" },
    ])("rejects invocation query $query without listing", async ({ query, error }) => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("GET", "/automations/auto-1/invocations", { query });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error });
      expect(mockStore.listInvocations).not.toHaveBeenCalled();
    });
  });

  describe("GET /automations/:id/runs/:runId (get run)", () => {
    it("returns a specific run", async () => {
      mockStore.getRunById.mockResolvedValue({
        ...linkedRunRow,
        session_id: null,
        session_title: null,
        artifact_summary: null,
      });

      const res = await callRoute("GET", "/automations/auto-1/runs/run-1");
      expect(res.status).toBe(200);

      const body = await res.json<{ run: { id: string } }>();
      expect(body.run.id).toBe("run-1");
    });

    it("returns 404 when run not found", async () => {
      mockStore.getRunById.mockResolvedValue(null);

      const res = await callRoute("GET", "/automations/auto-1/runs/missing");
      expect(res.status).toBe(404);
    });
  });

  describe.each([
    { name: "invocation list", path: "/automations/auto-1/invocations" },
    { name: "run item", path: "/automations/auto-1/runs/run-1" },
  ])("linked session privacy on $name", ({ path }) => {
    it.each<{
      name: string;
      session: SessionRow | null;
      permissions: readonly PermissionId[];
      principal?: Principal;
      readable?: boolean;
    }>([
      {
        name: "an ordinary reader of another user's private session",
        session: privateSession,
        permissions: ["automations.read", "sessions.read"],
      },
      {
        name: "a session owner without sessions.read",
        session: { ...privateSession, user_id: "user-1", visibility: "workspace" },
        permissions: ["automations.read"],
      },
      {
        name: "an actorless Slack bot",
        session: privateSession,
        permissions: [],
        principal: { kind: "service", service: "slack-bot", actor: null },
      },
      {
        name: "a missing persisted session row",
        session: null,
        permissions: ["automations.read", "sessions.read"],
      },
      {
        name: "the current private session owner",
        session: { ...privateSession, user_id: "user-1" },
        permissions: ["automations.read", "sessions.read"],
        readable: true,
      },
    ])(
      "enforces linked metadata privacy without changing the run for $name",
      async ({ session, permissions, principal = USER_PRINCIPAL, readable = false }) => {
        const run = toAutomationRun(linkedRunRow);
        const invocation = {
          id: "inv-1",
          automationId: "auto-1",
          status: "completed" as const,
          source: "schedule" as const,
          scheduledAt: 1000,
          skipReason: null,
          createdAt: 1000,
          completedAt: 2000,
          runs: [run],
        };
        mockStore.listInvocations.mockResolvedValue({
          invocations: [{ ...invocation, runs: [{ ...run }] }],
          total: 1,
        });
        mockStore.getRunById.mockResolvedValue({ ...linkedRunRow });
        mocks.authenticate.mockImplementation(async (request: Request) => ({ principal, request }));
        const db = authorizationDatabase({
          permissions,
          batch: async <T>(statements: SqlStatement[]) =>
            Promise.all(statements.map((statement) => statement.all<T>())),
          statement(sql) {
            if (!sql.includes("FROM sessions") || !session) return emptyStatement();
            const statement: SqlStatement = {
              ...emptyStatement(),
              bind: () => statement,
              first: async <T>() => session as T,
              all: async <T>() => ({ results: [session] as T[], meta: { changes: 0 } }),
            };
            return statement;
          },
        });

        const res = await handleRequest(
          new Request(`https://test.local${path}`),
          createTestEnv({ DB: db }),
          TEST_BACKGROUND_TASK_CONTEXT
        );

        expect(res.status).toBe(200);
        const expectedRun = readable
          ? run
          : { ...run, sessionId: null, sessionTitle: null, artifactSummary: null };
        if (path.endsWith("/invocations")) {
          const body = await res.json<ListAutomationInvocationsResponse>();
          expect(body).toEqual({ invocations: [{ ...invocation, runs: [expectedRun] }], total: 1 });
        } else {
          const body = await res.json<{ run: AutomationRun }>();
          expect(body).toEqual({ run: expectedRun });
        }
      }
    );
  });
});
