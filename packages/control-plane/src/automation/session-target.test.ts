import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveAutomationSessionTarget } from "./session-target";
import { resolveEnvironmentTarget, resolveSessionRepositories } from "../repos/resolve";
import { HttpError, type RequestContext } from "../routes/shared";
import type { AutomationRow, AutomationRunRow } from "../db/automation-store";
import type { Env } from "../types";
import type { Logger } from "../logger";

vi.mock("../repos/resolve", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveEnvironmentTarget: vi.fn(),
    resolveSessionRepositories: vi.fn(),
  };
});

vi.mock("../db/environments", () => ({
  EnvironmentStore: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

const env = { DB: {} } as Env;
const log = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const ctx: RequestContext = {
  trace_id: "trace-1",
  request_id: "req-1",
  metrics: {} as RequestContext["metrics"],
};

function automation(overrides?: Partial<AutomationRow>): AutomationRow {
  return {
    id: "auto-1",
    name: "Daily sync",
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: "user-1",
    user_id: null,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    environment_id: null,
    ...overrides,
  };
}

function run(overrides?: Partial<AutomationRunRow>): AutomationRunRow {
  return {
    id: "run-1",
    automation_id: "auto-1",
    invocation_id: "inv-1",
    session_id: null,
    status: "starting",
    skip_reason: null,
    failure_reason: null,
    scheduled_at: 0,
    started_at: null,
    completed_at: null,
    created_at: 0,
    repo_owner: "acme",
    repo_name: "web-app",
    repo_id: 12345,
    base_branch: "main",
    ...overrides,
  };
}

describe("resolveAutomationSessionTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the run's firing-time snapshot for repository runs", async () => {
    const target = await resolveAutomationSessionTarget(env, automation(), run(), ctx, log);

    expect(target).toEqual({
      repoOwner: "acme",
      repoName: "web-app",
      repoId: 12345,
      defaultBranch: "main",
      environmentId: null,
    });
    expect(resolveEnvironmentTarget).not.toHaveBeenCalled();
  });

  it("returns null fields for repo-less runs", async () => {
    const target = await resolveAutomationSessionTarget(
      env,
      automation(),
      run({ repo_owner: null, repo_name: null, repo_id: null, base_branch: null }),
      ctx,
      log
    );

    expect(target).toEqual({
      repoOwner: null,
      repoName: null,
      repoId: null,
      defaultBranch: null,
      environmentId: null,
    });
  });

  it("resolves the environment workspace with the primary mirrored to scalars", async () => {
    const environmentInputs = [
      { repoOwner: "acme", repoName: "web-app", baseBranch: "main" },
      { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
    ];
    const repositories = [
      { repoOwner: "acme", repoName: "web-app", repoId: 12345, baseBranch: "main" },
      { repoOwner: "acme", repoName: "api", repoId: 67890, baseBranch: "develop" },
    ];
    vi.mocked(resolveEnvironmentTarget).mockResolvedValue(environmentInputs);
    vi.mocked(resolveSessionRepositories).mockResolvedValue(repositories);

    const target = await resolveAutomationSessionTarget(
      env,
      automation({ environment_id: "env_1" }),
      // The environment child is repo-less; its target comes from the binding.
      run({ repo_owner: null, repo_name: null, repo_id: null, base_branch: null }),
      ctx,
      log
    );

    expect(resolveEnvironmentTarget).toHaveBeenCalledWith(expect.anything(), "env_1");
    expect(resolveSessionRepositories).toHaveBeenCalledWith(env, environmentInputs, ctx, log);
    expect(target).toEqual({
      repoOwner: "acme",
      repoName: "web-app",
      repoId: 12345,
      defaultBranch: "main",
      repositories,
      environmentId: "env_1",
    });
  });

  it("propagates environment resolution failures to the caller", async () => {
    vi.mocked(resolveEnvironmentTarget).mockRejectedValue(
      new HttpError("Environment not found: env_gone", 404)
    );

    await expect(
      resolveAutomationSessionTarget(
        env,
        automation({ environment_id: "env_gone" }),
        run(),
        ctx,
        log
      )
    ).rejects.toThrow("Environment not found: env_gone");
  });
});
