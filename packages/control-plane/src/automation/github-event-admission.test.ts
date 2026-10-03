import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAutomationEvent } from "@open-inspect/shared/triggers";
import type { AutomationRow } from "../db/automation-store";
import type * as AutomationStoreModule from "../db/automation-store";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { StartInvocationResult } from "../scheduler/scheduler";
import { admitGitHubEvent, MAX_GITHUB_ADMISSION_ATTEMPTS } from "./github-event-admission";

const mocks = vi.hoisted(() => ({
  candidates: vi.fn(),
  current: vi.fn(),
  repositories: vi.fn(),
  deny: vi.fn(),
  covers: vi.fn(),
}));

vi.mock("../db/automation-store", async (importOriginal) => ({
  ...(await importOriginal<typeof AutomationStoreModule>()),
  AutomationStore: class {
    getById = mocks.current;
    getRepositoriesForAutomation = mocks.repositories;
  },
}));
vi.mock("../db/github-automation-store", () => ({
  GitHubAutomationStore: class {
    getGitHubAutomationsForEvent = mocks.candidates;
    recordGitHubGrantDenied = mocks.deny;
  },
}));
vi.mock("../db/team-repository-grants", () => ({
  TeamRepositoryGrantStore: class {
    covers = mocks.covers;
  },
}));

const automation: AutomationRow = {
  id: "auto-github",
  name: "Review PRs",
  owner_team_id: "team_engineering",
  user_id: "11111111111111111111111111111111",
  created_by: "11111111111111111111111111111111",
  instructions: "Review the PR",
  trigger_type: "github_event",
  event_type: "pull_request.opened",
  trigger_config: null,
  trigger_auth_data: null,
  schedule_cron: null,
  schedule_tz: "UTC",
  harness: "opencode",
  model: "anthropic/claude-sonnet-4-6",
  reasoning_effort: null,
  enabled: 1,
  next_run_at: null,
  consecutive_failures: 0,
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
};
const event: GitHubAutomationEvent = {
  source: "github",
  repositoryId: 101,
  repoOwner: "current-owner",
  repoName: "current-name",
  eventType: "pull_request.opened",
  triggerKey: "pr:7:opened:sha",
  concurrencyKey: "pr:7",
  contextBlock: "PR #7 opened",
  meta: {},
};
const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} satisfies Logger;
const started: StartInvocationResult = {
  outcome: "started",
  invocationId: "invocation-1",
  runs: [],
  launched: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.candidates.mockResolvedValue([{ automation, repositoryGranted: true }]);
  mocks.current.mockResolvedValue(automation);
  mocks.repositories.mockResolvedValue([
    { repo_owner: "old-owner", repo_name: "old-name", repo_id: 101, base_branch: "main" },
  ]);
  mocks.covers.mockResolvedValue(true);
  mocks.deny.mockResolvedValue(false);
});

describe("GitHub event admission", () => {
  // No database operations reach this stub: the focused stores above supply every read/write.
  const db: SqlDatabase = {
    prepare: () => {
      throw new Error("Unexpected database operation");
    },
    batch: async () => {
      throw new Error("Unexpected database operation");
    },
  };

  it("retries a grants-version race through fresh authority and target reads", async () => {
    const fire = vi
      .fn<() => Promise<StartInvocationResult>>()
      .mockResolvedValueOnce({ outcome: "blocked", reason: "team_grants_changed" })
      .mockResolvedValueOnce(started);
    expect(await admitGitHubEvent(db, event, fire, log)).toEqual({
      triggered: 1,
      skipped: 0,
      steered: 0,
    });
    expect(fire).toHaveBeenCalledTimes(2);
    expect(mocks.current).toHaveBeenCalledTimes(2);
    expect(mocks.repositories).toHaveBeenCalledTimes(2);
    expect(fire).toHaveBeenLastCalledWith(automation, [
      { repo_owner: event.repoOwner, repo_name: event.repoName, repo_id: 101, base_branch: "main" },
    ]);
  });

  it("retries when coverage returns before a post-admission denial can be recorded", async () => {
    const fire = vi
      .fn<() => Promise<StartInvocationResult>>()
      .mockResolvedValueOnce({ outcome: "unauthorized", reason: "target_team_missing_grant" })
      .mockResolvedValueOnce(started);
    expect(await admitGitHubEvent(db, event, fire, log)).toEqual({
      triggered: 1,
      skipped: 0,
      steered: 0,
    });
    expect(mocks.deny).toHaveBeenCalledOnce();
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("settles a genuinely missing grant without calling the launch pipeline again", async () => {
    mocks.covers.mockResolvedValueOnce(true).mockResolvedValue(false);
    mocks.deny.mockResolvedValue(true);
    const fire = vi
      .fn<() => Promise<StartInvocationResult>>()
      .mockResolvedValue({ outcome: "blocked", reason: "team_grants_changed" });
    expect(await admitGitHubEvent(db, event, fire, log)).toEqual({
      triggered: 0,
      skipped: 1,
      steered: 0,
    });
    expect(fire).toHaveBeenCalledOnce();
    expect(mocks.deny).toHaveBeenCalledOnce();
  });

  it("checks current coverage before a concurrency skip can bypass denied history", async () => {
    mocks.covers.mockResolvedValue(false);
    mocks.deny.mockResolvedValue(true);
    const fire = vi
      .fn<() => Promise<StartInvocationResult>>()
      .mockResolvedValue({ outcome: "skipped" });
    expect(await admitGitHubEvent(db, event, fire, log)).toEqual({
      triggered: 0,
      skipped: 1,
      steered: 0,
    });
    expect(mocks.deny).toHaveBeenCalledOnce();
    expect(fire).not.toHaveBeenCalled();
  });

  it("admits independent candidates before propagating another candidate's exhaustion", async () => {
    const stable = { ...automation, id: "auto-stable" };
    mocks.candidates.mockResolvedValue([
      { automation, repositoryGranted: true },
      { automation: stable, repositoryGranted: true },
    ]);
    mocks.current.mockImplementation(async (id: string) =>
      id === stable.id ? stable : automation
    );
    const fire = vi
      .fn<(row: AutomationRow) => Promise<StartInvocationResult>>()
      .mockImplementation(async (row) =>
        row.id === stable.id ? started : { outcome: "blocked", reason: "team_grants_changed" }
      );
    await expect(admitGitHubEvent(db, event, fire, log)).rejects.toThrow(
      "GitHub admission did not stabilize"
    );
    expect(fire).toHaveBeenCalledTimes(MAX_GITHUB_ADMISSION_ATTEMPTS + 1);
    expect(fire).toHaveBeenLastCalledWith(stable, expect.any(Array));
  });

  it("rejects bounded retry exhaustion instead of acknowledging an unconsumed event", async () => {
    const fire = vi
      .fn<() => Promise<StartInvocationResult>>()
      .mockResolvedValue({ outcome: "blocked", reason: "team_grants_changed" });
    await expect(admitGitHubEvent(db, event, fire, log)).rejects.toThrow(
      "GitHub admission did not stabilize"
    );
    expect(fire).toHaveBeenCalledTimes(MAX_GITHUB_ADMISSION_ATTEMPTS);
    expect(mocks.deny).not.toHaveBeenCalled();
  });

  it("does not retry ordinary authority denials", async () => {
    const fire = vi
      .fn<() => Promise<StartInvocationResult>>()
      .mockResolvedValue({ outcome: "unauthorized", reason: "execution_authorization_denied" });
    expect(await admitGitHubEvent(db, event, fire, log)).toEqual({
      triggered: 0,
      skipped: 1,
      steered: 0,
    });
    expect(fire).toHaveBeenCalledOnce();
    expect(mocks.deny).not.toHaveBeenCalled();
  });

  it("counts a launch-time authority denial as skipped", async () => {
    const fire = vi.fn<() => Promise<StartInvocationResult>>().mockResolvedValue({
      ...started,
      launched: 0,
      authorizationDenial: "execution_authorization_denied",
    });
    expect(await admitGitHubEvent(db, event, fire, log)).toEqual({
      triggered: 0,
      skipped: 1,
      steered: 0,
    });
    expect(fire).toHaveBeenCalledOnce();
  });

  it("waits for the admitted invocation's asynchronous launch to settle", async () => {
    let finish: ((result: StartInvocationResult) => void) | undefined;
    const launch = new Promise<StartInvocationResult>((resolve) => {
      finish = resolve;
    });
    const fire = vi.fn().mockReturnValue(launch);
    let settled = false;
    const admission = admitGitHubEvent(db, event, fire, log).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(fire).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finish?.(started);
    expect(await admission).toEqual({ triggered: 1, skipped: 0, steered: 0 });
  });
});
