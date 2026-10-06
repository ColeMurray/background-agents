import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type {
  AutomationRun,
  ListAutomationInvocationsResponse,
} from "@open-inspect/shared/types/automations";
import { toAutomationRun } from "../../src/db/automation-store";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, serviceFetch, type ServiceRequestInit } from "./helpers";
import { makeRunRow, seedRun } from "./run-helpers";
import { assignCustomRole, seedTeam } from "./ownership-test-helpers";

const SESSION_OWNER = "11111111111111111111111111111111";
const MEMBER = "22222222222222222222222222222222";
const ADMIN = "44444444444444444444444444444444";
const WORKSPACE_OWNER = "55555555555555555555555555555555";
const COLLABORATOR = "66666666666666666666666666666666";
const AUTOMATION_TEAM = "team_automation_privacy";
const SESSION_TEAM = "team_session_privacy";
const AUTOMATION_ID = "auto-session-privacy";
const INVOCATION_ID = "inv-session-privacy";
const PRIVATE_SESSION = "private-linked-session";
const VISIBLE_SESSION = "visible-linked-session";
const privateRow = makeRunRow(AUTOMATION_ID, {
  id: "run-private",
  invocation_id: INVOCATION_ID,
  session_id: PRIVATE_SESSION,
  status: "completed",
  scheduled_at: 1000,
  started_at: 1100,
  completed_at: 2000,
  created_at: 1000,
  repo_owner: "group/subgroup",
  repo_name: "private-target",
  repo_id: 41,
  base_branch: "release",
  environment_id: "env_private_run_snapshot",
});
const visibleRow = {
  ...privateRow,
  id: "run-visible",
  session_id: VISIBLE_SESSION,
  repo_name: "visible-target",
  repo_id: 42,
  base_branch: "main",
  environment_id: "env_visible_run_snapshot",
  completed_at: 2100,
  created_at: 1001,
};
const privateRun = toAutomationRun({
  ...privateRow,
  session_title: "Confidential linked session",
  artifact_summary: null,
});
const visibleRun = toAutomationRun({
  ...visibleRow,
  session_title: "Visible linked session",
  artifact_summary: null,
});
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
  expect(await listed.json<ListAutomationInvocationsResponse>()).toMatchObject({
    invocations: [{ id: INVOCATION_ID, runs }],
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
    for (const userId of [SESSION_OWNER, MEMBER, ADMIN, WORKSPACE_OWNER, COLLABORATOR])
      await seedActiveUser(userId);
    await env.DB.batch([
      ...[ADMIN, WORKSPACE_OWNER].map((userId) =>
        env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
          BUILT_IN_ROLE_REGISTRY[userId === ADMIN ? "administrator" : "owner"].id,
          userId
        )
      ),
    ]);
    for (const teamId of [AUTOMATION_TEAM, SESSION_TEAM]) {
      await seedTeam(teamId, [
        [SESSION_OWNER, "member"],
        [MEMBER, "member"],
        [ADMIN, "member"],
        [COLLABORATOR, "member"],
      ]);
    }
    await env.DB.prepare(
      `INSERT INTO automations (id, owner_team_id, name, instructions, model, created_by, user_id, created_at, updated_at)
       VALUES (?, ?, 'Session privacy', 'Fixture only; never execute', 'anthropic/claude-sonnet-4-6', ?, ?, 1000, 1000)`
    )
      .bind(AUTOMATION_ID, AUTOMATION_TEAM, SESSION_OWNER, SESSION_OWNER)
      .run();
    for (const [row, run] of [
      [privateRow, privateRun],
      [visibleRow, visibleRun],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO sessions
           (id, title, user_id, owner_team_id, visibility, repo_owner, repo_name, base_branch,
            status, automation_id, automation_run_id, spawn_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'different-session-repo', 'not-the-run-snapshot', 'different-session-branch',
           'completed', ?, ?, 'automation', ?, ?)`
      )
        .bind(
          row.session_id,
          run.sessionTitle,
          SESSION_OWNER,
          row === privateRow ? SESSION_TEAM : null,
          row === privateRow ? "private" : "workspace",
          AUTOMATION_ID,
          row.id,
          row.created_at,
          row.completed_at
        )
        .run();
      await seedRun(row);
    }
  });
  afterEach(cleanD1Tables);

  it("redacts private links for ordinary administrators", async () => {
    await expectHistory({ as: { userId: ADMIN, role: "administrator" } });
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("redacts private metadata for an actorless Slack bot", async () => {
    await expectHistory({ service: "slack-bot" });
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("requires sessions.read even for the session owner with automations.read", async () => {
    await assignCustomRole(SESSION_OWNER, ["automations.read"]);
    await expectHistory(
      { as: { userId: SESSION_OWNER, role: "member" } },
      { visibleReadable: false }
    );
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("preserves private metadata for the session owner without break-glass", async () => {
    await expectHistory(
      { as: { userId: SESSION_OWNER, role: "member" } },
      { privateReadable: true }
    );
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("rechecks collaborator disclosure after membership removal", async () => {
    const collaborators = new SessionCollaboratorStore(env.DB);
    await collaborators.add(PRIVATE_SESSION, COLLABORATOR, SESSION_OWNER);
    const init: ServiceRequestInit = { as: { userId: COLLABORATOR, role: "member" } };
    await expectHistory(init, { privateReadable: true });
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(SESSION_TEAM, COLLABORATOR)
      .run();
    expect(await collaborators.listUserIds(PRIVATE_SESSION)).toEqual([COLLABORATOR]);
    await expectHistory(init);
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("nulls a dangling session link after the persisted session row is removed", async () => {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(PRIVATE_SESSION).run();
    expect(
      await env.DB.prepare("SELECT session_id FROM automation_runs WHERE id = ?")
        .bind(privateRun.id)
        .first()
    ).toEqual({ session_id: PRIVATE_SESSION });
    await expectHistory({ as: { userId: SESSION_OWNER, role: "member" } });
    expect(await breakGlassAudits()).toEqual([]);
  });

  it("uses the linked session's current team membership for run disclosure", async () => {
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ?, visibility = 'team' WHERE id = ?")
      .bind(SESSION_TEAM, VISIBLE_SESSION)
      .run();
    const init: ServiceRequestInit = { as: { userId: MEMBER, role: "member" } };
    await expectHistory(init);
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(SESSION_TEAM, MEMBER)
      .run();
    await expectHistory(init, { visibleReadable: false });
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

  it("redacts Owner lists but audits each private item disclosure", async () => {
    const init: ServiceRequestInit = { as: { userId: WORKSPACE_OWNER, role: "owner" } };
    const listed = await request("/invocations", init);
    expect(listed.status).toBe(200);
    expect(await listed.json<ListAutomationInvocationsResponse>()).toMatchObject({
      invocations: [
        {
          id: INVOCATION_ID,
          runs: [
            { ...privateRun, sessionId: null, sessionTitle: null, artifactSummary: null },
            visibleRun,
          ],
        },
      ],
      total: 1,
    });
    expect(await breakGlassAudits()).toEqual([]);
    for (let read = 0; read < 2; read++) {
      const item = await request(`/runs/${privateRun.id}`, init);
      expect(item.status).toBe(200);
      expect(await item.json<{ run: AutomationRun }>()).toEqual({ run: privateRun });
      const audits = await breakGlassAudits();
      expect(audits).toHaveLength(read + 1);
      for (const audit of audits)
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
      expect(new Set(audits.map((audit) => audit.request_id)).size).toBe(read + 1);
    }
  });
});
