import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AutomationRun,
  ListAutomationInvocationsResponse,
} from "@open-inspect/shared/types/automations";
import type * as AuthenticateModule from "../auth/authenticate";
import type * as AutomationStoreModule from "../db/automation-store";
import { toAutomationRun, type EnrichedRunRow } from "../db/automation-store";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { SessionIndexStore } from "../db/session-index";
import { toSessionFields, type SessionRow } from "../db/session-row";
import { createTestRequestHandler, TEST_SESSION_ROW } from "../router.test-support";
import { automationRoutes } from "./automations";
import { mocks, mockStore, applyMockDefaults, automationRequest } from "./automations.test-support";

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: (...args: Parameters<typeof mocks.authenticate>) => mocks.authenticate(...args),
}));

vi.mock("../db/automation-store", async (importOriginal) => ({
  ...(await importOriginal<typeof AutomationStoreModule>()),
  AutomationStore: vi.fn().mockImplementation(function () {
    return mockStore;
  }),
}));

const callRoute = automationRequest(createTestRequestHandler([automationRoutes]));
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

describe.each([
  { name: "invocation list", path: "/automations/auto-1/invocations" },
  { name: "run item", path: "/automations/auto-1/runs/run-1" },
])("linked session privacy on $name", ({ path }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyMockDefaults();
  });

  afterEach(() => vi.restoreAllMocks());

  it("redacts non-null linked metadata without changing the run", async () => {
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
    vi.spyOn(SessionIndexStore.prototype, "getByIds").mockResolvedValue(
      new Map([["session-1", toSessionFields(privateSession)]])
    );
    vi.spyOn(SessionCollaboratorStore.prototype, "listForSessions").mockResolvedValue(new Map());
    const res = await callRoute("GET", path, {
      permissions: ["automations.read", "sessions.read"],
    });

    expect(res.status).toBe(200);
    const expectedRun = { ...run, sessionId: null, sessionTitle: null, artifactSummary: null };
    if (path.endsWith("/invocations")) {
      const body = await res.json<ListAutomationInvocationsResponse>();
      expect(body).toEqual({ invocations: [{ ...invocation, runs: [expectedRun] }], total: 1 });
    } else {
      const body = await res.json<{ run: AutomationRun }>();
      expect(body).toEqual({ run: expectedRun });
    }
  });
});
