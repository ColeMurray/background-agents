import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAutomationEvent, TriggerConfig } from "@open-inspect/shared/triggers";
import * as automationRepositories from "../../src/automation/repository";
import * as automationSessionTargets from "../../src/automation/session-target";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { AutomationStore, type AutomationRepositoryInsert } from "../../src/db/automation-store";
import { GitHubAutomationStore } from "../../src/db/github-automation-store";
import { SessionIndexStore } from "../../src/db/session-index";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import { Scheduler } from "../../src/scheduler/scheduler";
import * as sessionInitialization from "../../src/session/initialize";
import { cleanD1Tables } from "./cleanup";
import { queryDO, seedActiveUser, sqlDatabase } from "./helpers";
import { ownershipRequest, seedGrant, seedTeam } from "./ownership-test-helpers";
import { fetchRuns, makeRunRow, seedRun } from "./run-helpers";

const EXECUTOR_A = "11111111111111111111111111111111";
const EXECUTOR_B = "22222222222222222222222222222222";
const EXECUTOR_C = "33333333333333333333333333333333";
const WORKSPACE_EXECUTOR = "44444444444444444444444444444444";
const TEAM_A = "team_github_automation_a";
const TEAM_B = "team_github_automation_b";
const TEAM_C = "team_github_automation_c";
const INSTRUCTIONS = "Review the pull request.";
const CURRENT_REPOSITORY = {
  repo_owner: "current-owner",
  repo_name: "current-repository",
  repo_id: 101,
  base_branch: "main",
};
const STORED_REPOSITORY = {
  ...CURRENT_REPOSITORY,
  repo_owner: "old-owner",
  repo_name: "old-repository",
};

function githubEvent(): GitHubAutomationEvent {
  return {
    source: "github",
    repositoryId: CURRENT_REPOSITORY.repo_id,
    repoOwner: CURRENT_REPOSITORY.repo_owner,
    repoName: CURRENT_REPOSITORY.repo_name,
    eventType: "pull_request.opened",
    triggerKey: "github:101:pr:7:opened:delivery-1",
    concurrencyKey: "github:101:pr:7",
    contextBlock: "GitHub pull request #7 opened in current-owner/current-repository.",
    meta: {},
    branch: "feature/routing",
    targetBranch: "main",
    pullRequest: { number: 7, state: "open", draft: false },
  };
}

async function saveAutomation(
  id: string,
  ownerTeamId: string | null,
  executor: string,
  options: {
    repository?: AutomationRepositoryInsert;
    enabled?: number;
    eventType?: string;
    conditions?: TriggerConfig["conditions"];
  } = {}
) {
  const store = new AutomationStore(env.DB);
  await sqlDatabase(env.DB).batch([
    env.DB.prepare(
      `INSERT INTO automations
         (id, owner_team_id, name, instructions, trigger_type, event_type, trigger_config,
          model, enabled, consecutive_failures, created_by, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'github_event', ?, ?, 'anthropic/claude-sonnet-4-6', ?, 2, ?, ?, 1, 1)`
    ).bind(
      id,
      ownerTeamId,
      id,
      INSTRUCTIONS,
      options.eventType ?? "pull_request.opened",
      JSON.stringify({
        conditions: options.conditions ?? [
          { type: "target_branch", operator: "exact", value: ["main"] },
        ],
      }),
      options.enabled ?? 1,
      executor,
      executor
    ),
    ...store.bindRepositoryInserts(id, [options.repository ?? STORED_REPOSITORY], 1),
  ]);
}

function createScheduler() {
  return new Scheduler(sqlDatabase(env.DB), createCloudflareEnv(env), { submit() {} });
}

async function revokeGrant(teamId: string) {
  await seedGrant(teamId, STORED_REPOSITORY);
  await env.DB.prepare("DELETE FROM team_repository_grants WHERE team_id = ?").bind(teamId).run();
}

async function expectNoSession(automationId: string) {
  const sessions = await env.DB.prepare("SELECT id FROM sessions WHERE automation_id = ?")
    .bind(automationId)
    .all();
  expect(sessions.results).toEqual([]);
}

async function expectNoRecords(automationId: string) {
  expect(await fetchRuns(automationId)).toEqual([]);
  expect(
    (await new AutomationStore(env.DB).listInvocations(automationId, { limit: 10, offset: 0 }))
      .invocations
  ).toEqual([]);
  await expectNoSession(automationId);
}

async function expectLaunchedSession(
  automationId: string,
  ownerTeamId: string | null,
  executor: string,
  event: GitHubAutomationEvent
) {
  const runs = await fetchRuns(automationId);
  expect(runs).toEqual([
    expect.objectContaining({
      status: "running",
      session_id: expect.any(String),
      repo_owner: event.repoOwner,
      repo_name: event.repoName,
      repo_id: event.repositoryId,
      base_branch: STORED_REPOSITORY.base_branch,
    }),
  ]);
  const run = runs[0];
  const store = new AutomationStore(env.DB);
  const { invocations } = await store.listInvocations(automationId, { limit: 10, offset: 0 });
  expect(invocations.filter((invocation) => invocation.runs.length > 0)).toEqual([
    expect.objectContaining({
      id: run.invocation_id,
      source: "event",
      status: "running",
      runs: [expect.objectContaining({ id: run.id, sessionId: run.session_id })],
    }),
  ]);
  expect(await store.getInvocationById(run.invocation_id)).toMatchObject({
    trigger_key: event.triggerKey,
    concurrency_key: event.concurrencyKey,
  });
  expect(await new SessionIndexStore(env.DB).get(run.session_id!)).toMatchObject({
    ownerTeamId,
    visibility: ownerTeamId === null ? "workspace" : "team",
    userId: executor,
    spawnSource: "automation",
    automationId,
    automationRunId: run.id,
    repoOwner: event.repoOwner,
    repoName: event.repoName,
    baseBranch: STORED_REPOSITORY.base_branch,
  });
  const repositorySnapshot = {
    repo_owner: event.repoOwner,
    repo_name: event.repoName,
    repo_id: event.repositoryId,
    base_branch: STORED_REPOSITORY.base_branch,
  };
  const repositories = await env.DB.prepare(
    "SELECT repo_owner, repo_name, repo_id, base_branch FROM session_repositories WHERE session_id = ? ORDER BY position"
  )
    .bind(run.session_id)
    .all();
  expect(repositories.results).toEqual([repositorySnapshot]);
  const stub = env.SESSION.get(env.SESSION.idFromName(run.session_id!));
  expect(
    await queryDO(stub, "SELECT repo_owner, repo_name, repo_id, base_branch FROM session")
  ).toEqual([repositorySnapshot]);
  expect(
    await queryDO(
      stub,
      "SELECT repo_owner, repo_name, repo_id, base_branch FROM session_repositories ORDER BY position"
    )
  ).toEqual([repositorySnapshot]);
  expect(
    await queryDO(
      stub,
      "SELECT m.content, m.source, p.canonical_user_id FROM messages m JOIN participants p ON p.id = m.author_id"
    )
  ).toEqual([
    {
      content: expect.stringContaining(event.contextBlock),
      source: "automation",
      canonical_user_id: executor,
    },
  ]);
}

async function expectUnauthorizedRun(automationId: string, event: GitHubAutomationEvent) {
  const runs = (await fetchRuns(automationId)).filter((run) => run.status === "unauthorized");
  expect(runs).toEqual([
    expect.objectContaining({
      status: "unauthorized",
      failure_reason: "repo_not_granted",
      session_id: null,
      started_at: null,
      execution_deadline_at: null,
      completed_at: expect.any(Number),
      repo_id: event.repositoryId,
    }),
  ]);
  const run = runs[0];
  const store = new AutomationStore(env.DB);
  const { invocations } = await store.listInvocations(automationId, { limit: 10, offset: 0 });
  expect(invocations.filter((invocation) => invocation.source === "event")).toEqual([
    expect.objectContaining({
      id: run.invocation_id,
      status: "unauthorized",
      skipReason: null,
      completedAt: run.completed_at,
      runs: [
        expect.objectContaining({
          id: run.id,
          status: "unauthorized",
          failureReason: "repo_not_granted",
          sessionId: null,
        }),
      ],
    }),
  ]);
  expect(await store.getInvocationById(run.invocation_id)).toMatchObject({
    trigger_key: event.triggerKey,
    concurrency_key: event.concurrencyKey,
    skip_reason: null,
    failure_counted_at: null,
  });
  expect(await store.getInvocationRunAggregate(run.invocation_id)).toMatchObject({
    active: 0,
    failed: 0,
  });
  expect(await store.getById(automationId)).toMatchObject({ enabled: 1, consecutive_failures: 2 });
  await expectNoSession(automationId);
}

describe("GitHub automation routing (real D1 and SessionDO)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const executor of [EXECUTOR_A, EXECUTOR_B, EXECUTOR_C, WORKSPACE_EXECUTOR]) {
      await seedActiveUser(executor);
    }
    await seedTeam(TEAM_A, [[EXECUTOR_A, "member"]]);
    await seedTeam(TEAM_B, [[EXECUTOR_B, "member"]]);
    await seedTeam(TEAM_C, [[EXECUTOR_C, "member"]]);
    vi.spyOn(automationRepositories, "resolveAutomationRepositories").mockImplementation(
      async (_env, repositories) =>
        repositories.map((requested) => ({
          requested,
          error: null,
          repository: {
            repoOwner: CURRENT_REPOSITORY.repo_owner,
            repoName: CURRENT_REPOSITORY.repo_name,
            repoId: CURRENT_REPOSITORY.repo_id,
            baseBranch: requested.base_branch ?? "main",
          },
        }))
    );
    // Direct targets only read the run snapshot; these spies keep initialization real.
    vi.spyOn(automationSessionTargets, "resolveAutomationSessionTarget");
    vi.spyOn(sessionInitialization, "initializeSession");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it.each(["repository", "installation", "mixed", "none", "workspace"] as const)(
    "returns one candidate for duplicate repository IDs with %s grants",
    async (grantKind) => {
      const id = "auto-github-duplicate-repository";
      const workspace = grantKind === "workspace";
      await saveAutomation(
        id,
        workspace ? null : TEAM_A,
        workspace ? WORKSPACE_EXECUTOR : EXECUTOR_A
      );
      const store = new AutomationStore(env.DB);
      await store.replaceRepositories(id, [STORED_REPOSITORY, CURRENT_REPOSITORY]);
      await seedGrant(TEAM_A, { ...STORED_REPOSITORY, repo_id: 909 });
      if (grantKind === "repository" || grantKind === "mixed") {
        await seedGrant(TEAM_A, STORED_REPOSITORY);
      }
      if (grantKind === "installation" || grantKind === "mixed") {
        // Raw seeding also exercises mixed rows that the grant write path refuses.
        await seedGrant(TEAM_A, "installation");
      }

      expect(
        await new GitHubAutomationStore(env.DB).getGitHubAutomationsForEvent(
          101,
          "pull_request.opened"
        )
      ).toEqual([
        {
          automation: expect.objectContaining({ id }),
          repositoryGranted: grantKind !== "none",
        },
      ]);
    }
  );

  it("fans out by numeric ID across granted teams and workspace, recording revoked grants once", async () => {
    await seedGrant(TEAM_A, STORED_REPOSITORY);
    await seedGrant(TEAM_B, "installation");
    await revokeGrant(TEAM_C);
    await saveAutomation("auto-github-a", TEAM_A, EXECUTOR_A);
    await saveAutomation("auto-github-b", TEAM_B, EXECUTOR_B);
    await saveAutomation("auto-github-c", TEAM_C, EXECUTOR_C);
    await saveAutomation("auto-github-workspace", null, WORKSPACE_EXECUTOR);
    const store = new AutomationStore(env.DB);
    const selections = await store.getRepositoriesForAutomationIds([
      "auto-github-a",
      "auto-github-b",
      "auto-github-c",
      "auto-github-workspace",
    ]);
    const event = githubEvent();
    const scheduler = createScheduler();

    expect(await scheduler.event(event)).toEqual({
      triggered: 3,
      skipped: 1,
      steered: 0,
      invocationIds: [expect.any(String), expect.any(String), expect.any(String)],
    });
    expect(automationRepositories.resolveAutomationRepositories).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(automationSessionTargets.resolveAutomationSessionTarget)
        .mock.calls.map(([, run]) => run.automation_id)
        .sort()
    ).toEqual(["auto-github-a", "auto-github-b", "auto-github-workspace"]);
    expect(
      vi
        .mocked(sessionInitialization.initializeSession)
        .mock.calls.map(([, input]) => input.automationId)
        .sort()
    ).toEqual(["auto-github-a", "auto-github-b", "auto-github-workspace"]);

    expect(await scheduler.event(event)).toEqual({
      triggered: 0,
      skipped: 4,
      steered: 0,
      invocationIds: [expect.any(String), expect.any(String), expect.any(String)],
    });
    expect(sessionInitialization.initializeSession).toHaveBeenCalledTimes(3);
    await expectLaunchedSession("auto-github-a", TEAM_A, EXECUTOR_A, event);
    await expectLaunchedSession("auto-github-b", TEAM_B, EXECUTOR_B, event);
    await expectLaunchedSession("auto-github-workspace", null, WORKSPACE_EXECUTOR, event);
    await expectUnauthorizedRun("auto-github-c", event);
    expect(await fetchRuns("auto-github-c")).toHaveLength(1);
    expect(await store.getRepositoriesForAutomationIds([...selections.keys()])).toEqual(selections);
  });

  it("records a terminal revoked-grant denial without SCM resolution or session initialization", async () => {
    await saveAutomation("auto-github-revoked", TEAM_C, EXECUTOR_C);
    await revokeGrant(TEAM_C);
    const event = githubEvent();
    const scheduler = createScheduler();

    for (let delivery = 0; delivery < 2; delivery++) {
      expect(await scheduler.event(event)).toEqual({
        triggered: 0,
        skipped: 1,
        steered: 0,
        invocationIds: [],
      });
    }
    await expectUnauthorizedRun("auto-github-revoked", event);
    expect(await fetchRuns("auto-github-revoked")).toHaveLength(1);
    expect(automationRepositories.resolveAutomationRepositories).not.toHaveBeenCalled();
    expect(automationSessionTargets.resolveAutomationSessionTarget).not.toHaveBeenCalled();
    expect(sessionInitialization.initializeSession).not.toHaveBeenCalled();
  });

  it("records a grant revoked after candidate selection without creating a session", async () => {
    const id = "auto-github-raced-revocation";
    await saveAutomation(id, TEAM_A, EXECUTOR_A);
    await seedGrant(TEAM_A, STORED_REPOSITORY);
    const getCandidates = GitHubAutomationStore.prototype.getGitHubAutomationsForEvent;
    vi.spyOn(
      GitHubAutomationStore.prototype,
      "getGitHubAutomationsForEvent"
    ).mockImplementationOnce(async function (this: GitHubAutomationStore, repositoryId, eventType) {
      const candidates = await getCandidates.call(this, repositoryId, eventType);
      await env.DB.prepare("DELETE FROM team_repository_grants WHERE team_id = ?")
        .bind(TEAM_A)
        .run();
      return candidates;
    });
    const event = githubEvent();
    expect(await createScheduler().event(event)).toEqual({
      triggered: 0,
      skipped: 1,
      steered: 0,
      invocationIds: [],
    });
    await expectUnauthorizedRun(id, event);
    expect(sessionInitialization.initializeSession).not.toHaveBeenCalled();
  });

  it.each(["after candidate lookup", "before denial persistence"] as const)(
    "launches when the missing grant is added %s rather than consuming a denied trigger key",
    async (window) => {
      const id = "auto-github-added-grant";
      await saveAutomation(id, TEAM_A, EXECUTOR_A);
      const addGrant = () =>
        new TeamRepositoryGrantStore(env.DB).add(TEAM_A, {
          kind: "repository",
          repoExternalId: CURRENT_REPOSITORY.repo_id,
          owner: STORED_REPOSITORY.repo_owner,
          name: STORED_REPOSITORY.repo_name,
        });
      if (window === "after candidate lookup") {
        const lookup = GitHubAutomationStore.prototype.getGitHubAutomationsForEvent;
        vi.spyOn(
          GitHubAutomationStore.prototype,
          "getGitHubAutomationsForEvent"
        ).mockImplementationOnce(async function (
          this: GitHubAutomationStore,
          repositoryId,
          eventType
        ) {
          const candidates = await lookup.call(this, repositoryId, eventType);
          expect(candidates[0].repositoryGranted).toBe(false);
          await addGrant();
          return candidates;
        });
      } else {
        const recordDenial = GitHubAutomationStore.prototype.recordGitHubGrantDenied;
        vi.spyOn(GitHubAutomationStore.prototype, "recordGitHubGrantDenied").mockImplementationOnce(
          async function (this: GitHubAutomationStore, automationId, event) {
            await addGrant();
            return recordDenial.call(this, automationId, event);
          }
        );
      }
      const event = githubEvent();
      const scheduler = createScheduler();

      expect(await scheduler.event(event)).toEqual({
        triggered: 1,
        skipped: 0,
        steered: 0,
        invocationIds: [expect.any(String)],
      });
      expect(await scheduler.event(event)).toEqual({
        triggered: 0,
        skipped: 1,
        steered: 0,
        invocationIds: [expect.any(String)],
      });
      await expectLaunchedSession(id, TEAM_A, EXECUTOR_A, event);
      expect(sessionInitialization.initializeSession).toHaveBeenCalledOnce();
    }
  );

  it("does not launch when SCM resolution returns a different repository ID", async () => {
    const id = "auto-github-replaced-name";
    await saveAutomation(id, TEAM_A, EXECUTOR_A);
    await seedGrant(TEAM_A, "installation");
    vi.mocked(automationRepositories.resolveAutomationRepositories).mockImplementationOnce(
      async (_env, repositories) =>
        repositories.map((requested) => ({
          requested,
          error: null,
          repository: {
            repoOwner: CURRENT_REPOSITORY.repo_owner,
            repoName: CURRENT_REPOSITORY.repo_name,
            repoId: 909,
            baseBranch: "main",
          },
        }))
    );
    expect(await createScheduler().event(githubEvent())).toEqual({
      triggered: 0,
      skipped: 0,
      steered: 0,
      invocationIds: [expect.any(String)],
    });
    expect(await fetchRuns(id)).toEqual([
      expect.objectContaining({
        status: "failed",
        session_id: null,
        repo_id: 101,
        failure_reason: "Repository identity changed during event resolution",
      }),
    ]);
    expect(sessionInitialization.initializeSession).not.toHaveBeenCalled();
  });

  it("records a grant revoked between coverage and guarded admission", async () => {
    const id = "auto-github-grants-version";
    await saveAutomation(id, TEAM_A, EXECUTOR_A);
    await seedGrant(TEAM_A, STORED_REPOSITORY);
    const insert = AutomationStore.prototype.insertInvocationGuarded;
    vi.spyOn(AutomationStore.prototype, "insertInvocationGuarded").mockImplementationOnce(
      async function (this: AutomationStore, params) {
        const [grant] = await new TeamRepositoryGrantStore(env.DB).listDetailsForTeam(TEAM_A);
        await new TeamRepositoryGrantStore(env.DB).remove(TEAM_A, grant.id);
        return insert.call(this, params);
      }
    );
    const event = githubEvent();
    expect(await createScheduler().event(event)).toEqual({
      triggered: 0,
      skipped: 1,
      steered: 0,
      invocationIds: [],
    });
    await expectUnauthorizedRun(id, event);
    expect(sessionInitialization.initializeSession).not.toHaveBeenCalled();
  });

  it("retries an unrelated grant-version change without losing the authorized event", async () => {
    const id = "auto-github-unrelated-grant";
    await saveAutomation(id, TEAM_A, EXECUTOR_A);
    await seedGrant(TEAM_A, STORED_REPOSITORY);
    const insert = AutomationStore.prototype.insertInvocationGuarded;
    vi.spyOn(AutomationStore.prototype, "insertInvocationGuarded").mockImplementationOnce(
      async function (this: AutomationStore, params) {
        await new TeamRepositoryGrantStore(env.DB).add(TEAM_A, {
          kind: "repository",
          repoExternalId: 909,
          owner: "acme",
          name: "unrelated",
        });
        return insert.call(this, params);
      }
    );
    const event = githubEvent();
    expect(await createScheduler().event(event)).toEqual({
      triggered: 1,
      skipped: 0,
      steered: 0,
      invocationIds: [expect.any(String)],
    });
    await expectLaunchedSession(id, TEAM_A, EXECUTOR_A, event);
    expect(sessionInitialization.initializeSession).toHaveBeenCalledOnce();
  });

  it("rejects repeated version churn without claiming the trigger and allows redelivery", async () => {
    const id = "auto-github-version-churn";
    await saveAutomation(id, TEAM_A, EXECUTOR_A);
    await seedGrant(TEAM_A, STORED_REPOSITORY);
    const stableId = "auto-github-stable-team";
    await saveAutomation(stableId, TEAM_B, EXECUTOR_B);
    await seedGrant(TEAM_B, STORED_REPOSITORY);
    const covers = TeamRepositoryGrantStore.prototype.covers;
    const churn = vi
      .spyOn(TeamRepositoryGrantStore.prototype, "covers")
      .mockImplementation(async function (this: TeamRepositoryGrantStore, teamId, repoIds) {
        const covered = await covers.call(this, teamId, repoIds);
        if (teamId !== TEAM_A) return covered;
        const unrelated = await this.add(teamId, {
          kind: "repository",
          repoExternalId: 909,
          owner: "acme",
          name: "unrelated",
        });
        await this.remove(teamId, unrelated.id);
        return covered;
      });
    const event = githubEvent();
    const scheduler = createScheduler();
    await expect(scheduler.event(event)).rejects.toThrow("GitHub admission did not stabilize");
    await expectNoRecords(id);
    await expectLaunchedSession(stableId, TEAM_B, EXECUTOR_B, event);
    expect(await new AutomationStore(env.DB).getById(id)).toMatchObject({
      enabled: 1,
      consecutive_failures: 2,
    });
    const forwarded = await ownershipRequest("/internal/github-event", {
      service: "github-bot",
      method: "POST",
      body: JSON.stringify(event),
    });
    expect(forwarded.status).toBe(502);
    expect(await forwarded.json()).toEqual({ ok: false, error: "Failed to reach scheduler" });
    churn.mockRestore();
    expect(await scheduler.event(event)).toEqual({
      triggered: 1,
      skipped: 1,
      steered: 0,
      invocationIds: [expect.any(String), expect.any(String)],
    });
    await expectLaunchedSession(id, TEAM_A, EXECUTOR_A, event);
  });

  it("retries when a revoked grant returns before the post-admission denial write", async () => {
    const id = "auto-github-returned-coverage";
    await saveAutomation(id, TEAM_A, EXECUTOR_A);
    await seedGrant(TEAM_A, STORED_REPOSITORY);
    const covers = TeamRepositoryGrantStore.prototype.covers;
    let coverageReads = 0;
    vi.spyOn(TeamRepositoryGrantStore.prototype, "covers").mockImplementation(async function (
      this: TeamRepositoryGrantStore,
      teamId,
      repoIds
    ) {
      const covered = await covers.call(this, teamId, repoIds);
      if (++coverageReads !== 2) return covered;
      expect(covered).toBe(true);
      const [grant] = await this.listDetailsForTeam(teamId);
      await this.remove(teamId, grant.id);
      return false;
    });
    const recordDenial = GitHubAutomationStore.prototype.recordGitHubGrantDenied;
    vi.spyOn(GitHubAutomationStore.prototype, "recordGitHubGrantDenied").mockImplementationOnce(
      async function (this: GitHubAutomationStore, automationId, event) {
        await new TeamRepositoryGrantStore(env.DB).add(TEAM_A, {
          kind: "repository",
          repoExternalId: 101,
          owner: "old-owner",
          name: "old-repository",
        });
        return recordDenial.call(this, automationId, event);
      }
    );
    const event = githubEvent();
    expect(await createScheduler().event(event)).toEqual({
      triggered: 1,
      skipped: 0,
      steered: 0,
      invocationIds: [expect.any(String)],
    });
    await expectLaunchedSession(id, TEAM_A, EXECUTOR_A, event);
    expect(sessionInitialization.initializeSession).toHaveBeenCalledOnce();
  });

  it("records grants revoked after matching before same-key concurrency without changing the active run", async () => {
    const id = "auto-github-active-revoked";
    await saveAutomation(id, TEAM_C, EXECUTOR_C);
    await seedGrant(TEAM_C, STORED_REPOSITORY);
    const lookup = GitHubAutomationStore.prototype.getGitHubAutomationsForEvent;
    vi.spyOn(
      GitHubAutomationStore.prototype,
      "getGitHubAutomationsForEvent"
    ).mockImplementationOnce(async function (this: GitHubAutomationStore, repositoryId, eventType) {
      const candidates = await lookup.call(this, repositoryId, eventType);
      expect(candidates[0].repositoryGranted).toBe(true);
      const grants = new TeamRepositoryGrantStore(env.DB);
      const [grant] = await grants.listDetailsForTeam(TEAM_C);
      await grants.remove(TEAM_C, grant.id);
      return candidates;
    });
    const event = githubEvent();
    const activeRun = makeRunRow(id, {
      id: "run-github-active-revoked",
      invocation_id: "inv-github-active-revoked",
      scheduled_at: 1,
      created_at: 1,
      repo_owner: STORED_REPOSITORY.repo_owner,
      repo_name: STORED_REPOSITORY.repo_name,
      repo_id: STORED_REPOSITORY.repo_id,
      base_branch: STORED_REPOSITORY.base_branch,
    });
    await seedRun(activeRun, { concurrencyKey: event.concurrencyKey });
    const scheduler = createScheduler();

    for (let delivery = 0; delivery < 2; delivery++) {
      expect(await scheduler.event(event)).toEqual({
        triggered: 0,
        skipped: 1,
        steered: 0,
        invocationIds: [],
      });
    }
    await expectUnauthorizedRun(id, event);
    const runs = await fetchRuns(id);
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.id === activeRun.id)).toEqual(activeRun);
    const store = new AutomationStore(env.DB);
    expect(await store.getActiveRunForKey(id, event.concurrencyKey)).toEqual(activeRun);
    expect((await store.listInvocations(id, { limit: 10, offset: 0 })).total).toBe(2);
    expect(automationRepositories.resolveAutomationRepositories).not.toHaveBeenCalled();
    expect(automationSessionTargets.resolveAutomationSessionTarget).not.toHaveBeenCalled();
    expect(sessionInitialization.initializeSession).not.toHaveBeenCalled();
  });

  it("creates no records for disabled, wrong-event, or condition-mismatched automations", async () => {
    await revokeGrant(TEAM_C);
    await saveAutomation("auto-github-disabled", TEAM_C, EXECUTOR_C, { enabled: 0 });
    await saveAutomation("auto-github-wrong-event", TEAM_C, EXECUTOR_C, {
      eventType: "pull_request.closed",
    });
    await saveAutomation("auto-github-nonmatching", TEAM_C, EXECUTOR_C, {
      conditions: [{ type: "target_branch", operator: "exact", value: ["release"] }],
    });

    expect(await createScheduler().event(githubEvent())).toEqual({
      triggered: 0,
      skipped: 0,
      steered: 0,
      invocationIds: [],
    });
    for (const id of [
      "auto-github-disabled",
      "auto-github-wrong-event",
      "auto-github-nonmatching",
    ]) {
      await expectNoRecords(id);
    }
    expect(automationRepositories.resolveAutomationRepositories).not.toHaveBeenCalled();
    expect(automationSessionTargets.resolveAutomationSessionTarget).not.toHaveBeenCalled();
    expect(sessionInitialization.initializeSession).not.toHaveBeenCalled();
  });

  it.each([
    { label: "a different numeric ID", repoId: 909 },
    { label: "a null historical ID", repoId: null },
  ])("does not fall back to matching names for $label", async ({ repoId }) => {
    await seedGrant(TEAM_A, CURRENT_REPOSITORY);
    const repository = { ...CURRENT_REPOSITORY, repo_id: repoId };
    await saveAutomation("auto-github-wrong-id-team", TEAM_A, EXECUTOR_A, { repository });
    await saveAutomation("auto-github-wrong-id-workspace", null, WORKSPACE_EXECUTOR, {
      repository,
    });

    expect(await createScheduler().event(githubEvent())).toEqual({
      triggered: 0,
      skipped: 0,
      steered: 0,
      invocationIds: [],
    });
    await expectNoRecords("auto-github-wrong-id-team");
    await expectNoRecords("auto-github-wrong-id-workspace");
    expect(automationRepositories.resolveAutomationRepositories).not.toHaveBeenCalled();
    expect(automationSessionTargets.resolveAutomationSessionTarget).not.toHaveBeenCalled();
    expect(sessionInitialization.initializeSession).not.toHaveBeenCalled();
  });

  it("launches a renamed workspace repository using current payload names with no grants", async () => {
    const id = "auto-github-workspace-no-grants";
    await saveAutomation(id, null, WORKSPACE_EXECUTOR);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM team_repository_grants").first()
    ).toEqual({ count: 0 });
    const event = githubEvent();

    expect(await createScheduler().event(event)).toEqual({
      triggered: 1,
      skipped: 0,
      steered: 0,
      invocationIds: [expect.any(String)],
    });
    await expectLaunchedSession(id, null, WORKSPACE_EXECUTOR, event);
    expect(automationRepositories.resolveAutomationRepositories).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining(CURRENT_REPOSITORY)]
    );
    expect(sessionInitialization.initializeSession).toHaveBeenCalledOnce();
    expect(await new AutomationStore(env.DB).getRepositoriesForAutomation(id)).toEqual([
      expect.objectContaining(STORED_REPOSITORY),
    ]);
  });

  it.each(["departed executor", "archived team"] as const)(
    "does not launch for a currently invalid membership: %s",
    async (scenario) => {
      const id = "auto-github-invalid-membership";
      await saveAutomation(id, TEAM_A, EXECUTOR_A);
      await seedGrant(TEAM_A, STORED_REPOSITORY);
      await new TeamMembershipStore(env.DB).add(TEAM_B, EXECUTOR_A, "member");
      if (scenario === "departed executor") {
        await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
          .bind(TEAM_A, EXECUTOR_A)
          .run();
      } else {
        await env.DB.prepare("UPDATE teams SET archived_at = 2 WHERE id = ?").bind(TEAM_A).run();
      }

      expect(await createScheduler().event(githubEvent())).toMatchObject({
        triggered: 0,
        steered: 0,
      });
      await expectNoSession(id);
      expect((await fetchRuns(id)).every((run) => run.session_id === null)).toBe(true);
      expect(automationRepositories.resolveAutomationRepositories).not.toHaveBeenCalled();
      expect(automationSessionTargets.resolveAutomationSessionTarget).not.toHaveBeenCalled();
      expect(sessionInitialization.initializeSession).not.toHaveBeenCalled();
      expect(await new AutomationStore(env.DB).getById(id)).toMatchObject({
        consecutive_failures: 2,
      });
    }
  );
});
