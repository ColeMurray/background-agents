import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationInvocationSource } from "@open-inspect/shared/types/automations";
import * as automationRepositories from "../../src/automation/repository";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { AutomationStore, type AutomationRepositoryInsert } from "../../src/db/automation-store";
import { EnvironmentStore } from "../../src/db/environments";
import { SessionIndexStore } from "../../src/db/session-index";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import * as repositoryResolution from "../../src/repos/resolve";
import { AutomationExecutionUnauthorizedError, Scheduler } from "../../src/scheduler/scheduler";
import * as sessionInitialization from "../../src/session/initialize";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, sqlDatabase } from "./helpers";
import { fetchRuns } from "./run-helpers";
import { seedEnvironment, seedGrant, seedTeam } from "./ownership-test-helpers";

const EXECUTOR = "11111111111111111111111111111111";
const REQUESTER = "22222222222222222222222222222222";
const TEAM = "team_automation_grants";
const OTHER_TEAM = "team_automation_grants_other";
const ENVIRONMENT = "env_55555555555555555555555555555555";
const WEB = {
  position: 0,
  repo_owner: "acme/group",
  repo_name: "web",
  repo_id: 101,
  base_branch: "main",
};
const API = { ...WEB, position: 1, repo_name: "api", repo_id: 202, base_branch: "develop" };
const insertInvocationGuarded = AutomationStore.prototype.insertInvocationGuarded;

async function saveAutomation(
  source: AutomationInvocationSource,
  repositories: AutomationRepositoryInsert[] = [WEB],
  environmentIds: string[] = []
) {
  const id = `auto-team-grants-${source}`;
  await env.DB.prepare(
    `INSERT INTO automations
       (id, owner_team_id, name, instructions, trigger_type, schedule_cron, model,
        next_run_at, consecutive_failures, created_by, user_id, created_at, updated_at)
     VALUES (?, ?, 'Current team grants', 'Run tests', ?, ?, 'anthropic/claude-sonnet-4-6', ?, 2, ?, ?, 1, 1)`
  )
    .bind(
      id,
      TEAM,
      source === "event" ? "webhook" : "schedule",
      source === "event" ? null : "0 9 * * *",
      source === "schedule" ? Date.now() - 60_000 : null,
      EXECUTOR,
      EXECUTOR
    )
    .run();
  const store = new AutomationStore(env.DB);
  await sqlDatabase(env.DB).batch([
    ...store.bindRepositoryInserts(id, repositories, 1),
    ...store.bindEnvironmentInserts(id, environmentIds, 1),
  ]);
  return (await store.getById(id))!;
}

async function expectDenied(source: AutomationInvocationSource) {
  const store = new AutomationStore(env.DB);
  const row = (await store.getById(`auto-team-grants-${source}`))!;
  const scheduler = new Scheduler(sqlDatabase(env.DB), createCloudflareEnv(env), { submit() {} });
  if (source === "manual") {
    await expect(scheduler.trigger(row.id, REQUESTER)).rejects.toMatchObject({
      name: AutomationExecutionUnauthorizedError.name,
      reason: "target_team_missing_grant",
    });
  } else if (source === "schedule") {
    expect(await scheduler.tick()).toEqual({ processed: 0, skipped: 1, failed: 0 });
  } else {
    expect(
      await scheduler.event({
        source: "webhook",
        automationId: row.id,
        eventType: "webhook.received",
        triggerKey: `webhook:${row.id}:delivery-1`,
        concurrencyKey: `webhook:${row.id}`,
        contextBlock: "Webhook received",
        meta: {},
        body: {},
      })
    ).toEqual({ triggered: 0, skipped: 1, steered: 0, invocationIds: [] });
  }
  expect(sessionInitialization.initializeSession).not.toHaveBeenCalled();
  expect(AutomationStore.prototype.insertInvocationGuarded).not.toHaveBeenCalled();
  expect(await fetchRuns(row.id)).toEqual([]);
  const sessions = await env.DB.prepare("SELECT id FROM sessions WHERE automation_id = ?")
    .bind(row.id)
    .all();
  expect(sessions.results).toEqual([]);
  const { invocations } = await store.listInvocations(row.id, { limit: 10, offset: 0 });
  expect(invocations).toEqual(
    source === "schedule"
      ? [
          expect.objectContaining({
            source,
            scheduledAt: row.next_run_at,
            skipReason: "target_team_missing_grant",
            status: "skipped",
            runs: [],
          }),
        ]
      : []
  );
  if (source === "schedule") {
    expect(await store.getInvocationById(invocations[0].id)).toMatchObject({
      failure_counted_at: null,
    });
    expect(await scheduler.tick()).toEqual({ processed: 0, skipped: 0, failed: 0 });
    expect(
      (await store.listInvocations(row.id, { limit: 10, offset: 0 })).invocations
    ).toHaveLength(1);
  }
  expect(await store.getById(row.id)).toMatchObject({
    enabled: source === "schedule" ? 0 : 1,
    next_run_at: null,
    consecutive_failures: 2,
  });
}

describe("automation current team repository grants (integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [EXECUTOR, REQUESTER]) await seedActiveUser(userId);
    await seedTeam(TEAM, [
      [EXECUTOR, "member"],
      [REQUESTER, "member"],
    ]);
    await seedTeam(OTHER_TEAM);
    vi.spyOn(automationRepositories, "resolveAutomationRepositories").mockImplementation(
      async (_env, repositories) =>
        repositories.map((requested) => ({
          requested,
          error: null,
          repository: {
            repoOwner: requested.repo_owner,
            repoName: requested.repo_name,
            repoId: requested.repo_name === "web" ? 101 : 202,
            baseBranch: requested.base_branch ?? "main",
          },
        }))
    );
    vi.spyOn(repositoryResolution, "resolveSessionRepositories").mockImplementation(
      async (_env, repositories) =>
        repositories.map((repository) => ({
          ...repository,
          repoId: repository.repoName === "web" ? 101 : repository.repoName === "api" ? 202 : 303,
          baseBranch: repository.baseBranch ?? "main",
        }))
    );
    vi.spyOn(TeamRepositoryGrantStore.prototype, "covers");
    vi.spyOn(AutomationStore.prototype, "insertInvocationGuarded");
    vi.spyOn(sessionInitialization, "initializeSession");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it.each(["manual", "schedule", "event"] as const)(
    "rejects revoked direct grants on %s firing",
    async (source) => {
      await seedGrant(TEAM, WEB);
      await saveAutomation(source);
      expect(await new TeamRepositoryGrantStore(env.DB).covers(TEAM, [101])).toBe(true);
      await env.DB.prepare("DELETE FROM team_repository_grants WHERE team_id = ?").bind(TEAM).run();
      await expectDenied(source);
      expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenLastCalledWith(TEAM, [101]);
    }
  );

  it.each(["manual", "schedule"] as const)(
    "refuses %s admission when grants are revoked after the coverage check",
    async (source) => {
      await seedGrant(TEAM, WEB);
      const row = await saveAutomation(source);
      const covers = TeamRepositoryGrantStore.prototype.covers;
      vi.mocked(TeamRepositoryGrantStore.prototype.covers).mockImplementationOnce(async function (
        this: TeamRepositoryGrantStore,
        teamId,
        repoIds
      ) {
        const covered = await covers.call(this, teamId, repoIds);
        // A concurrent revocation lands between coverage and the guarded insert.
        await env.DB.prepare("DELETE FROM team_repository_grants WHERE team_id = ?")
          .bind(TEAM)
          .run();
        await env.DB.prepare("UPDATE teams SET grants_version = grants_version + 1 WHERE id = ?")
          .bind(TEAM)
          .run();
        return covered;
      });
      const scheduler = new Scheduler(sqlDatabase(env.DB), createCloudflareEnv(env), {
        submit() {},
      });
      if (source === "manual") {
        await expect(scheduler.trigger(row.id, REQUESTER)).rejects.toMatchObject({
          name: "AutomationTriggerBlockedError",
          reason: "team_grants_changed",
        });
      } else {
        expect(await scheduler.tick()).toEqual({ processed: 0, skipped: 1, failed: 0 });
      }
      const store = new AutomationStore(env.DB);
      expect(AutomationStore.prototype.insertInvocationGuarded).toHaveBeenCalledOnce();
      expect(await fetchRuns(row.id)).toEqual([]);
      expect((await store.listInvocations(row.id, { limit: 10, offset: 0 })).invocations).toEqual(
        []
      );
      expect(sessionInitialization.initializeSession).not.toHaveBeenCalled();
      // The slot stays due, so the next tick re-authorizes against current grants.
      expect((await store.getById(row.id))?.next_run_at).toBe(row.next_run_at);
    }
  );

  it("rechecks all environment grants against current resolved member IDs", async () => {
    await seedGrant(TEAM, WEB);
    await seedGrant(TEAM, API);
    await seedEnvironment(ENVIRONMENT, TEAM, [WEB, API]);
    await saveAutomation("manual", [], [ENVIRONMENT]);
    expect(await new TeamRepositoryGrantStore(env.DB).covers(TEAM, [101, 202])).toBe(true);
    await env.DB.prepare(
      "DELETE FROM team_repository_grants WHERE team_id = ? AND repo_external_id = ?"
    )
      .bind(TEAM, 202)
      .run();
    await expectDenied("manual");
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenLastCalledWith(TEAM, [101, 202]);
    await seedGrant(TEAM, API);
    const resolve = vi.mocked(repositoryResolution.resolveSessionRepositories);
    const members = await resolve.mock.results[0].value;
    resolve.mockResolvedValueOnce([members[0], { ...members[1], repoId: 909 }]);
    await expectDenied("manual");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenLastCalledWith(TEAM, [101, 909]);
  });

  it("rechecks installation grants within the owning team", async () => {
    const store = new TeamRepositoryGrantStore(env.DB);
    await seedGrant(TEAM, "installation");
    expect(await store.covers(TEAM, [101, 202])).toBe(true);
    expect(await store.covers(OTHER_TEAM, [101, 202])).toBe(false);
    await env.DB.prepare("DELETE FROM team_repository_grants WHERE team_id = ?").bind(TEAM).run();
    expect(await store.covers(TEAM, [101, 202])).toBe(false);
  });

  it("checks the current resolved direct repository ID", async () => {
    await seedGrant(TEAM, WEB);
    const row = await saveAutomation("manual");
    vi.mocked(automationRepositories.resolveAutomationRepositories).mockResolvedValueOnce([
      {
        requested: (await new AutomationStore(env.DB).getRepositoriesForAutomation(row.id))[0],
        repository: {
          repoOwner: WEB.repo_owner,
          repoName: WEB.repo_name,
          repoId: 909,
          baseBranch: WEB.base_branch,
        },
        error: null,
      },
    ]);
    await expectDenied("manual");
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenCalledWith(TEAM, [909]);
    expect(
      (await new AutomationStore(env.DB).getRepositoriesForAutomation(row.id))[0].repo_id
    ).toBe(101);
  });

  it("freezes authorized members through successful session initialization", async () => {
    await seedGrant(TEAM, WEB);
    await seedGrant(TEAM, API);
    await seedEnvironment(ENVIRONMENT, TEAM, [WEB, API]);
    const row = await saveAutomation("schedule", [], [ENVIRONMENT]);
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
    const runtime = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      expect(["/internal/init", "/internal/prompt"]).toContain(path);
      return Response.json(
        path === "/internal/init"
          ? { status: "ok" }
          : { messageId: "msg-snapshot", status: "queued" }
      );
    });
    const schedulerEnv = createCloudflareEnv(env);
    schedulerEnv.SESSION = (_sessionId, request) => runtime(request);
    expect(await new Scheduler(sqlDatabase(env.DB), schedulerEnv, { submit() {} }).tick()).toEqual({
      processed: 1,
      skipped: 0,
      failed: 0,
    });
    const resolve = vi.mocked(repositoryResolution.resolveSessionRepositories);
    expect(resolve).toHaveBeenCalledTimes(1);
    const authorizedMembers = await resolve.mock.results[0].value;
    const init = runtime.mock.calls.find(
      ([request]) => new URL(request.url).pathname === "/internal/init"
    )!;
    expect(await init[0].json()).toMatchObject({
      environmentId: ENVIRONMENT,
      repoOwner: WEB.repo_owner,
      repoName: WEB.repo_name,
      repoId: 101,
      defaultBranch: WEB.base_branch,
      repositories: authorizedMembers,
    });
    const runs = await fetchRuns(row.id);
    expect(runs).toEqual([
      expect.objectContaining({ status: "running", session_id: expect.any(String) }),
    ]);
    const sessionId = runs[0].session_id!;
    expect(await new SessionIndexStore(env.DB).get(sessionId)).toMatchObject({
      ownerTeamId: TEAM,
      visibility: "team",
      environmentId: ENVIRONMENT,
      userId: EXECUTOR,
    });
    const persisted = await env.DB.prepare(
      "SELECT repo_owner AS repoOwner, repo_name AS repoName, repo_id AS repoId, base_branch AS baseBranch FROM session_repositories WHERE session_id = ? ORDER BY position"
    )
      .bind(sessionId)
      .all();
    expect(persisted.results).toEqual(authorizedMembers);
    expect(sessionInitialization.initializeSession).toHaveBeenCalledTimes(1);
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenCalledWith(TEAM, [101, 202]);
    const insert = vi.mocked(AutomationStore.prototype.insertInvocationGuarded);
    expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(insert.mock.invocationCallOrder[0]);
    expect(
      vi.mocked(TeamRepositoryGrantStore.prototype.covers).mock.invocationCallOrder[0]
    ).toBeLessThan(insert.mock.invocationCallOrder[0]);
    expect(await new EnvironmentStore(env.DB).getRepositoriesForEnvironment(ENVIRONMENT)).toEqual(
      editedMembers.map((member) => ({ environment_id: ENVIRONMENT, ...member }))
    );
  });
});
