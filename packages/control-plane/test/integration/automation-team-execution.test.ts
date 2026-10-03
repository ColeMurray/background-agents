import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { isAutomationExecutionAuthorized } from "../../src/automation/authorization-guard";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { AutomationStore } from "../../src/db/automation-store";
import { SessionIndexStore } from "../../src/db/session-index";
import { Scheduler } from "../../src/scheduler/scheduler";
import { cleanD1Tables } from "./cleanup";
import { queryDO, seedActiveUser, serviceFetch, sqlDatabase } from "./helpers";
import { fetchRuns } from "./run-helpers";
import { seedTeam } from "./ownership-test-helpers";

const EXECUTOR = "11111111111111111111111111111111";
const LEAD = "22222222222222222222222222222222";
const MEMBER = "33333333333333333333333333333333";
const ADMIN = "44444444444444444444444444444444";
const TEAM = "team_automation_execution";
const OTHER_TEAM = "team_automation_execution_other";

async function saveAutomation(id: string, ownerTeamId: string | null = TEAM) {
  await env.DB.prepare(
    `INSERT INTO automations
       (id, owner_team_id, name, instructions, schedule_cron, model, next_run_at,
        consecutive_failures, created_by, user_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Run tests', '0 9 * * *', 'anthropic/claude-sonnet-4-6', ?, 2, ?, ?, 1, 1)`
  )
    .bind(id, ownerTeamId, id, Date.now() - 60_000, EXECUTOR, EXECUTOR)
    .run();
  return (await new AutomationStore(env.DB).getById(id))!;
}

function authorized(automationId: string, executionUserId?: string) {
  return isAutomationExecutionAuthorized(sqlDatabase(env.DB), {
    automationId,
    executionUserId,
    requiresRepositoryUse: false,
    requiresEnvironmentUse: false,
  });
}

function createScheduler() {
  return new Scheduler(sqlDatabase(env.DB), createCloudflareEnv(env), { submit() {} });
}

async function expectNoLaunch(automationId: string) {
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
) {
  const runs = await fetchRuns(automationId);
  expect(runs).toEqual([
    expect.objectContaining({
      status: "running",
      session_id: expect.any(String),
    }),
  ]);
  const run = runs[0];
  expect(await new SessionIndexStore(env.DB).get(run.session_id!)).toMatchObject({
    ownerTeamId,
    visibility,
    userId,
    spawnSource: "automation",
    automationId,
    automationRunId: run.id,
    repoOwner: null,
    repoName: null,
    baseBranch: null,
  });
  const stub = env.SESSION.get(env.SESSION.idFromName(run.session_id!));
  expect(await queryDO(stub, "SELECT repo_owner, repo_name, base_branch FROM session")).toEqual([
    { repo_owner: null, repo_name: null, base_branch: null },
  ]);
  expect(
    await queryDO(
      stub,
      "SELECT m.content, m.source, p.canonical_user_id FROM messages m JOIN participants p ON p.id = m.author_id"
    )
  ).toEqual([{ content: "Run tests", source: "automation", canonical_user_id: userId }]);
}

describe("automation team execution (integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [EXECUTOR, LEAD, MEMBER, ADMIN]) await seedActiveUser(userId);
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_administrator' WHERE user_id = ?"
    )
      .bind(ADMIN)
      .run();
    await seedTeam(TEAM, [
      [EXECUTOR, "member"],
      [LEAD, "lead"],
      [MEMBER, "member"],
    ]);
    await seedTeam(OTHER_TEAM, [
      [EXECUTOR, "member"],
      [ADMIN, "member"],
    ]);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it("rejects a departed executor despite other-team membership", async () => {
    const row = await saveAutomation("auto-departed-executor");
    expect(await authorized(row.id)).toBe(true);
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(TEAM, EXECUTOR)
      .run();
    expect(await authorized(row.id)).toBe(false);
    expect(await createScheduler().tick()).toEqual({ processed: 0, skipped: 1, failed: 0 });
    await expectNoLaunch(row.id);
  });

  it("rejects nonmember administrator manual execution", async () => {
    const row = await saveAutomation("auto-nonmember-requester");
    expect(await authorized(row.id)).toBe(true);
    await expect(createScheduler().trigger(row.id, ADMIN)).rejects.toMatchObject({
      name: "AutomationExecutionUnauthorizedError",
      reason: "execution_authorization_denied",
    });
    expect(
      (await new AutomationStore(env.DB).listInvocations(row.id, { limit: 10, offset: 0 }))
        .invocations
    ).toEqual([]);
    await expectNoLaunch(row.id);
  });

  it("rejects archived manual execution and pauses scheduled work without a failure strike", async () => {
    const row = await saveAutomation("auto-archived-team");
    await env.DB.prepare("UPDATE teams SET archived_at = 2 WHERE id = ?").bind(TEAM).run();
    expect(await authorized(row.id)).toBe(false);
    expect(await authorized(row.id, MEMBER)).toBe(false);
    const scheduler = createScheduler();
    await expect(scheduler.trigger(row.id, MEMBER)).rejects.toMatchObject({
      reason: "team_archived",
    });
    const store = new AutomationStore(env.DB);
    expect((await store.listInvocations(row.id, { limit: 10, offset: 0 })).invocations).toEqual([]);
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
    expect(await store.getInvocationById(invocations[0].id)).toMatchObject({
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

  describe("authorization lost after invocation admission", () => {
    /** Run `change` right after the guarded insert admits the invocation, before launch. */
    function afterAdmission(change: () => Promise<unknown>) {
      const insert = AutomationStore.prototype.insertInvocationGuarded;
      vi.spyOn(AutomationStore.prototype, "insertInvocationGuarded").mockImplementation(
        async function (this: AutomationStore, params) {
          const admitted = await insert.call(this, params);
          await change();
          return admitted;
        }
      );
    }

    function removeMember(userId: string) {
      return env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
        .bind(TEAM, userId)
        .run();
    }

    async function expectDeniedLaunch(automationId: string, reason: string) {
      expect(await fetchRuns(automationId)).toEqual([
        expect.objectContaining({
          status: "unauthorized",
          failure_reason: reason,
          session_id: null,
        }),
      ]);
      const sessions = await env.DB.prepare("SELECT id FROM sessions WHERE automation_id = ?")
        .bind(automationId)
        .all();
      expect(sessions.results).toEqual([]);
    }

    it.each([
      ["is removed from the team", "execution_authorization_denied", () => removeMember(EXECUTOR)],
      [
        "is suspended",
        "execution_authorization_denied",
        () => env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(EXECUTOR).run(),
      ],
      [
        "loses sessions.create",
        "execution_authorization_denied",
        () =>
          env.DB.prepare(
            "UPDATE user_role_assignments SET role_id = 'role_builtin_viewer' WHERE user_id = ?"
          )
            .bind(EXECUTOR)
            .run(),
      ],
      [
        "belongs to a team that is archived",
        "team_archived",
        () => env.DB.prepare("UPDATE teams SET archived_at = 2 WHERE id = ?").bind(TEAM).run(),
      ],
    ])(
      "does not launch or count a failure when the scheduled executor %s",
      async (_, reason, change) => {
        const row = await saveAutomation("auto-denied-at-launch");
        afterAdmission(change);
        expect(await createScheduler().tick()).toEqual({ processed: 0, skipped: 1, failed: 0 });
        expect(await authorized(row.id)).toBe(false);
        await expectDeniedLaunch(row.id, reason);
        const { invocations } = await new AutomationStore(env.DB).listInvocations(row.id, {
          limit: 10,
          offset: 0,
        });
        expect(invocations).toEqual([expect.objectContaining({ status: "unauthorized" })]);
        // Two failures are already on record; a strike here would auto-pause at three.
        expect(await new AutomationStore(env.DB).getById(row.id)).toMatchObject({
          enabled: 1,
          consecutive_failures: 2,
        });
      }
    );

    it("answers 403 when a manual requester is removed mid-launch", async () => {
      const row = await saveAutomation("auto-manual-denied-at-launch");
      afterAdmission(() => removeMember(LEAD));
      const response = await serviceFetch(`https://cp.test/automations/${row.id}/trigger`, {
        as: { userId: LEAD, role: "member" },
        method: "POST",
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        reason_code: "execution_authorization_denied",
      });
      await expectDeniedLaunch(row.id, "execution_authorization_denied");
      expect(await new AutomationStore(env.DB).getById(row.id)).toMatchObject({
        consecutive_failures: 2,
      });
    });
  });

  it("launches a scheduled run after lead executor reassignment", async () => {
    const row = await saveAutomation("auto-reassigned-executor");
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(TEAM, EXECUTOR)
      .run();
    expect(await authorized(row.id)).toBe(false);
    const response = await serviceFetch(`https://cp.test/automations/${row.id}`, {
      as: { userId: LEAD, role: "member" },
      method: "PATCH",
      body: JSON.stringify({ userId: MEMBER }),
    });
    expect(response.status).toBe(200);
    expect(await new AutomationStore(env.DB).getById(row.id)).toMatchObject({
      created_by: EXECUTOR,
      user_id: MEMBER,
      owner_team_id: TEAM,
    });
    expect(await authorized(row.id)).toBe(true);
    expect(await createScheduler().tick()).toEqual({ processed: 1, skipped: 0, failed: 0 });
    await expectLaunchedSession(row.id, TEAM, "team", MEMBER);
  });

  it.each(["team", "workspace", "private"] as const)(
    "creates a manual session with the team's %s default",
    async (visibility) => {
      await env.DB.prepare("UPDATE teams SET default_visibility = ? WHERE id = ?")
        .bind(visibility, TEAM)
        .run();
      const row = await saveAutomation(`auto-session-${visibility}`);
      if (visibility === "private") {
        await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
          .bind(TEAM, EXECUTOR)
          .run();
        expect(await authorized(row.id)).toBe(false);
      }
      await createScheduler().trigger(row.id, MEMBER);
      await expectLaunchedSession(row.id, TEAM, visibility, MEMBER);
    }
  );

  it("keeps workspace sessions workspace-owned despite archived memberships", async () => {
    await env.DB.prepare(
      "UPDATE teams SET default_visibility = 'private', archived_at = 2 WHERE id = ?"
    )
      .bind(TEAM)
      .run();
    const row = await saveAutomation("auto-workspace-session", null);
    await createScheduler().trigger(row.id, MEMBER);
    await expectLaunchedSession(row.id, null, "workspace", MEMBER);
  });
});
