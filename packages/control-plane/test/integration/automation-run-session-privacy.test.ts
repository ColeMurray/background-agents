import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type {
  AutomationInvocation,
  AutomationRun,
  ListAutomationInvocationsResponse,
} from "@open-inspect/shared/types/automations";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, serviceFetch, type ServiceRequestInit } from "./helpers";

const SESSION_OWNER = "11111111111111111111111111111111";
const MEMBER = "22222222222222222222222222222222";
const LEAD = "33333333333333333333333333333333";
const ADMIN = "44444444444444444444444444444444";
const WORKSPACE_OWNER = "55555555555555555555555555555555";
const COLLABORATOR = "66666666666666666666666666666666";
const AUTOMATION_TEAM = "team_automation_privacy";
const SESSION_TEAM = "team_session_privacy";
const AUTOMATION_ID = "auto-session-privacy";
const INVOCATION_ID = "inv-session-privacy";
const PRIVATE_SESSION = "private-linked-session";
const VISIBLE_SESSION = "visible-linked-session";

const privateRun: AutomationRun = {
  id: "run-private",
  automationId: AUTOMATION_ID,
  invocationId: INVOCATION_ID,
  sessionId: PRIVATE_SESSION,
  status: "completed",
  skipReason: null,
  failureReason: null,
  scheduledAt: 1000,
  startedAt: 1100,
  completedAt: 2000,
  createdAt: 1000,
  sessionTitle: "Confidential linked session",
  artifactSummary: null,
  repoOwner: "group/subgroup",
  repoName: "private-target",
  repoId: 41,
  baseBranch: "release",
  environmentId: "env_private_run_snapshot",
};
const visibleRun: AutomationRun = {
  ...privateRun,
  id: "run-visible",
  sessionId: VISIBLE_SESSION,
  sessionTitle: "Visible linked session",
  repoName: "visible-target",
  repoId: 42,
  baseBranch: "main",
  environmentId: "env_visible_run_snapshot",
  completedAt: 2100,
  createdAt: 1001,
};
const invocation: AutomationInvocation = {
  id: INVOCATION_ID,
  automationId: AUTOMATION_ID,
  status: "completed",
  source: "schedule",
  scheduledAt: 1000,
  skipReason: null,
  createdAt: 1000,
  completedAt: 2100,
  runs: [privateRun, visibleRun],
};

function request(suffix: string, init: ServiceRequestInit) {
  return serviceFetch(`https://cp.test/automations/${AUTOMATION_ID}${suffix}`, init);
}

async function breakGlassAudits() {
  return (
    await env.DB.prepare(
      `SELECT principal_kind, actor_user_id_snapshot, resource_type, resource_id,
              team_id, reason_code, operation_result, request_id
       FROM authorization_audit_events WHERE action = 'session.private_break_glass'`
    ).all()
  ).results;
}

async function expectHistory(
  init: ServiceRequestInit,
  { privateReadable = false, visibleReadable = true } = {}
) {
  const runs = [privateRun, visibleRun].map((run, index) =>
    (index === 0 ? privateReadable : visibleReadable)
      ? run
      : { ...run, sessionId: null, sessionTitle: null, artifactSummary: null }
  );
  const listed = await request("/invocations", init);
  expect(listed.status).toBe(200);
  expect(await listed.json<ListAutomationInvocationsResponse>()).toEqual({
    invocations: [{ ...invocation, runs }],
    total: 1,
  });
  for (const run of runs) {
    const item = await request(`/runs/${run.id}`, init);
    expect(item.status).toBe(200);
    expect(await item.json<{ run: AutomationRun }>()).toEqual({ run });
  }
}

describe("automation run linked session privacy (real D1)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [SESSION_OWNER, MEMBER, LEAD, ADMIN, WORKSPACE_OWNER, COLLABORATOR]) {
      await seedActiveUser(userId);
    }
    await env.DB.batch([
      ...[ADMIN, WORKSPACE_OWNER].map((userId) =>
        env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
          BUILT_IN_ROLE_REGISTRY[userId === ADMIN ? "administrator" : "owner"].id,
          userId
        )
      ),
      ...[AUTOMATION_TEAM, SESSION_TEAM].map((teamId) =>
        env.DB.prepare(
          "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)"
        ).bind(teamId, teamId, teamId)
      ),
      ...[AUTOMATION_TEAM, SESSION_TEAM].flatMap((teamId) =>
        [SESSION_OWNER, MEMBER, LEAD, ADMIN, COLLABORATOR].map((userId) =>
          env.DB.prepare(
            "INSERT INTO team_memberships (team_id, user_id, role, created_at) VALUES (?, ?, ?, 1)"
          ).bind(teamId, userId, userId === LEAD ? "lead" : "member")
        )
      ),
    ]);
    const automation: AutomationRow = {
      id: AUTOMATION_ID,
      owner_team_id: AUTOMATION_TEAM,
      name: "Session metadata privacy",
      instructions: "Fixture only; never execute",
      trigger_type: "schedule",
      schedule_cron: "0 9 * * *",
      schedule_tz: "UTC",
      harness: "opencode",
      model: "anthropic/claude-sonnet-4-6",
      reasoning_effort: null,
      enabled: 1,
      next_run_at: null,
      consecutive_failures: 0,
      created_by: SESSION_OWNER,
      user_id: SESSION_OWNER,
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null,
      event_type: null,
      trigger_config: null,
      trigger_auth_data: null,
    };
    const store = new AutomationStore(env.DB);
    await store.create(automation);
    // Seed only the persisted index. No session DO, prompt, or sandbox is created.
    const index = new SessionIndexStore(env.DB);
    for (const run of [privateRun, visibleRun]) {
      await index.create({
        id: run.sessionId!,
        title: run.sessionTitle,
        userId: SESSION_OWNER,
        ownerTeamId: run === privateRun ? SESSION_TEAM : null,
        visibility: run === privateRun ? "private" : "workspace",
        repoOwner: "different-session-repo",
        repoName: "not-the-run-snapshot",
        baseBranch: "different-session-branch",
        environmentId: null,
        model: automation.model,
        reasoningEffort: null,
        status: "completed",
        automationId: AUTOMATION_ID,
        automationRunId: run.id,
        spawnSource: "automation",
        createdAt: run.createdAt,
        updatedAt: run.completedAt!,
      });
    }
    const inserted = await store.insertInvocationGuarded({
      invocation: {
        id: INVOCATION_ID,
        automation_id: AUTOMATION_ID,
        source: "schedule",
        scheduled_at: 1000,
        trigger_key: null,
        concurrency_key: null,
        trigger_metadata: null,
        skip_reason: null,
        failure_counted_at: null,
        created_at: 1000,
        updated_at: 2100,
      },
      children: [privateRun, visibleRun].map((run) => ({
        id: run.id,
        automation_id: AUTOMATION_ID,
        invocation_id: INVOCATION_ID,
        session_id: run.sessionId,
        status: run.status,
        skip_reason: run.skipReason,
        failure_reason: run.failureReason,
        scheduled_at: run.scheduledAt,
        started_at: run.startedAt,
        execution_deadline_at: 3000,
        completed_at: run.completedAt,
        created_at: run.createdAt,
        repo_owner: run.repoOwner,
        repo_name: run.repoName,
        repo_id: run.repoId,
        base_branch: run.baseBranch,
        environment_id: run.environmentId,
      })),
      overlapScope: { kind: "automation" },
    });
    expect(inserted.inserted).toBe(true);
  });
  afterEach(cleanD1Tables);

  it.each([
    { name: "team member", userId: MEMBER, role: "member" as const },
    { name: "team lead", userId: LEAD, role: "member" as const },
    { name: "workspace administrator", userId: ADMIN, role: "administrator" as const },
  ])("redacts private metadata for an ordinary $name", async ({ userId, role }) => {
    await expectHistory({ as: { userId, role } });
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("redacts private metadata for an actorless Slack bot", async () => {
    await expectHistory({ service: "slack-bot" });
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("requires sessions.read even for the session owner with automations.read", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, is_system)
         VALUES ('role_run_privacy', NULL, 'Run Privacy', 'run privacy', 0)`
      ),
      env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ('role_run_privacy', 'automations.read')`
      ),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_run_privacy' WHERE user_id = ?"
      ).bind(SESSION_OWNER),
    ]);

    await expectHistory(
      { as: { userId: SESSION_OWNER, role: "member" } },
      { visibleReadable: false }
    );
    expect(await breakGlassAudits()).toEqual([]);
  });

  it.each(["session owner", "current team collaborator"])(
    "preserves private metadata for the %s without break-glass",
    async (viewer) => {
      const userId = viewer === "session owner" ? SESSION_OWNER : COLLABORATOR;
      if (userId === COLLABORATOR) {
        await new SessionCollaboratorStore(env.DB).add(
          PRIVATE_SESSION,
          COLLABORATOR,
          SESSION_OWNER
        );
      }
      await expectHistory({ as: { userId, role: "member" } }, { privateReadable: true });
      expect(await breakGlassAudits()).toEqual([]);
    }
  );

  it("ignores a stale collaborator grant after departure from the session's team", async () => {
    const collaborators = new SessionCollaboratorStore(env.DB);
    await collaborators.add(PRIVATE_SESSION, COLLABORATOR, SESSION_OWNER);
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(SESSION_TEAM, COLLABORATOR)
      .run();
    expect(await collaborators.listUserIds(PRIVATE_SESSION)).toEqual([COLLABORATOR]);

    await expectHistory({ as: { userId: COLLABORATOR, role: "member" } });
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("nulls a dangling session link after the persisted session row is removed", async () => {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(PRIVATE_SESSION).run();
    const stored = await env.DB.prepare("SELECT session_id FROM automation_runs WHERE id = ?")
      .bind(privateRun.id)
      .first();
    expect(stored).toEqual({ session_id: PRIVATE_SESSION });

    await expectHistory({ as: { userId: SESSION_OWNER, role: "member" } });
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("preserves metadata for a visible team session as well as workspace sessions", async () => {
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ?, visibility = 'team' WHERE id = ?")
      .bind(SESSION_TEAM, VISIBLE_SESSION)
      .run();

    await expectHistory({ as: { userId: MEMBER, role: "member" } });
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("does not substitute automation team membership for the linked session's membership", async () => {
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ?, visibility = 'team' WHERE id = ?")
      .bind(SESSION_TEAM, VISIBLE_SESSION)
      .run();
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(SESSION_TEAM, MEMBER)
      .run();

    await expectHistory({ as: { userId: MEMBER, role: "member" } }, { visibleReadable: false });
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("does not enumerate Owner break-glass metadata or audit it in the invocation list", async () => {
    const listed = await request("/invocations", {
      as: { userId: WORKSPACE_OWNER, role: "owner" },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json<ListAutomationInvocationsResponse>()).toEqual({
      invocations: [
        {
          ...invocation,
          runs: [
            { ...privateRun, sessionId: null, sessionTitle: null, artifactSummary: null },
            visibleRun,
          ],
        },
      ],
      total: 1,
    });
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("preserves a workspace Owner's own private metadata without break-glass", async () => {
    await env.DB.prepare("UPDATE sessions SET user_id = ? WHERE id = ?")
      .bind(WORKSPACE_OWNER, PRIVATE_SESSION)
      .run();

    await expectHistory(
      { as: { userId: WORKSPACE_OWNER, role: "owner" } },
      { privateReadable: true }
    );
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("audits each Owner break-glass item read that discloses private metadata", async () => {
    for (let read = 0; read < 2; read++) {
      const item = await request(`/runs/${privateRun.id}`, {
        as: { userId: WORKSPACE_OWNER, role: "owner" },
      });
      expect(item.status).toBe(200);
      expect(await item.json<{ run: AutomationRun }>()).toEqual({ run: privateRun });
      const audits = await breakGlassAudits();
      expect(audits).toHaveLength(read + 1);
      for (const audit of audits) {
        expect(audit).toEqual({
          principal_kind: "user",
          actor_user_id_snapshot: WORKSPACE_OWNER,
          resource_type: "session",
          resource_id: PRIVATE_SESSION,
          team_id: SESSION_TEAM,
          reason_code: "session.private_break_glass",
          operation_result: "applied",
          request_id: expect.any(String),
        });
      }
      expect(new Set(audits.map((audit) => audit.request_id)).size).toBe(read + 1);
    }
  });
});
