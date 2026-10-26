import { describe, expect, it, vi } from "vitest";
import type { Team } from "@open-inspect/shared/types/teams";
import type { AutomationRow, AutomationRunRow } from "../db/automation-store";
import type { RequestContext } from "../routes/shared";
import { createLogger } from "../logger";
import { HarnessAdmissionError } from "../harness-admission";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";
import { AutomationExecutionUnauthorizedError } from "./contracts";
import {
  AutomationRunLaunchService,
  type AutomationRunLaunchServiceDeps,
} from "./run-launch-service";
import {
  AutomationSessionService,
  type AutomationSessionServiceDeps,
} from "./automation-session-service";
import {
  AutomationLaunchAdmissionService,
  type AutomationLaunchAdmissionServiceDeps,
} from "./launch-admission-service";
import type { CreateAutomationSessionInput, RunLaunch } from "./launch-contracts";
import type { AutomationSessionTarget } from "../automation/session-target";
import { DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS } from "@open-inspect/shared/types/automations";

const automation: AutomationRow = {
  id: "auto-1",
  name: "Daily sync",
  instructions: "Run tests",
  trigger_type: "schedule",
  schedule_cron: "0 9 * * *",
  schedule_once_at: null,
  schedule_tz: "UTC",
  harness: "codex",
  model: "openai/gpt-5.4",
  reasoning_effort: null,
  enabled: 1,
  max_concurrent_runs: DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
  next_run_at: 0,
  consecutive_failures: 0,
  created_by: "author-1",
  user_id: "user-1",
  owner_team_id: null,
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
  event_type: null,
  trigger_config: null,
  trigger_auth_data: null,
};
const target: AutomationSessionTarget = {
  repoOwner: "acme",
  repoName: "app",
  repoId: 42,
  defaultBranch: "main",
  environmentId: null,
};
const team: Team = {
  id: "team-1",
  slug: "engineering",
  name: "Engineering",
  description: null,
  joinPolicy: "invite_only",
  defaultVisibility: "team",
  defaultEnvironmentId: null,
  grantsVersion: 7,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
};
function run(): AutomationRunRow {
  return {
    id: "run-1",
    automation_id: automation.id,
    invocation_id: "inv-1",
    status: "starting",
    session_id: null,
    skip_reason: null,
    failure_reason: null,
    scheduled_at: 0,
    started_at: null,
    completed_at: null,
    execution_deadline_at: null,
    created_at: 0,
    repo_owner: target.repoOwner,
    repo_name: target.repoName,
    repo_id: target.repoId,
    base_branch: target.defaultBranch,
    environment_id: null,
    first_prompt_pending: 0,
    attempt: 1,
  };
}
function launch(): RunLaunch {
  return {
    executionPrincipal: {
      platformUserId: "user-1",
      participantUserId: "author-1",
      scmEnrichment: null,
    },
    authorization: {
      automationId: automation.id,
      executionUserId: "user-1",
      requiresRepositoryUse: true,
      requiresEnvironmentUse: false,
    },
    providerAuthSnapshot: { providerAuth: [] },
    targets: new Map(),
    retryable: true,
  };
}
function launcherHarness() {
  const deps = {
    store: {
      claimRunSession: vi
        .fn<AutomationRunLaunchServiceDeps["store"]["claimRunSession"]>()
        .mockResolvedValue(true),
      failLaunchOrRetry: vi
        .fn<AutomationRunLaunchServiceDeps["store"]["failLaunchOrRetry"]>()
        .mockResolvedValue("retrying"),
      updateRun: vi
        .fn<AutomationRunLaunchServiceDeps["store"]["updateRun"]>()
        .mockResolvedValue(true),
      markRunFirstPromptQueued: vi
        .fn<AutomationRunLaunchServiceDeps["store"]["markRunFirstPromptQueued"]>()
        .mockResolvedValue(undefined),
    },
    sessions: { create: vi.fn<AutomationSessionService["create"]>().mockResolvedValue(undefined) },
    enqueueFirstPrompt: vi
      .fn<AutomationRunLaunchServiceDeps["enqueueFirstPrompt"]>()
      .mockResolvedValue(undefined),
    continuity: {
      releaseHeldPrompts: vi
        .fn<AutomationRunLaunchServiceDeps["continuity"]["releaseHeldPrompts"]>()
        .mockResolvedValue(true),
    },
    executionDeadlineMs: vi.fn(() => 10_000),
    clock: { now: () => 1_000 },
    crypto: { generateId: () => "session-1" },
    log: createLogger("launch-service-test", {}, "error"),
  } satisfies AutomationRunLaunchServiceDeps;
  return { deps, service: new AutomationRunLaunchService(deps), child: run(), input: launch() };
}

describe("AutomationRunLaunchService", () => {
  it("claims before initialization and queues the first prompt before releasing held follow-ups", async () => {
    const { deps, service, child, input } = launcherHarness();
    input.instructionsOverride = "Event instructions";
    await service.launch(automation, child, input);
    expect(deps.store.claimRunSession).toHaveBeenCalledWith(child.id, "session-1", 1_000, 11_000);
    expect(deps.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ startedAtMs: 1_000, sessionId: "session-1" })
    );
    expect(deps.enqueueFirstPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ instructionsOverride: "Event instructions", runId: child.id })
    );
    const calls = [
      deps.store.claimRunSession,
      deps.sessions.create,
      deps.enqueueFirstPrompt,
      deps.store.markRunFirstPromptQueued,
      deps.continuity.releaseHeldPrompts,
    ];
    const order = calls.map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(child).toMatchObject({ status: "running", session_id: "session-1" });
  });

  it("does not initialize or enqueue after losing the session claim", async () => {
    const { deps, service, child, input } = launcherHarness();
    deps.store.claimRunSession.mockResolvedValue(false);
    await service.launch(automation, child, input);
    expect(deps.sessions.create).not.toHaveBeenCalled();
    expect(deps.enqueueFirstPrompt).not.toHaveBeenCalled();
  });

  it("retries initialization failures with the attempt's backoff", async () => {
    const { deps, service, child, input } = launcherHarness();
    child.attempt = 2;
    deps.sessions.create.mockRejectedValue(new Error("temporarily unavailable"));
    await service.launch(automation, child, input);
    expect(deps.store.failLaunchOrRetry).toHaveBeenCalledWith(
      child.id,
      "temporarily unavailable",
      1_000,
      241_000
    );
    expect(child).toMatchObject({ status: "retrying", retry_at: 241_000, session_id: null });
    expect(deps.enqueueFirstPrompt).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguous first-prompt failure", async () => {
    const { deps, service, child, input } = launcherHarness();
    deps.enqueueFirstPrompt.mockRejectedValue(new Error("connection lost after enqueue"));
    await service.launch(automation, child, input);
    expect(deps.store.failLaunchOrRetry).not.toHaveBeenCalled();
    expect(deps.store.updateRun).toHaveBeenCalledWith(child.id, {
      status: "failed",
      failure_reason: "connection lost after enqueue",
      completed_at: 1_000,
    });
    expect(deps.continuity.releaseHeldPrompts).not.toHaveBeenCalled();
  });

  it.each(["mark", "release"])(
    "keeps a successful launch running when held-prompt %s fails",
    async (failure) => {
      const { deps, service, child, input } = launcherHarness();
      if (failure === "mark")
        deps.store.markRunFirstPromptQueued.mockRejectedValue(new Error("D1 unavailable"));
      else deps.continuity.releaseHeldPrompts.mockRejectedValue(new Error("session unavailable"));
      await service.launch(automation, child, input);
      expect(child.status).toBe("running");
      expect(deps.store.updateRun).not.toHaveBeenCalled();
      expect(deps.store.failLaunchOrRetry).not.toHaveBeenCalled();
      if (failure === "mark") expect(deps.continuity.releaseHeldPrompts).not.toHaveBeenCalled();
    }
  );

  it.each([
    new HarnessAdmissionError("invalid harness"),
    new ProviderAccountSelectionPolicyError("invalid account", 409),
  ])("does not retry configuration failures: %s", async (error) => {
    const { deps, service, child, input } = launcherHarness();
    input.providerAuthSnapshot = { error };
    await service.launch(automation, child, input);
    expect(deps.store.claimRunSession).not.toHaveBeenCalled();
    expect(deps.store.failLaunchOrRetry).not.toHaveBeenCalled();
    expect(child.status).toBe("failed");
  });

  it("records revoked authority as unauthorized without retrying", async () => {
    const { deps, service, child, input } = launcherHarness();
    deps.sessions.create.mockRejectedValue(
      new AutomationExecutionUnauthorizedError("team_archived")
    );
    await service.launch(automation, child, input);
    expect(child).toMatchObject({
      status: "unauthorized",
      failure_reason: "team_archived",
      session_id: null,
    });
    expect(deps.store.failLaunchOrRetry).not.toHaveBeenCalled();
  });

  it("contains failure-recording errors when recovery supplies an admission failure", async () => {
    const { deps, service, child } = launcherHarness();
    deps.store.failLaunchOrRetry.mockRejectedValue(new Error("D1 unavailable"));
    await expect(
      service.recordFailure(child, new Error("admission failed"), true)
    ).resolves.toBeUndefined();
    expect(child).toMatchObject({ status: "failed", failure_reason: "admission failed" });
  });
});

function sessionHarness() {
  const ctx = { trace_id: "automation:auto-1", request_id: "run-1" } as RequestContext;
  const deps = {
    store: {
      setRunExecutionDeadline: vi
        .fn<AutomationSessionServiceDeps["store"]["setRunExecutionDeadline"]>()
        .mockResolvedValue(true),
    },
    createRequestContext: () => ctx,
    resolveTarget: vi.fn<AutomationSessionServiceDeps["resolveTarget"]>().mockResolvedValue(target),
    resolveSettings: vi.fn<AutomationSessionServiceDeps["resolveSettings"]>().mockResolvedValue({
      codeServerEnabled: true,
      vncEnabled: false,
      sandboxSettings: { sandboxTimeoutMs: 20_000 },
    }),
    resolveSkills: vi.fn<AutomationSessionServiceDeps["resolveSkills"]>().mockResolvedValue({
      selection: { mode: "all" },
      resolverVersion: 1,
      manifestSha256: "skills",
      resolvedAt: 1_000,
      skills: [],
    }),
    teams: {
      getById: vi.fn<AutomationSessionServiceDeps["teams"]["getById"]>().mockResolvedValue(team),
    },
    isAuthorized: vi.fn<AutomationSessionServiceDeps["isAuthorized"]>().mockResolvedValue(true),
    selectMemory: vi.fn<AutomationSessionServiceDeps["selectMemory"]>().mockResolvedValue({
      selectionVersion: 1,
      manifestSha256: "memory",
      resolvedAt: 1_000,
      personalOwnerUserId: null,
      directiveChars: 0,
      catalogChars: 0,
      estimatedTokens: 0,
      omittedCount: 0,
      items: [],
    }),
    initializeSession: vi
      .fn<AutomationSessionServiceDeps["initializeSession"]>()
      .mockResolvedValue(undefined),
    executionDeadlineMs: (settings) => settings.sandboxTimeoutMs! + 5_000,
  } satisfies AutomationSessionServiceDeps;
  const initial = launch();
  const input: CreateAutomationSessionInput = {
    automation,
    run: run(),
    sessionId: "session-1",
    providerAuth: [],
    executionPrincipal: initial.executionPrincipal,
    startedAtMs: 500,
    admission: { authorization: initial.authorization },
  };
  return { deps, input, ctx, service: new AutomationSessionService(deps) };
}

describe("AutomationSessionService", () => {
  it("resolves workspace targets at launch and refines the deadline from claim time", async () => {
    const { deps, service, input, ctx } = sessionHarness();
    await service.create(input);
    expect(deps.resolveTarget).toHaveBeenCalledWith(input.run, ctx);
    expect(deps.store.setRunExecutionDeadline).toHaveBeenCalledWith(input.run.id, 25_500);
    expect(deps.teams.getById).not.toHaveBeenCalled();
    expect(deps.initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ...target,
        visibility: "workspace",
        participantUserId: "author-1",
        platformUserId: "user-1",
        providerAuth: input.providerAuth,
      }),
      ctx
    );
    const order = [
      deps.resolveTarget,
      deps.resolveSettings,
      deps.store.setRunExecutionDeadline,
      deps.resolveSkills,
      deps.isAuthorized,
      deps.selectMemory,
      deps.initializeSession,
    ].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("reuses a team's admitted target but reads current visibility and authority", async () => {
    const { deps, service, input, ctx } = sessionHarness();
    input.automation = { ...automation, owner_team_id: team.id };
    input.admission.target = {
      ...target,
      environmentId: "env-1",
      repositories: [{ repoOwner: "acme", repoName: "app", repoId: 42, baseBranch: "release" }],
    };
    await service.create(input);
    expect(deps.resolveTarget).not.toHaveBeenCalled();
    expect(deps.resolveSettings).toHaveBeenCalledWith(input.admission.target.repositories, "env-1");
    expect(deps.resolveSkills).toHaveBeenCalledWith(
      { repositories: input.admission.target.repositories, environmentId: "env-1" },
      { mode: "all" },
      "user-1"
    );
    expect(deps.teams.getById).toHaveBeenCalledWith(team.id);
    expect(deps.isAuthorized).toHaveBeenCalledWith(input.admission.authorization);
    expect(deps.selectMemory).toHaveBeenCalledWith(ctx, {
      principal: { userId: "user-1", ownerTeamId: team.id },
      repositories: input.admission.target.repositories,
      environmentId: "env-1",
    });
    expect(deps.initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: "team", ...input.admission.target }),
      ctx
    );
  });

  it("refuses a team launch without an admitted target", async () => {
    const { deps, service, input } = sessionHarness();
    input.automation = { ...automation, owner_team_id: team.id };
    await expect(service.create(input)).rejects.toThrow("missing its admitted target");
    expect(deps.resolveTarget).not.toHaveBeenCalled();
    expect(deps.initializeSession).not.toHaveBeenCalled();
  });

  it("stops before memory selection and initialization when authority has been revoked", async () => {
    const { deps, service, input } = sessionHarness();
    input.automation = { ...automation, owner_team_id: team.id };
    input.admission.target = target;
    deps.teams.getById.mockResolvedValue({ ...team, archivedAt: 800 });
    deps.isAuthorized.mockResolvedValue(false);
    await expect(service.create(input)).rejects.toMatchObject({ reason: "team_archived" });
    expect(deps.selectMemory).not.toHaveBeenCalled();
    expect(deps.initializeSession).not.toHaveBeenCalled();
  });
});

function admissionHarness() {
  type Deps = AutomationLaunchAdmissionServiceDeps;
  const deps = {
    resolveTarget: vi.fn<Deps["resolveTarget"]>().mockResolvedValue(target),
    grants: { covers: vi.fn<Deps["grants"]["covers"]>().mockResolvedValue(true) },
    resolveProviderAuth: vi
      .fn<Deps["resolveProviderAuth"]>()
      .mockResolvedValue([
        { provider: "openai", authMode: "api_key", selectionSource: "unattended_policy" },
      ]),
    validateHarness: vi.fn<Deps["validateHarness"]>().mockResolvedValue(undefined),
  } satisfies Deps;
  return { deps, service: new AutomationLaunchAdmissionService(deps) };
}

describe("AutomationLaunchAdmissionService", () => {
  it("checks every resolved repository against grants while preserving target errors and the original grants version", async () => {
    const { deps, service } = admissionHarness();
    const error = new Error("environment missing");
    const currentTeam = { ...team };
    deps.resolveTarget
      .mockImplementationOnce(async () => {
        currentTeam.grantsVersion = 8;
        return {
          ...target,
          repositories: [
            { repoOwner: "acme", repoName: "app", repoId: 42, baseBranch: "main" },
            { repoOwner: "acme", repoName: "lib", repoId: 43, baseBranch: "main" },
          ],
        };
      })
      .mockRejectedValueOnce(error);

    const result = await service.resolveTeamTargets(automation, currentTeam, [
      run(),
      { ...run(), id: "run-2" },
    ]);

    expect(result?.teamGrantsVersion).toEqual({ teamId: team.id, version: 7 });
    expect(deps.grants.covers).toHaveBeenCalledWith(team.id, [42, 43]);
    expect(result?.targets.get("run-2")).toEqual({ error });
  });

  it("denies admission when grants no longer cover a target", async () => {
    const { deps, service } = admissionHarness();
    deps.grants.covers.mockResolvedValue(false);

    expect(await service.resolveTeamTargets(automation, team, [run()])).toBeNull();
    expect(deps.resolveTarget).toHaveBeenCalledWith(automation, run());
    expect(deps.grants.covers).toHaveBeenCalledWith(team.id, [42]);
  });

  it("resolves and validates fresh provider routing for each admission", async () => {
    const { deps, service } = admissionHarness();
    expect(await service.resolveProviderAuth(automation)).toEqual({
      providerAuth: [
        { provider: "openai", authMode: "api_key", selectionSource: "unattended_policy" },
      ],
    });
    deps.resolveProviderAuth.mockResolvedValue([
      {
        provider: "openai",
        authMode: "provider_account",
        providerAccountId: "account-2",
        selectionSource: "automation_pin",
      },
    ]);

    expect(await service.resolveProviderAuth(automation)).toEqual({
      providerAuth: [
        {
          provider: "openai",
          authMode: "provider_account",
          providerAccountId: "account-2",
          selectionSource: "automation_pin",
        },
      ],
    });
    expect(deps.resolveProviderAuth).toHaveBeenCalledTimes(2);
    expect(deps.validateHarness).toHaveBeenNthCalledWith(
      1,
      { harness: "codex", model: automation.model, reasoningEffort: null },
      { openai: "api_key" }
    );
    expect(deps.validateHarness).toHaveBeenNthCalledWith(
      2,
      { harness: "codex", model: automation.model, reasoningEffort: null },
      { openai: "provider_account" }
    );
  });

  it("validates the resolved provider routing and retains the original configuration error", async () => {
    const { deps, service } = admissionHarness();
    const error = new HarnessAdmissionError("account incompatible");
    deps.validateHarness.mockRejectedValue(error);

    expect(await service.resolveProviderAuth(automation)).toEqual({ error });
    expect(deps.resolveProviderAuth).toHaveBeenCalledWith(automation.id, "codex");
    expect(deps.validateHarness).toHaveBeenCalledWith(
      { harness: "codex", model: automation.model, reasoningEffort: null },
      { openai: "api_key" }
    );
  });

  it("retains a provider resolution error without attempting harness validation", async () => {
    const { deps, service } = admissionHarness();
    const error = new Error("provider unavailable");
    deps.resolveProviderAuth.mockRejectedValue(error);

    expect(await service.resolveProviderAuth(automation)).toEqual({ error });
    expect(deps.validateHarness).not.toHaveBeenCalled();
  });
});
