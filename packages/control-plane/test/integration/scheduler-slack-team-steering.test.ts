import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import type { SlackAutomationEvent } from "@open-inspect/shared/triggers";
import { AuthorizationService } from "../../src/authorization/service";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { SessionIndexStore } from "../../src/db/session-index";
import { SlackChannelStore } from "../../src/db/slack-channel-store";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { Scheduler } from "../../src/scheduler/scheduler";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, sqlDatabase } from "./helpers";
import { fetchRuns, makeRunRow, seedRun } from "./run-helpers";

const SESSION_OWNER = "11111111111111111111111111111111";
const MEMBER = "22222222222222222222222222222222";
const OUTSIDER = "33333333333333333333333333333333";
const ADMIN = "44444444444444444444444444444444";
const WORKSPACE_OWNER = "55555555555555555555555555555555";
const SESSION_TEAM = "team_slack_session";
const AUTOMATION_TEAM = "team_slack_automation";
const THREAD_KEY = "slack:C1:steering-root";
const MODES = ["off", "shadow", "on"] as const;

function slackEvent(actorUserId: string): SlackAutomationEvent {
  const ts = `${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
  return {
    source: "slack",
    eventType: "message.posted",
    triggerKey: `slack:msg:C1:${ts}`,
    concurrencyKey: THREAD_KEY,
    contextBlock: "Slack steering fixture",
    meta: {},
    channelId: "C1",
    threadTs: "steering-root",
    ts,
    actorUserId: `U-${actorUserId}`,
    // Match the new-run condition too, so a denial must not fall through to a fresh firing.
    text: "deploy and also update the changelog",
  };
}

function createSteeringScheduler(mode: (typeof MODES)[number]) {
  const requests = vi.fn(async (request: Request, _sessionId: string) => {
    expect(new URL(request.url).pathname).toBe("/internal/prompt");
    return Response.json({ messageId: "msg-steering", status: "queued" });
  });
  const schedulerEnv = createCloudflareEnv({ ...env, TEAMS_ENFORCEMENT: mode });
  // Real D1 authorization and admission; only prompt dispatch is replaced, with no sandbox spawn.
  schedulerEnv.SESSION = (sessionId, request) => requests(request, sessionId);
  return {
    scheduler: new Scheduler(env.DB, schedulerEnv, { submit() {} }),
    requests,
  };
}

async function seedSteerableSession({
  automationId = "auto-steering",
  sessionId = "session-steering",
  ownerTeamId = SESSION_TEAM,
  visibility = "private",
  userId = SESSION_OWNER,
}: {
  automationId?: string;
  sessionId?: string;
  ownerTeamId?: string | null;
  visibility?: SessionVisibility;
  userId?: string;
} = {}) {
  const now = Date.now();
  const automation: AutomationRow = {
    id: automationId,
    owner_team_id: AUTOMATION_TEAM,
    name: "Slack team steering",
    instructions: "Fixture only",
    trigger_type: "slack_event",
    schedule_cron: null,
    schedule_tz: "UTC",
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: SESSION_OWNER,
    user_id: SESSION_OWNER,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: "message.posted",
    trigger_config: JSON.stringify({
      conditions: [
        { type: "slack_channel", operator: "any_of", value: ["C1"] },
        { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
      ],
    }),
    trigger_auth_data: null,
  };
  await new AutomationStore(env.DB).create(automation);
  await sqlDatabase(env.DB).batch(
    new SlackChannelStore(env.DB).bindChannelStatements(automationId, ["C1"])
  );
  await new SessionIndexStore(env.DB).create({
    id: sessionId,
    title: "Existing thread session",
    ownerTeamId,
    visibility,
    userId,
    repoOwner: null,
    repoName: null,
    baseBranch: null,
    model: automation.model,
    reasoningEffort: null,
    status: "completed",
    automationId,
    automationRunId: `run-${sessionId}`,
    spawnSource: "automation",
    createdAt: now,
    updatedAt: now,
  });
  await seedRun(
    makeRunRow(automationId, {
      id: `run-${sessionId}`,
      session_id: sessionId,
      status: "completed",
      completed_at: now,
    }),
    { concurrencyKey: THREAD_KEY }
  );
  return { automationId, sessionId };
}

async function assignCollaborationOnlyRole(userId: string) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO roles (id, key, name, normalized_name, description, is_system)
       VALUES ('role_steering_collaboration_only', NULL, 'Steering Collaboration Only',
         'steering collaboration only', NULL, 0)`
    ),
    env.DB.prepare(
      `INSERT INTO role_permissions (role_id, permission_id)
       VALUES ('role_steering_collaboration_only', 'sessions.collaborate')`
    ),
    env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_steering_collaboration_only' WHERE user_id = ?"
    ).bind(userId),
  ]);
}

async function expectOriginalRunOnly(automationId: string) {
  expect(await fetchRuns(automationId)).toEqual([expect.objectContaining({ status: "completed" })]);
  const store = new AutomationStore(env.DB);
  const { invocations } = await store.listInvocations(automationId, { limit: 20, offset: 0 });
  expect(invocations).toHaveLength(1);
  expect(await store.getById(automationId)).toMatchObject({
    enabled: 1,
    consecutive_failures: 0,
  });
}

describe("Scheduler Slack team steering (real D1)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [SESSION_OWNER, MEMBER, OUTSIDER, ADMIN, WORKSPACE_OWNER]) {
      await seedActiveUser(userId);
      await env.DB.prepare(
        `INSERT INTO user_identities
          (id, user_id, provider, provider_user_id, provider_issuer, created_at, updated_at)
         VALUES (?, ?, 'slack', ?, 'https://slack.com', 1, 1)`
      )
        .bind(`identity-${userId}`, userId, `U-${userId}`)
        .run();
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
        BUILT_IN_ROLE_REGISTRY.administrator.id,
        ADMIN
      ),
      env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
        BUILT_IN_ROLE_REGISTRY.owner.id,
        WORKSPACE_OWNER
      ),
      ...[SESSION_TEAM, AUTOMATION_TEAM].map((teamId) =>
        env.DB.prepare(
          "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)"
        ).bind(teamId, teamId, teamId)
      ),
      ...[SESSION_OWNER, MEMBER, ADMIN, WORKSPACE_OWNER].map((userId) =>
        env.DB.prepare(
          "INSERT INTO team_memberships (team_id, user_id, role, created_at) VALUES (?, ?, 'member', 1)"
        ).bind(SESSION_TEAM, userId)
      ),
      ...[SESSION_OWNER, OUTSIDER].map((userId) =>
        env.DB.prepare(
          "INSERT INTO team_memberships (team_id, user_id, role, created_at) VALUES (?, ?, 'member', 1)"
        ).bind(AUTOMATION_TEAM, userId)
      ),
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  const cases: Array<{
    name: string;
    actor: string;
    visibility?: SessionVisibility;
    ownerTeamId?: string | null;
    collaborator?: boolean;
    departed?: boolean;
    allowed: boolean;
  }> = [
    { name: "private session owner", actor: SESSION_OWNER, allowed: true },
    { name: "private member collaborator", actor: MEMBER, collaborator: true, allowed: true },
    { name: "private outsider", actor: OUTSIDER, allowed: false },
    { name: "private member without collaboration", actor: MEMBER, allowed: false },
    { name: "private administrator without collaboration", actor: ADMIN, allowed: false },
    {
      name: "private workspace owner with only break-glass access",
      actor: WORKSPACE_OWNER,
      allowed: false,
    },
    {
      name: "private stale collaborator",
      actor: MEMBER,
      collaborator: true,
      departed: true,
      allowed: false,
    },
    { name: "private departed owner", actor: SESSION_OWNER, departed: true, allowed: false },
    { name: "team member", actor: MEMBER, visibility: "team", allowed: true },
    { name: "team outsider", actor: OUTSIDER, visibility: "team", allowed: false },
    {
      name: "team nonmember administrator",
      actor: ADMIN,
      visibility: "team",
      departed: true,
      allowed: false,
    },
    {
      name: "team nonmember workspace owner",
      actor: WORKSPACE_OWNER,
      visibility: "team",
      departed: true,
      allowed: false,
    },
    {
      name: "team-owned workspace session member",
      actor: MEMBER,
      visibility: "workspace",
      allowed: true,
    },
    {
      name: "team-owned workspace session outsider",
      actor: OUTSIDER,
      visibility: "workspace",
      allowed: false,
    },
    {
      name: "workspace-private owner",
      actor: SESSION_OWNER,
      ownerTeamId: null,
      allowed: true,
    },
    {
      name: "workspace-private collaborator",
      actor: MEMBER,
      ownerTeamId: null,
      collaborator: true,
      allowed: true,
    },
  ];

  describe.each(MODES)("%s mode", (mode) => {
    it.each(cases)("checks collaboration authority for $name", async (testCase) => {
      const { automationId, sessionId } = await seedSteerableSession({
        ownerTeamId: testCase.ownerTeamId === undefined ? SESSION_TEAM : testCase.ownerTeamId,
        visibility: testCase.visibility ?? "private",
      });
      if (testCase.collaborator) {
        await new SessionCollaboratorStore(env.DB).add(sessionId, testCase.actor, SESSION_OWNER);
      }
      if (testCase.departed) {
        await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
          .bind(SESSION_TEAM, testCase.actor)
          .run();
      }
      const sessionGet = vi.spyOn(SessionIndexStore.prototype, "get");
      const { scheduler, requests } = createSteeringScheduler(mode);

      expect(await scheduler.event(slackEvent(testCase.actor))).toEqual({
        triggered: 0,
        skipped: 0,
        steered: testCase.allowed ? 1 : 0,
      });
      expect(sessionGet).toHaveBeenCalledTimes(1);
      expect(sessionGet).toHaveBeenCalledWith(sessionId);
      expect(requests).toHaveBeenCalledTimes(testCase.allowed ? 1 : 0);
      if (testCase.allowed) {
        expect(requests.mock.calls[0][1]).toBe(sessionId);
        expect(await requests.mock.calls[0][0].json()).toMatchObject({
          source: "slack",
          authorId: `slack:U-${testCase.actor}`,
          canonicalUserId: testCase.actor,
        });
      }
      if (testCase.actor === WORKSPACE_OWNER && testCase.visibility === undefined) {
        const audits = await env.DB.prepare(
          `SELECT principal_kind, actor_user_id_snapshot, resource_id, team_id
           FROM authorization_audit_events WHERE action = 'session.private_break_glass'`
        ).all();
        expect(audits.results).toEqual([
          {
            principal_kind: "user",
            actor_user_id_snapshot: WORKSPACE_OWNER,
            resource_id: sessionId,
            team_id: SESSION_TEAM,
          },
        ]);
      }
      await expectOriginalRunOnly(automationId);
    });

    it.each(["team", "private"] as const)(
      "denies global collaborate without read on a %s session",
      async (visibility) => {
        const { automationId, sessionId } = await seedSteerableSession({ visibility });
        await assignCollaborationOnlyRole(SESSION_OWNER);
        const sessionGet = vi.spyOn(SessionIndexStore.prototype, "get");
        const { scheduler, requests } = createSteeringScheduler(mode);

        expect(await scheduler.event(slackEvent(SESSION_OWNER))).toEqual({
          triggered: 0,
          skipped: 0,
          steered: 0,
        });
        expect(sessionGet).toHaveBeenCalledTimes(1);
        expect(sessionGet).toHaveBeenCalledWith(sessionId);
        expect(requests).not.toHaveBeenCalled();
        await expectOriginalRunOnly(automationId);
      }
    );

    it("preserves legacy workspace collaboration-only steering unless enforcement is on", async () => {
      const { automationId } = await seedSteerableSession({
        ownerTeamId: null,
        visibility: "workspace",
      });
      await assignCollaborationOnlyRole(MEMBER);
      const { scheduler, requests } = createSteeringScheduler(mode);

      expect(await scheduler.event(slackEvent(MEMBER))).toEqual({
        triggered: 0,
        skipped: 0,
        steered: mode === "on" ? 0 : 1,
      });
      expect(requests).toHaveBeenCalledTimes(mode === "on" ? 0 : 1);
      await expectOriginalRunOnly(automationId);
    });

    it.each(["suspended", "role revoked", "owner departed", "collaborator departed"])(
      "revalidates successive events after the actor is %s",
      async (scenario) => {
        const { automationId, sessionId } = await seedSteerableSession();
        const actor = scenario === "collaborator departed" ? MEMBER : SESSION_OWNER;
        if (actor === MEMBER) {
          await new SessionCollaboratorStore(env.DB).add(sessionId, actor, SESSION_OWNER);
        }
        const authorization = vi.spyOn(AuthorizationService.prototype, "getEffectiveAuthorization");
        const sessionGet = vi.spyOn(SessionIndexStore.prototype, "get");
        const { scheduler, requests } = createSteeringScheduler(mode);
        expect(await scheduler.event(slackEvent(actor))).toEqual({
          triggered: 0,
          skipped: 0,
          steered: 1,
        });
        expect(authorization).toHaveBeenCalledTimes(1);
        expect(sessionGet).toHaveBeenCalledTimes(1);
        sessionGet.mockClear();
        if (scenario === "suspended") {
          await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(actor).run();
        } else if (scenario === "role revoked") {
          await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
            .bind(BUILT_IN_ROLE_REGISTRY.viewer.id, actor)
            .run();
        } else {
          await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
            .bind(SESSION_TEAM, actor)
            .run();
        }

        expect(await scheduler.event(slackEvent(actor))).toEqual({
          triggered: 0,
          skipped: 0,
          steered: 0,
        });
        expect(authorization).toHaveBeenCalledTimes(2);
        expect(authorization).toHaveBeenCalledWith(actor);
        if (scenario === "suspended" || scenario === "role revoked") {
          expect(sessionGet).not.toHaveBeenCalled();
        } else {
          expect(sessionGet).toHaveBeenCalledTimes(1);
          expect(sessionGet).toHaveBeenCalledWith(sessionId);
        }
        expect(requests).toHaveBeenCalledTimes(1);
        if (actor === MEMBER) {
          expect(await new SessionCollaboratorStore(env.DB).listUserIds(sessionId)).toEqual([
            actor,
          ]);
        }
        await expectOriginalRunOnly(automationId);
      }
    );

    it.each([
      { name: "owner", actor: SESSION_OWNER, collaborator: false, departed: false, allowed: true },
      {
        name: "member collaborator",
        actor: MEMBER,
        collaborator: true,
        departed: false,
        allowed: true,
      },
      { name: "outsider", actor: OUTSIDER, collaborator: false, departed: false, allowed: false },
      {
        name: "departed owner",
        actor: SESSION_OWNER,
        collaborator: false,
        departed: true,
        allowed: false,
      },
      {
        name: "stale collaborator",
        actor: MEMBER,
        collaborator: true,
        departed: true,
        allowed: false,
      },
    ])("keeps archived-team steering session-scoped for $name", async (testCase) => {
      const { automationId, sessionId } = await seedSteerableSession();
      if (testCase.collaborator) {
        await new SessionCollaboratorStore(env.DB).add(sessionId, testCase.actor, SESSION_OWNER);
      }
      if (testCase.departed) {
        await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
          .bind(SESSION_TEAM, testCase.actor)
          .run();
      }
      await env.DB.prepare("UPDATE teams SET archived_at = 1 WHERE id IN (?, ?)")
        .bind(SESSION_TEAM, AUTOMATION_TEAM)
        .run();
      const { scheduler, requests } = createSteeringScheduler(mode);

      expect(await scheduler.event(slackEvent(testCase.actor))).toEqual({
        triggered: 0,
        skipped: 0,
        steered: testCase.allowed ? 1 : 0,
      });
      expect(requests).toHaveBeenCalledTimes(testCase.allowed ? 1 : 0);
      await expectOriginalRunOnly(automationId);
    });

    it("does not cache admission across distinct candidate sessions", async () => {
      const targets = [
        { automationId: "auto-allowed", sessionId: "session-allowed", ownerTeamId: SESSION_TEAM },
        {
          automationId: "auto-private-denied",
          sessionId: "session-private-denied",
          ownerTeamId: SESSION_TEAM,
        },
        {
          automationId: "auto-team-denied",
          sessionId: "session-team-denied",
          ownerTeamId: AUTOMATION_TEAM,
        },
      ];
      for (const target of targets) {
        await seedSteerableSession(target);
      }
      const collaborators = new SessionCollaboratorStore(env.DB);
      await collaborators.add("session-allowed", MEMBER, SESSION_OWNER);
      await collaborators.add("session-team-denied", MEMBER, SESSION_OWNER);
      const authorization = vi.spyOn(AuthorizationService.prototype, "getEffectiveAuthorization");
      const memberships = vi.spyOn(TeamMembershipStore.prototype, "listForUser");
      const sessionGet = vi.spyOn(SessionIndexStore.prototype, "get");
      const { scheduler, requests } = createSteeringScheduler(mode);

      expect(await scheduler.event(slackEvent(MEMBER))).toEqual({
        triggered: 0,
        skipped: 0,
        steered: 1,
      });
      expect(requests).toHaveBeenCalledTimes(1);
      expect(requests.mock.calls[0][1]).toBe("session-allowed");
      expect(authorization).toHaveBeenCalledTimes(1);
      expect(authorization).toHaveBeenCalledWith(MEMBER);
      expect(memberships).toHaveBeenCalledTimes(1);
      expect(memberships).toHaveBeenCalledWith(MEMBER);
      expect(sessionGet).toHaveBeenCalledTimes(targets.length);
      for (const target of targets) {
        expect(sessionGet).toHaveBeenCalledWith(target.sessionId);
        await expectOriginalRunOnly(target.automationId);
      }
    });
  });
});
