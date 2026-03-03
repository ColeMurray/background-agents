import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStateId, transitionIssueStatus } from "./issue-status";
import type { WorkflowState } from "./utils/linear-client";
import type { ResolvedLinearConfig } from "./utils/integration-config";
import type { Env } from "./types";

// ─── Fake KVNamespace ────────────────────────────────────────────────────────

function createFakeKV(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));

  const kv = {
    async get(key: string, type?: string) {
      const val = store.get(key) ?? null;
      if (val === null) return null;
      if (type === "json") return JSON.parse(val);
      return val;
    },
    async put(key: string, value: string, _options?: { expirationTtl?: number }) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };

  return { kv: kv as unknown as KVNamespace, store };
}

// ─── Test data ───────────────────────────────────────────────────────────────

const STATES: WorkflowState[] = [
  { id: "state-1", name: "Backlog", type: "backlog" },
  { id: "state-2", name: "Todo", type: "unstarted" },
  { id: "state-3", name: "In Progress", type: "started" },
  { id: "state-4", name: "In Review", type: "completed" },
  { id: "state-5", name: "Done", type: "completed" },
  { id: "state-6", name: "Cancelled", type: "canceled" },
];

function makeConfig(overrides: Partial<ResolvedLinearConfig> = {}): ResolvedLinearConfig {
  return {
    model: null,
    reasoningEffort: null,
    allowUserPreferenceOverride: true,
    allowLabelModelOverride: true,
    emitToolProgressActivities: true,
    enabledRepos: null,
    updateIssueStatus: true,
    statusMapping: {
      inProgressStateName: "In Progress",
      completedStateName: "In Review",
      cancelledStateName: null,
    },
    ...overrides,
  };
}

// ─── resolveStateId ──────────────────────────────────────────────────────────

describe("resolveStateId", () => {
  it("finds exact name match", () => {
    expect(resolveStateId(STATES, "In Progress", "inProgress")).toBe("state-3");
  });

  it("matches case-insensitively", () => {
    expect(resolveStateId(STATES, "in progress", "inProgress")).toBe("state-3");
    expect(resolveStateId(STATES, "IN REVIEW", "completed")).toBe("state-4");
  });

  it("falls back to WorkflowStateType when name does not match", () => {
    // "Working" doesn't match any name, but "started" type matches "In Progress"
    expect(resolveStateId(STATES, "Working", "inProgress")).toBe("state-3");
  });

  it("falls back to type for completed", () => {
    // "Shipped" doesn't match any name, but "completed" type matches "In Review" (first match)
    expect(resolveStateId(STATES, "Shipped", "completed")).toBe("state-4");
  });

  it("falls back to type for cancelled", () => {
    expect(resolveStateId(STATES, "Abandoned", "cancelled")).toBe("state-6");
  });

  it("returns null when neither name nor type match", () => {
    const statesWithoutCanceled = STATES.filter((s) => s.type !== "canceled");
    expect(resolveStateId(statesWithoutCanceled, "Abandoned", "cancelled")).toBeNull();
  });

  it("returns null for empty states array", () => {
    expect(resolveStateId([], "In Progress", "inProgress")).toBeNull();
  });
});

// ─── transitionIssueStatus ───────────────────────────────────────────────────

// Mock the linear-client module
vi.mock("./utils/linear-client", () => ({
  fetchTeamWorkflowStates: vi.fn(async () => STATES),
  updateIssueState: vi.fn(async () => true),
}));

import { fetchTeamWorkflowStates, updateIssueState } from "./utils/linear-client";

const mockedFetchStates = vi.mocked(fetchTeamWorkflowStates);
const mockedUpdateState = vi.mocked(updateIssueState);

describe("transitionIssueStatus", () => {
  const client = { accessToken: "test-token" };
  const issueId = "issue-1";
  const teamId = "team-1";

  function makeEnv(kvInitial: Record<string, string> = {}): Env {
    const { kv } = createFakeKV(kvInitial);
    return { LINEAR_KV: kv } as unknown as Env;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a no-op when updateIssueStatus is false", async () => {
    const config = makeConfig({ updateIssueStatus: false });
    await transitionIssueStatus(makeEnv(), client, issueId, teamId, "inProgress", config);
    expect(mockedFetchStates).not.toHaveBeenCalled();
    expect(mockedUpdateState).not.toHaveBeenCalled();
  });

  it("is a no-op when cancelledStateName is null", async () => {
    const config = makeConfig({
      statusMapping: {
        inProgressStateName: "In Progress",
        completedStateName: "In Review",
        cancelledStateName: null,
      },
    });
    await transitionIssueStatus(makeEnv(), client, issueId, teamId, "cancelled", config);
    expect(mockedFetchStates).not.toHaveBeenCalled();
    expect(mockedUpdateState).not.toHaveBeenCalled();
  });

  it("calls updateIssueState with resolved state ID for inProgress", async () => {
    const config = makeConfig();
    await transitionIssueStatus(makeEnv(), client, issueId, teamId, "inProgress", config);
    expect(mockedFetchStates).toHaveBeenCalledWith(client, teamId);
    expect(mockedUpdateState).toHaveBeenCalledWith(client, issueId, "state-3");
  });

  it("calls updateIssueState with resolved state ID for completed", async () => {
    const config = makeConfig();
    await transitionIssueStatus(makeEnv(), client, issueId, teamId, "completed", config);
    expect(mockedUpdateState).toHaveBeenCalledWith(client, issueId, "state-4");
  });

  it("uses cached states from KV on second call", async () => {
    const env = makeEnv();
    const config = makeConfig();

    await transitionIssueStatus(env, client, issueId, teamId, "inProgress", config);
    expect(mockedFetchStates).toHaveBeenCalledTimes(1);

    // Second call should use cached states
    await transitionIssueStatus(env, client, issueId, teamId, "completed", config);
    expect(mockedFetchStates).toHaveBeenCalledTimes(1);
  });

  it("does not call updateIssueState when state cannot be resolved", async () => {
    mockedFetchStates.mockResolvedValueOnce([{ id: "state-1", name: "Backlog", type: "backlog" }]);
    const config = makeConfig();
    const env = makeEnv();

    await transitionIssueStatus(env, client, issueId, teamId, "inProgress", config);
    expect(mockedUpdateState).not.toHaveBeenCalled();
  });

  it("does not call updateIssueState when no states returned", async () => {
    mockedFetchStates.mockResolvedValueOnce([]);
    const config = makeConfig();

    await transitionIssueStatus(makeEnv(), client, issueId, teamId, "inProgress", config);
    expect(mockedUpdateState).not.toHaveBeenCalled();
  });
});
