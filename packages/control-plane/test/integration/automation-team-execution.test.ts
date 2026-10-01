import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { isAutomationExecutionAuthorized } from "../../src/automation/authorization-guard";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { AutomationExecutionUnauthorizedError, Scheduler } from "../../src/scheduler/scheduler";
import { cleanD1Tables } from "./cleanup";
import { queryDO, seedActiveUser, serviceFetch, sqlDatabase } from "./helpers";
import { fetchRuns } from "./run-helpers";

const EXECUTOR = "11111111111111111111111111111111";
const LEAD = "22222222222222222222222222222222";
const MEMBER = "33333333333333333333333333333333";
const ADMIN = "44444444444444444444444444444444";
const OUTSIDER = "55555555555555555555555555555555";
const TEAM = "team_automation_execution";
const OTHER_TEAM = "team_automation_execution_other";

function automation(id: string, overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id,
    owner_team_id: TEAM,
    name: id,
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: now - 60_000,
    consecutive_failures: 0,
    created_by: EXECUTOR,
    user_id: EXECUTOR,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    ...overrides,
  };
}

function authorized(automationId: string, executionUserId?: string): Promise<boolean> {
  return isAutomationExecutionAuthorized(sqlDatabase(env.DB), {
    automationId,
    ...(executionUserId === undefined ? {} : { executionUserId }),
    requiresRepositoryUse: false,
    requiresEnvironmentUse: false,
  });
}

function createScheduler(): Scheduler {
  return new Scheduler(sqlDatabase(env.DB), createCloudflareEnv(env), { submit() {} });
}

async function expectNoLaunch(automationId: string): Promise<void> {
  expect(await fetchRuns(automationId)).toEqual([]);
  const sessions = await env.DB.prepare("SELECT id FROM sessions WHERE automation_id = ?")
    .bind(automationId)
    .all();
  expect(sessions.results).toEqual([]);
}

async function expectLaunchedSession(
  automationId: string,
  ownerTeamId: string | null,
  visibility: SessionVisibility,
  userId: string
): Promise<void> {
  const runs = await fetchRuns(automationId);
  expect(runs).toEqual([
    expect.objectContaining({
      status: "running",
      session_id: expect.any(String),
      repo_owner: null,
      repo_name: null,
      repo_id: null,
      base_branch: null,
      environment_id: null,
    }),
  ]);
  const run = runs[0]!;
  const sessions = await env.DB.prepare(
    `SELECT id, owner_team_id, visibility, user_id, spawn_source, automation_run_id,
       repo_owner, repo_name, base_branch
     FROM sessions WHERE automation_id = ?`
  )
    .bind(automationId)
    .all();
  expect(sessions.results).toEqual([
    {
      id: run.session_id,
      owner_team_id: ownerTeamId,
      visibility,
      user_id: userId,
      spawn_source: "automation",
      automation_run_id: run.id,
      repo_owner: null,
      repo_name: null,
      base_branch: null,
    },
  ]);

  const stub = env.SESSION.get(env.SESSION.idFromName(run.session_id!));
  expect(await queryDO(stub, "SELECT repo_owner, repo_name, base_branch FROM session")).toEqual([
    { repo_owner: null, repo_name: null, base_branch: null },
  ]);
  expect(
    await queryDO(
      stub,
      `SELECT m.content, m.source, p.canonical_user_id
       FROM messages m JOIN participants p ON p.id = m.author_id`
    )
  ).toEqual([{ content: "Run tests", source: "automation", canonical_user_id: userId }]);
}

describe("automation team execution (integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [EXECUTOR, LEAD, MEMBER, ADMIN, OUTSIDER]) {
      await seedActiveUser(userId);
    }
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_builtin_administrator' WHERE user_id = ?"
      ).bind(ADMIN),
      env.DB.prepare(
        `INSERT INTO teams (id, slug, name, created_at, updated_at)
         VALUES (?, ?, 'Automation Execution', 1, 1), (?, ?, 'Other Execution', 1, 1)`
      ).bind(TEAM, TEAM, OTHER_TEAM, OTHER_TEAM),
      ...(
        [
          [TEAM, EXECUTOR, "member"],
          [TEAM, LEAD, "lead"],
          [TEAM, MEMBER, "member"],
          [OTHER_TEAM, EXECUTOR, "member"],
          [OTHER_TEAM, OUTSIDER, "member"],
          [OTHER_TEAM, ADMIN, "member"],
        ] as const
      ).map(([teamId, userId, role]) =>
        env.DB.prepare(
          `INSERT INTO team_memberships (team_id, user_id, role, created_at)
           VALUES (?, ?, ?, 1)`
        ).bind(teamId, userId, role)
      ),
    ]);
  });
  afterEach(cleanD1Tables);

  it.each([undefined, EXECUTOR, MEMBER, LEAD])(
    "authorizes an active team execution principal (%s)",
    async (executionUserId) => {
      await new AutomationStore(env.DB).create(automation("auto-team-authorized"));

      await expect(authorized("auto-team-authorized", executionUserId)).resolves.toBe(true);
    }
  );

  it("rejects a departed stored executor even when they remain in another team", async () => {
    const store = new AutomationStore(env.DB);
    await store.create(automation("auto-departed-executor"));
    await store.create(
      automation("auto-workspace-executor", { owner_team_id: null, next_run_at: null })
    );
    await expect(authorized("auto-departed-executor")).resolves.toBe(true);
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(TEAM, EXECUTOR)
      .run();

    await expect(authorized("auto-departed-executor")).resolves.toBe(false);
    await expect(authorized("auto-workspace-executor")).resolves.toBe(true);
    expect(await createScheduler().tick()).toEqual({ processed: 0, skipped: 1, failed: 0 });
    const { invocations } = await store.listInvocations("auto-departed-executor", {
      limit: 10,
      offset: 0,
    });
    expect(invocations).toEqual([
      expect.objectContaining({
        source: "schedule",
        status: "skipped",
        skipReason: "execution_authorization_denied",
        runs: [],
      }),
    ]);
    expect(await store.getById("auto-departed-executor")).toMatchObject({
      enabled: 0,
      next_run_at: null,
      consecutive_failures: 0,
    });
    await expectNoLaunch("auto-departed-executor");
  });

  it.each([
    { role: "member", requesterId: OUTSIDER },
    { role: "administrator", requesterId: ADMIN },
  ])(
    "rejects an explicit nonmember manual requester with the $role role",
    async ({ requesterId }) => {
      const store = new AutomationStore(env.DB);
      await store.create(automation("auto-nonmember-requester"));
      await store.create(automation("auto-workspace-requester", { owner_team_id: null }));
      await expect(authorized("auto-nonmember-requester")).resolves.toBe(true);
      await expect(authorized("auto-workspace-requester", requesterId)).resolves.toBe(true);
      await expect(authorized("auto-nonmember-requester", requesterId)).resolves.toBe(false);

      const denied = createScheduler().trigger("auto-nonmember-requester", requesterId);
      await expect(denied).rejects.toBeInstanceOf(AutomationExecutionUnauthorizedError);
      await expect(denied).rejects.toMatchObject({ reason: "execution_authorization_denied" });
      expect(
        (await store.listInvocations("auto-nonmember-requester", { limit: 10, offset: 0 }))
          .invocations
      ).toEqual([]);
      await expectNoLaunch("auto-nonmember-requester");
    }
  );

  it("rejects archived team execution and exposes the archived reason on a manual error", async () => {
    const store = new AutomationStore(env.DB);
    await store.create(automation("auto-archived-manual"));
    await expect(authorized("auto-archived-manual")).resolves.toBe(true);
    await expect(authorized("auto-archived-manual", MEMBER)).resolves.toBe(true);
    await env.DB.prepare("UPDATE teams SET archived_at = 2 WHERE id = ?").bind(TEAM).run();

    await expect(authorized("auto-archived-manual")).resolves.toBe(false);
    await expect(authorized("auto-archived-manual", MEMBER)).resolves.toBe(false);
    const denied = createScheduler().trigger("auto-archived-manual", MEMBER);
    await expect(denied).rejects.toBeInstanceOf(AutomationExecutionUnauthorizedError);
    await expect(denied).rejects.toMatchObject({ reason: "team_archived" });
    expect(
      (await store.listInvocations("auto-archived-manual", { limit: 10, offset: 0 })).invocations
    ).toEqual([]);
    await expectNoLaunch("auto-archived-manual");
  });

  it("persists a childless archived-team scheduled skip and pauses without a failure strike", async () => {
    const store = new AutomationStore(env.DB);
    const row = automation("auto-archived-schedule", { consecutive_failures: 2 });
    await store.create(row);
    await env.DB.prepare("UPDATE teams SET archived_at = 2 WHERE id = ?").bind(TEAM).run();

    const scheduler = createScheduler();
    expect(await scheduler.tick()).toEqual({ processed: 0, skipped: 1, failed: 0 });
    const { invocations } = await store.listInvocations(row.id, { limit: 10, offset: 0 });
    expect(invocations).toEqual([
      expect.objectContaining({
        source: "schedule",
        scheduledAt: row.next_run_at,
        status: "skipped",
        skipReason: "team_archived",
        runs: [],
      }),
    ]);
    expect(await store.getInvocationById(invocations[0]!.id)).toMatchObject({
      skip_reason: "team_archived",
      failure_counted_at: null,
    });
    expect(await store.getById(row.id)).toMatchObject({
      enabled: 0,
      next_run_at: null,
      consecutive_failures: 2,
    });
    await expectNoLaunch(row.id);
    expect(await scheduler.tick()).toEqual({ processed: 0, skipped: 0, failed: 0 });
    expect(
      (await store.listInvocations(row.id, { limit: 10, offset: 0 })).invocations
    ).toHaveLength(1);
  });

  it("allows a lead to reassign a departed executor and launches the next scheduled run", async () => {
    const store = new AutomationStore(env.DB);
    const row = automation("auto-reassigned-executor");
    await store.create(row);
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(TEAM, EXECUTOR)
      .run();
    await expect(authorized(row.id)).resolves.toBe(false);

    const reassigned = await serviceFetch(`https://cp.test/automations/${row.id}`, {
      as: { userId: LEAD, role: "member" },
      method: "PATCH",
      body: JSON.stringify({ userId: MEMBER }),
    });
    expect(reassigned.status).toBe(200);
    await expect(reassigned.json()).resolves.toMatchObject({
      automation: { id: row.id, ownerTeamId: TEAM, userId: MEMBER },
    });
    expect(await store.getById(row.id)).toMatchObject({
      created_by: EXECUTOR,
      user_id: MEMBER,
      owner_team_id: TEAM,
    });
    await expect(authorized(row.id)).resolves.toBe(true);
    expect(await createScheduler().tick()).toEqual({ processed: 1, skipped: 0, failed: 0 });
    await expectLaunchedSession(row.id, TEAM, "team", MEMBER);
    expect((await store.getById(row.id))!.next_run_at!).toBeGreaterThan(row.next_run_at!);
  });

  it.each(
    (["manual", "schedule"] as const).flatMap((source) =>
      (["team", "workspace", "private"] as const).map((visibility) => ({ source, visibility }))
    )
  )(
    "creates a $source session in the automation team with its $visibility default",
    async ({ source, visibility }) => {
      await env.DB.prepare("UPDATE teams SET default_visibility = ? WHERE id = ?")
        .bind(visibility, TEAM)
        .run();
      const row = automation(`auto-session-${source}-${visibility}`);
      await new AutomationStore(env.DB).create(row);
      const scheduler = createScheduler();
      const executionUserId = source === "manual" ? MEMBER : EXECUTOR;

      if (source === "manual") {
        await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
          .bind(TEAM, EXECUTOR)
          .run();
        await expect(authorized(row.id)).resolves.toBe(false);
        await expect(authorized(row.id, MEMBER)).resolves.toBe(true);
        await expect(scheduler.trigger(row.id, MEMBER)).resolves.toMatchObject({
          runs: [expect.objectContaining({ status: "running" })],
        });
      } else {
        expect(await scheduler.tick()).toEqual({ processed: 1, skipped: 0, failed: 0 });
      }

      await expectLaunchedSession(row.id, TEAM, visibility, executionUserId);
    }
  );

  it.each(["manual", "schedule"] as const)(
    "keeps a workspace automation's %s session workspace-owned despite archived team membership",
    async (source) => {
      await env.DB.prepare(
        "UPDATE teams SET default_visibility = 'private', archived_at = 2 WHERE id = ?"
      )
        .bind(TEAM)
        .run();
      const row = automation(`auto-workspace-session-${source}`, { owner_team_id: null });
      await new AutomationStore(env.DB).create(row);
      const scheduler = createScheduler();
      const executionUserId = source === "manual" ? MEMBER : EXECUTOR;
      await expect(authorized(row.id, executionUserId)).resolves.toBe(true);

      if (source === "manual") {
        await expect(scheduler.trigger(row.id, MEMBER)).resolves.toMatchObject({
          runs: [expect.objectContaining({ status: "running" })],
        });
      } else {
        expect(await scheduler.tick()).toEqual({ processed: 1, skipped: 0, failed: 0 });
      }

      await expectLaunchedSession(row.id, null, "workspace", executionUserId);
    }
  );
});
