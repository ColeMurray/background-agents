import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationInvocationSource } from "@open-inspect/shared/types/automations";
import * as automationRepositories from "../../src/automation/repository";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import {
  AutomationStore,
  type AutomationRepositoryInsert,
  type AutomationRow,
} from "../../src/db/automation-store";
import { EnvironmentStore, type EnvironmentRepositoryInsert } from "../../src/db/environments";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import * as repositoryResolution from "../../src/repos/resolve";
import { AutomationExecutionUnauthorizedError, Scheduler } from "../../src/scheduler/scheduler";
import * as sessionInitialization from "../../src/session/initialize";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, sqlDatabase } from "./helpers";

const EXECUTOR = "11111111111111111111111111111111";
const REQUESTER = "22222222222222222222222222222222";
const TEAM = "team_automation_grants";
const OTHER_TEAM = "team_automation_grants_other";
const ENVIRONMENT = "env_55555555555555555555555555555555";
const SOURCES = ["manual", "schedule", "event"] as const;
const INITIALIZATION_PROBE_ERROR = "Test stopped before session index or DO initialization";
const WEB: EnvironmentRepositoryInsert = {
  position: 0,
  repo_owner: "acme/group",
  repo_name: "web",
  repo_id: 101,
  base_branch: "main",
};
const API: EnvironmentRepositoryInsert = {
  ...WEB,
  position: 1,
  repo_name: "api",
  repo_id: 202,
  base_branch: "develop",
};
const insertInvocationGuarded = AutomationStore.prototype.insertInvocationGuarded;

function scheduler(): Scheduler {
  return new Scheduler(sqlDatabase(env.DB), createCloudflareEnv(env), { submit() {} });
}

async function saveAutomation(
  source: AutomationInvocationSource,
  {
    ownerTeamId = TEAM,
    repositories = [WEB],
    environmentIds = [],
  }: {
    ownerTeamId?: string | null;
    repositories?: AutomationRepositoryInsert[];
    environmentIds?: string[];
  } = {}
): Promise<AutomationRow> {
  const now = Date.now();
  const row: AutomationRow = {
    id: `auto-team-grants-${source}`,
    owner_team_id: ownerTeamId,
    name: "Current team grants",
    instructions: "Run tests",
    trigger_type: source === "event" ? "webhook" : "schedule",
    schedule_cron: source === "event" ? null : "0 9 * * *",
    schedule_tz: "UTC",
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: source === "schedule" ? now - 60_000 : null,
    consecutive_failures: 2,
    created_by: EXECUTOR,
    user_id: EXECUTOR,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
  };
  const store = new AutomationStore(env.DB);
  await store.create(row);
  await sqlDatabase(env.DB).batch([
    ...store.bindRepositoryInserts(row.id, repositories, now),
    ...store.bindEnvironmentInserts(row.id, environmentIds, now),
  ]);
  return row;
}

async function saveEnvironment(repositories = [WEB, API], ownerTeamId: string | null = TEAM) {
  await new EnvironmentStore(env.DB).create(
    {
      id: ENVIRONMENT,
      owner_team_id: ownerTeamId,
      name: "Full workspace",
      description: null,
      prebuild_enabled: 0,
      channel_associations: null,
      created_at: 1,
      updated_at: 1,
    },
    repositories
  );
}

async function grantRepository(repository = WEB, teamId = TEAM) {
  await env.DB.prepare(
    `INSERT INTO team_repository_grants
       (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at)
     VALUES (?, ?, 'repository', ?, ?, ?, 1)`
  )
    .bind(
      `grant-${teamId}-${repository.repo_id}`,
      teamId,
      repository.repo_id,
      repository.repo_owner,
      repository.repo_name
    )
    .run();
}

async function grantInstallation(teamId = TEAM) {
  await env.DB.prepare(
    `INSERT INTO team_repository_grants (id, team_id, grant_kind, created_at)
     VALUES (?, ?, 'installation', 1)`
  )
    .bind(`grant-${teamId}-installation`, teamId)
    .run();
}

function fire(source: AutomationInvocationSource, row: AutomationRow) {
  const execution = scheduler();
  if (source === "manual") return execution.trigger(row.id, REQUESTER);
  if (source === "schedule") return execution.tick();
  return execution.event({
    source: "webhook",
    automationId: row.id,
    eventType: "webhook.received",
    triggerKey: `webhook:${row.id}:delivery-1`,
    concurrencyKey: `webhook:${row.id}`,
    contextBlock: "Webhook received",
    meta: {},
    body: {},
  });
}

async function expectDenied(source: AutomationInvocationSource, row: AutomationRow) {
  const firing = fire(source, row);
  if (source === "manual") {
    await expect(firing).rejects.toBeInstanceOf(AutomationExecutionUnauthorizedError);
    await expect(firing).rejects.toMatchObject({ reason: "target_team_missing_grant" });
  } else if (source === "schedule") {
    await expect(firing).resolves.toEqual({ processed: 0, skipped: 1, failed: 0 });
  } else {
    await expect(firing).resolves.toEqual({ triggered: 0, skipped: 1, steered: 0 });
  }

  expect(sessionInitialization.initializeSession).not.toHaveBeenCalled();
  expect(AutomationStore.prototype.insertInvocationGuarded).not.toHaveBeenCalled();
  const runs = await env.DB.prepare("SELECT id FROM automation_runs WHERE automation_id = ?")
    .bind(row.id)
    .all();
  expect(runs.results).toEqual([]);
  const sessions = await env.DB.prepare("SELECT id FROM sessions WHERE automation_id = ?")
    .bind(row.id)
    .all();
  expect(sessions.results).toEqual([]);
  const invocations = await env.DB.prepare(
    `SELECT source, scheduled_at, skip_reason, failure_counted_at
     FROM automation_invocations WHERE automation_id = ?`
  )
    .bind(row.id)
    .all();
  expect(invocations.results).toEqual(
    source === "schedule"
      ? [
          {
            source: "schedule",
            scheduled_at: row.next_run_at,
            skip_reason: "target_team_missing_grant",
            failure_counted_at: null,
          },
        ]
      : []
  );
  expect(await new AutomationStore(env.DB).getById(row.id)).toMatchObject({
    enabled: source === "schedule" ? 0 : 1,
    next_run_at: null,
    consecutive_failures: row.consecutive_failures,
  });
}

async function expectAdmitted(
  source: AutomationInvocationSource,
  row: AutomationRow,
  children: number
) {
  // Stop at initialization even for permitted launches: no external calls or DO warming.
  const firing = fire(source, row);
  if (source === "manual") {
    await expect(firing).rejects.toThrow("Failed to trigger automation");
  } else if (source === "schedule") {
    await expect(firing).resolves.toEqual({ processed: 0, skipped: 0, failed: 1 });
  } else {
    await expect(firing).resolves.toEqual({ triggered: 0, skipped: 0, steered: 0 });
  }
  expect(sessionInitialization.initializeSession).toHaveBeenCalledTimes(children);
  expect(AutomationStore.prototype.insertInvocationGuarded).toHaveBeenCalledTimes(1);
  const invocations = await env.DB.prepare(
    "SELECT source, skip_reason FROM automation_invocations WHERE automation_id = ?"
  )
    .bind(row.id)
    .all();
  expect(invocations.results).toEqual([{ source, skip_reason: null }]);
  const runs = await env.DB.prepare(
    "SELECT status, failure_reason FROM automation_runs WHERE automation_id = ?"
  )
    .bind(row.id)
    .all();
  expect(runs.results).toEqual(
    Array.from({ length: children }, () => ({
      status: "failed",
      failure_reason: INITIALIZATION_PROBE_ERROR,
    }))
  );
  const sessions = await env.DB.prepare("SELECT id FROM sessions WHERE automation_id = ?")
    .bind(row.id)
    .all();
  expect(sessions.results).toEqual([]);
}

describe("automation current team repository grants (integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [EXECUTOR, REQUESTER]) await seedActiveUser(userId);
    await env.DB.batch([
      ...[TEAM, OTHER_TEAM].map((teamId) =>
        env.DB.prepare(
          "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)"
        ).bind(teamId, teamId, teamId)
      ),
      ...[TEAM, OTHER_TEAM].flatMap((teamId) =>
        [EXECUTOR, REQUESTER].map((userId) =>
          env.DB.prepare(
            "INSERT INTO team_memberships (team_id, user_id, role, created_at) VALUES (?, ?, 'member', 1)"
          ).bind(teamId, userId)
        )
      ),
    ]);
    vi.spyOn(automationRepositories, "resolveAutomationRepositories").mockImplementation(
      async (_env, repositories) =>
        repositories.map((requested) => ({
          requested,
          repository: {
            repoOwner: requested.repo_owner,
            repoName: requested.repo_name,
            repoId: requested.repo_name === "web" ? 101 : 202,
            baseBranch: requested.base_branch ?? "main",
          },
          error: null,
        }))
    );
    vi.spyOn(repositoryResolution, "resolveSessionRepositories").mockImplementation(
      async (_env, repositories) =>
        repositories.map((repository) => ({
          repoOwner: repository.repoOwner,
          repoName: repository.repoName,
          repoId: repository.repoName === "web" ? 101 : repository.repoName === "api" ? 202 : 303,
          baseBranch: repository.baseBranch ?? "main",
        }))
    );
    vi.spyOn(TeamRepositoryGrantStore.prototype, "covers");
    vi.spyOn(AutomationStore.prototype, "insertInvocationGuarded");
    vi.spyOn(sessionInitialization, "initializeSession").mockRejectedValue(
      new Error(INITIALIZATION_PROBE_ERROR)
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it.each(SOURCES)("denies revoked direct repository grants on %s firing", async (source) => {
    await grantRepository();
    const row = await saveAutomation(source);
    await expect(new TeamRepositoryGrantStore(env.DB).covers(TEAM, [101])).resolves.toBe(true);
    await env.DB.prepare("DELETE FROM team_repository_grants WHERE team_id = ?").bind(TEAM).run();

    await expectDenied(source, row);
    expect(automationRepositories.resolveAutomationRepositories).toHaveBeenCalledTimes(1);
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenLastCalledWith(TEAM, [101]);
  });

  it.each(
    SOURCES.flatMap((source) =>
      ["missing", "revoked"].map((grantState) => ({ source, grantState }))
    )
  )("denies $source with a $grantState secondary member grant", async ({ source, grantState }) => {
    await grantRepository();
    if (grantState === "revoked") await grantRepository(API);
    await saveEnvironment();
    const row = await saveAutomation(source, { repositories: [], environmentIds: [ENVIRONMENT] });
    if (grantState === "revoked") {
      await expect(new TeamRepositoryGrantStore(env.DB).covers(TEAM, [101, 202])).resolves.toBe(
        true
      );
      await env.DB.prepare(
        "DELETE FROM team_repository_grants WHERE team_id = ? AND repo_external_id = ?"
      )
        .bind(TEAM, API.repo_id)
        .run();
    }

    await expectDenied(source, row);
    expect(repositoryResolution.resolveSessionRepositories).toHaveBeenCalledTimes(1);
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenLastCalledWith(TEAM, [101, 202]);
  });

  it.each(SOURCES)("admits numeric IDs under an installation grant (%s)", async (source) => {
    await grantInstallation();
    const row = await saveAutomation(source, { repositories: [WEB, API] });

    await expectAdmitted(source, row, 2);
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenCalledWith(
      TEAM,
      expect.arrayContaining([101, 202])
    );
    expect(
      vi.mocked(sessionInitialization.initializeSession).mock.calls.map(([, input]) => input.repoId)
    ).toEqual(expect.arrayContaining([101, 202]));
  });

  it.each(SOURCES)("denies revoked installation grants on %s firing", async (source) => {
    await grantInstallation();
    const row = await saveAutomation(source, { repositories: [WEB, API] });
    await expect(new TeamRepositoryGrantStore(env.DB).covers(TEAM, [101, 202])).resolves.toBe(true);
    await env.DB.prepare("DELETE FROM team_repository_grants WHERE team_id = ?").bind(TEAM).run();

    await expectDenied(source, row);
  });

  it.each(SOURCES)("cannot use another team's installation grant (%s)", async (source) => {
    await grantInstallation(OTHER_TEAM);
    const row = await saveAutomation(source);

    await expectDenied(source, row);
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenCalledWith(TEAM, [101]);
  });

  it.each(SOURCES)(
    "checks the SCM-resolved direct ID, not the saved grant (%s)",
    async (source) => {
      await grantRepository();
      const row = await saveAutomation(source);
      vi.mocked(automationRepositories.resolveAutomationRepositories).mockImplementationOnce(
        async (_env, repositories) =>
          repositories.map((requested) => ({
            requested,
            repository: {
              repoOwner: requested.repo_owner,
              repoName: requested.repo_name,
              repoId: 909,
              baseBranch: requested.base_branch ?? "main",
            },
            error: null,
          }))
      );

      await expectDenied(source, row);
      expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenCalledWith(TEAM, [909]);
      const savedRepositories = await new AutomationStore(env.DB).getRepositoriesForAutomation(
        row.id
      );
      expect(savedRepositories[0].repo_id).toBe(101);
    }
  );

  it.each(SOURCES)(
    "checks secondary members' resolved IDs, not saved grants (%s)",
    async (source) => {
      await grantRepository();
      await grantRepository(API);
      await saveEnvironment();
      const row = await saveAutomation(source, { repositories: [], environmentIds: [ENVIRONMENT] });
      vi.mocked(repositoryResolution.resolveSessionRepositories).mockResolvedValueOnce([
        {
          repoOwner: WEB.repo_owner,
          repoName: WEB.repo_name,
          repoId: 101,
          baseBranch: WEB.base_branch,
        },
        {
          repoOwner: API.repo_owner,
          repoName: API.repo_name,
          repoId: 909,
          baseBranch: API.base_branch,
        },
      ]);

      await expectDenied(source, row);
      expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenCalledWith(TEAM, [101, 909]);
    }
  );

  it.each(SOURCES)("leaves workspace firings unrestricted by team grants (%s)", async (source) => {
    await saveEnvironment([API], null);
    const row = await saveAutomation(source, { ownerTeamId: null, environmentIds: [ENVIRONMENT] });

    await expectAdmitted(source, row, 2);
    expect(TeamRepositoryGrantStore.prototype.covers).not.toHaveBeenCalled();
    for (const [, input] of vi.mocked(sessionInitialization.initializeSession).mock.calls) {
      expect(input).toMatchObject({ ownerTeamId: null, visibility: "workspace" });
    }
  });

  it.each(SOURCES)("freezes authorized environment members before %s admission", async (source) => {
    await grantRepository();
    await grantRepository(API);
    await saveEnvironment();
    const row = await saveAutomation(source, { repositories: [], environmentIds: [ENVIRONMENT] });
    const editedMembers = [
      WEB,
      { ...API, base_branch: "edited-after-admission" },
      { ...API, position: 2, repo_name: "ungranted", repo_id: 303 },
    ];
    vi.mocked(AutomationStore.prototype.insertInvocationGuarded).mockImplementation(async function (
      this: AutomationStore,
      params
    ) {
      const result = await insertInvocationGuarded.call(this, params);
      expect(result.inserted).toBe(true);
      await new EnvironmentStore(env.DB).replaceRepositories(ENVIRONMENT, editedMembers);
      return result;
    });

    await expectAdmitted(source, row, 1);
    const resolveMembers = vi.mocked(repositoryResolution.resolveSessionRepositories);
    expect(resolveMembers).toHaveBeenCalledTimes(1);
    expect(resolveMembers.mock.calls[0][1]).toEqual([
      { repoOwner: WEB.repo_owner, repoName: WEB.repo_name, baseBranch: WEB.base_branch },
      { repoOwner: API.repo_owner, repoName: API.repo_name, baseBranch: API.base_branch },
    ]);
    const authorizedMembers = await resolveMembers.mock.results[0].value;
    const [, input] = vi.mocked(sessionInitialization.initializeSession).mock.calls[0];
    expect(input.repositories).toEqual(authorizedMembers);
    expect(input).toMatchObject({
      environmentId: ENVIRONMENT,
      repoOwner: WEB.repo_owner,
      repoName: WEB.repo_name,
      repoId: WEB.repo_id,
      defaultBranch: WEB.base_branch,
      repositories: [
        {
          repoOwner: WEB.repo_owner,
          repoName: WEB.repo_name,
          repoId: 101,
          baseBranch: WEB.base_branch,
        },
        {
          repoOwner: API.repo_owner,
          repoName: API.repo_name,
          repoId: 202,
          baseBranch: API.base_branch,
        },
      ],
    });
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenCalledWith(TEAM, [101, 202]);
    const insert = vi.mocked(AutomationStore.prototype.insertInvocationGuarded);
    expect(resolveMembers.mock.invocationCallOrder[0]).toBeLessThan(
      insert.mock.invocationCallOrder[0]
    );
    const checkGrants = vi.mocked(TeamRepositoryGrantStore.prototype.covers);
    expect(checkGrants.mock.invocationCallOrder[0]).toBeLessThan(
      insert.mock.invocationCallOrder[0]
    );
    expect(await new EnvironmentStore(env.DB).getRepositoriesForEnvironment(ENVIRONMENT)).toEqual(
      editedMembers.map((member) => ({ environment_id: ENVIRONMENT, ...member }))
    );
  });
});
