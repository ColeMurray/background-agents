import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import type { SlackAutomationEvent } from "@open-inspect/shared/triggers";
import { AuthorizationService } from "../../src/authorization/service";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { AutomationStore } from "../../src/db/automation-store";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { SessionIndexStore } from "../../src/db/session-index";
import { SlackChannelStore } from "../../src/db/slack-channel-store";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { Scheduler } from "../../src/scheduler/scheduler";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser } from "./helpers";
import { fetchRuns, makeRunRow, seedRun } from "./run-helpers";
import { assignCustomRole, seedTeam } from "./ownership-test-helpers";

const SESSION_OWNER = "11111111111111111111111111111111";
const MEMBER = "22222222222222222222222222222222";
const WORKSPACE_OWNER = "55555555555555555555555555555555";
const SESSION_TEAM = "team_slack_session";
const AUTOMATION_TEAM = "team_slack_automation";
const THREAD_KEY = "slack:C1:steering-root";

function slackEvent(actor: string): SlackAutomationEvent {
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
    actorUserId: `U-${actor}`,
    // Also match the launch condition: a denied steer must not create a replacement run.
    text: "deploy and also update the changelog",
  };
}

function createSteeringScheduler(mode: "off" | "shadow" | "on" = "shadow") {
  const requests = vi.fn(async (request: Request, _sessionId: string) => {
    expect(new URL(request.url).pathname).toBe("/internal/prompt");
    return Response.json({ messageId: "msg-steering", status: "queued" });
  });
  const schedulerEnv = createCloudflareEnv({ ...env, TEAMS_ENFORCEMENT: mode });
  schedulerEnv.SESSION = (sessionId, request) => requests(request, sessionId);
  return { scheduler: new Scheduler(env.DB, schedulerEnv, { submit() {} }), requests };
}

async function seedSteerableSession(
  sessionId = "session-steering",
  ownerTeamId: string | null = SESSION_TEAM,
  visibility: SessionVisibility = "private"
) {
  const automationId = `auto-${sessionId}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO automations
       (id, owner_team_id, name, instructions, trigger_type, model, created_by, user_id,
        created_at, updated_at, event_type, trigger_config)
     VALUES (?, ?, 'Slack steering', 'Fixture only', 'slack_event', 'anthropic/claude-sonnet-4-6',
       ?, ?, ?, ?, 'message.posted', ?)`
  )
    .bind(
      automationId,
      AUTOMATION_TEAM,
      SESSION_OWNER,
      SESSION_OWNER,
      now,
      now,
      JSON.stringify({
        conditions: [
          { type: "slack_channel", operator: "any_of", value: ["C1"] },
          { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
        ],
      })
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO automation_slack_channels (automation_id, channel_id) VALUES (?, 'C1')"
  )
    .bind(automationId)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions
       (id, title, owner_team_id, visibility, user_id, status, automation_id, automation_run_id,
        spawn_source, created_at, updated_at)
     VALUES (?, 'Existing thread session', ?, ?, ?, 'completed', ?, ?, 'automation', ?, ?)`
  )
    .bind(
      sessionId,
      ownerTeamId,
      visibility,
      SESSION_OWNER,
      automationId,
      `run-${sessionId}`,
      now,
      now
    )
    .run();
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

async function expectOriginalRunOnly(automationId: string) {
  expect(await fetchRuns(automationId)).toEqual([expect.objectContaining({ status: "completed" })]);
  const store = new AutomationStore(env.DB);
  expect(
    (await store.listInvocations(automationId, { limit: 20, offset: 0 })).invocations
  ).toHaveLength(1);
  expect(await store.getById(automationId)).toMatchObject({ enabled: 1, consecutive_failures: 0 });
}

describe("Scheduler Slack team steering (real D1)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [SESSION_OWNER, MEMBER, WORKSPACE_OWNER]) {
      await seedActiveUser(userId);
      await env.DB.prepare(
        `INSERT INTO user_identities (id, user_id, provider, provider_user_id, provider_issuer, created_at, updated_at)
         VALUES (?, ?, 'slack', ?, 'https://slack.com', 1, 1)`
      )
        .bind(`identity-${userId}`, userId, `U-${userId}`)
        .run();
    }
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY.owner.id, WORKSPACE_OWNER)
      .run();
    await seedTeam(SESSION_TEAM, [
      [SESSION_OWNER, "member"],
      [MEMBER, "member"],
      [WORKSPACE_OWNER, "member"],
    ]);
    await seedTeam(AUTOMATION_TEAM, [[SESSION_OWNER, "member"]]);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it.each(["team", "private"] as const)(
    "requires sessions.read for %s steering even in off mode",
    async (visibility) => {
      const { automationId, sessionId } = await seedSteerableSession(
        "session-steering",
        SESSION_TEAM,
        visibility
      );
      await assignCustomRole(SESSION_OWNER, ["sessions.collaborate"]);
      const sessionGet = vi.spyOn(SessionIndexStore.prototype, "get");
      const { scheduler, requests } = createSteeringScheduler("off");
      const result = await scheduler.event(slackEvent(SESSION_OWNER));
      expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0 });
      expect(sessionGet).toHaveBeenCalledWith(sessionId);
      expect(requests).not.toHaveBeenCalled();
      await expectOriginalRunOnly(automationId);
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "preserves workspace collaboration-only steering in %s mode",
    async (mode) => {
      const { automationId } = await seedSteerableSession("session-steering", null, "workspace");
      await assignCustomRole(MEMBER, ["sessions.collaborate"]);
      const { scheduler, requests } = createSteeringScheduler(mode);
      const result = await scheduler.event(slackEvent(MEMBER));
      expect(result).toEqual({ triggered: 0, skipped: 0, steered: mode === "on" ? 0 : 1 });
      expect(requests).toHaveBeenCalledTimes(mode === "on" ? 0 : 1);
      await expectOriginalRunOnly(automationId);
    }
  );

  it.each([SESSION_OWNER, MEMBER])(
    "revalidates %s participation across archive and membership removal",
    async (actor) => {
      const { automationId, sessionId } = await seedSteerableSession();
      const collaborators = new SessionCollaboratorStore(env.DB);
      if (actor === MEMBER) await collaborators.add(sessionId, actor, SESSION_OWNER);
      const memberships = vi.spyOn(TeamMembershipStore.prototype, "listForUser");
      const { scheduler, requests } = createSteeringScheduler();
      const initial = await scheduler.event(slackEvent(actor));
      expect(initial).toEqual({ triggered: 0, skipped: 0, steered: 1 });
      await env.DB.prepare("UPDATE teams SET archived_at = 1 WHERE id IN (?, ?)")
        .bind(SESSION_TEAM, AUTOMATION_TEAM)
        .run();
      const archived = await scheduler.event(slackEvent(actor));
      expect(archived).toEqual({ triggered: 0, skipped: 0, steered: 1 });
      await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
        .bind(SESSION_TEAM, actor)
        .run();
      const departed = await scheduler.event(slackEvent(actor));
      expect(departed).toEqual({ triggered: 0, skipped: 0, steered: 0 });
      expect(memberships).toHaveBeenCalledTimes(3);
      expect(requests).toHaveBeenCalledTimes(2);
      expect(await requests.mock.calls[0][0].json()).toMatchObject({
        source: "slack",
        authorId: `slack:U-${actor}`,
        canonicalUserId: actor,
      });
      if (actor === MEMBER) expect(await collaborators.listUserIds(sessionId)).toEqual([actor]);
      await expectOriginalRunOnly(automationId);
    }
  );

  it.each(["suspended", "role revoked"])(
    "revalidates actor authority after %s",
    async (scenario) => {
      const { automationId } = await seedSteerableSession();
      const authorization = vi.spyOn(AuthorizationService.prototype, "getEffectiveAuthorization");
      const sessionGet = vi.spyOn(SessionIndexStore.prototype, "get");
      const { scheduler, requests } = createSteeringScheduler();
      const initial = await scheduler.event(slackEvent(SESSION_OWNER));
      expect(initial).toEqual({ triggered: 0, skipped: 0, steered: 1 });
      sessionGet.mockClear();
      if (scenario === "suspended") {
        await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?")
          .bind(SESSION_OWNER)
          .run();
      } else {
        await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
          .bind(BUILT_IN_ROLE_REGISTRY.viewer.id, SESSION_OWNER)
          .run();
      }
      const revoked = await scheduler.event(slackEvent(SESSION_OWNER));
      expect(revoked).toEqual({ triggered: 0, skipped: 0, steered: 0 });
      expect(authorization).toHaveBeenCalledTimes(2);
      expect(sessionGet).not.toHaveBeenCalled();
      expect(requests).toHaveBeenCalledTimes(1);
      await expectOriginalRunOnly(automationId);
    }
  );

  it("audits Owner break-glass without steering or replacement firing", async () => {
    const { automationId, sessionId } = await seedSteerableSession();
    const { scheduler, requests } = createSteeringScheduler("off");
    const result = await scheduler.event(slackEvent(WORKSPACE_OWNER));
    expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0 });
    expect(requests).not.toHaveBeenCalled();
    const audits = await env.DB.prepare(
      "SELECT principal_kind, actor_user_id_snapshot, resource_id, team_id FROM authorization_audit_events WHERE action = 'session.private_break_glass'"
    ).all();
    expect(audits.results).toEqual([
      {
        principal_kind: "user",
        actor_user_id_snapshot: WORKSPACE_OWNER,
        resource_id: sessionId,
        team_id: SESSION_TEAM,
      },
    ]);
    await expectOriginalRunOnly(automationId);
  });

  it("checks denied, allowed, and foreign-team candidates independently", async () => {
    const targets = [
      await seedSteerableSession("1-denied"),
      await seedSteerableSession("2-allowed"),
      await seedSteerableSession("3-foreign", AUTOMATION_TEAM),
    ];
    const collaborators = new SessionCollaboratorStore(env.DB);
    await collaborators.add("2-allowed", MEMBER, SESSION_OWNER);
    await collaborators.add("3-foreign", MEMBER, SESSION_OWNER);
    // Order the real SQL candidates so one event exercises deny/allow/deny.
    const getCandidates = SlackChannelStore.prototype.getSlackAutomationsForChannel;
    vi.spyOn(SlackChannelStore.prototype, "getSlackAutomationsForChannel").mockImplementation(
      async function (this: SlackChannelStore, channelId) {
        return (await getCandidates.call(this, channelId)).sort((a, b) => a.id.localeCompare(b.id));
      }
    );
    const authorization = vi.spyOn(AuthorizationService.prototype, "getEffectiveAuthorization");
    const memberships = vi.spyOn(TeamMembershipStore.prototype, "listForUser");
    const sessionGet = vi.spyOn(SessionIndexStore.prototype, "get");
    const { scheduler, requests } = createSteeringScheduler();
    const result = await scheduler.event(slackEvent(MEMBER));
    expect(result).toEqual({ triggered: 0, skipped: 0, steered: 1 });
    expect(requests).toHaveBeenCalledTimes(1);
    expect(requests.mock.calls[0][1]).toBe("2-allowed");
    expect(authorization).toHaveBeenCalledTimes(1);
    expect(memberships).toHaveBeenCalledTimes(1);
    expect(sessionGet.mock.calls).toEqual(targets.map(({ sessionId }) => [sessionId]));
    for (const { automationId } of targets) await expectOriginalRunOnly(automationId);
  });
});
