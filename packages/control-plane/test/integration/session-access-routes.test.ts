import { createExecutionContext, env } from "cloudflare:test";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore } from "../../src/db/session-index";
import { TeamChannelBindingStore } from "../../src/db/team-channel-bindings";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";
import {
  initSession,
  queryDO,
  routeRequest,
  seedActiveUser,
  serviceRequestHeaders,
  waitForSandboxStatus,
} from "./helpers";

const BASE = "https://test.local";
const OWNER = "11111111111111111111111111111111";
const MEMBER = "22222222222222222222222222222222";
const CREATOR = "33333333333333333333333333333333";
const SLACK_WRITES = ["prompt", "attachments"] as const;
const SCOPE_REFUSAL = { error: "Slack channel scope denied", code: "slack_channel_scope_denied" };

async function fetchMode(
  path: string,
  mode: string,
  options: {
    method?: string;
    as?: { userId: string; role: "owner" | "administrator" | "member" | "viewer" };
    body?: string;
    service?: "github-bot" | "linear-bot" | "slack-bot";
    actor?: string;
  } = {}
) {
  const url = `${BASE}${path}`;
  const method = options.method ?? "GET";
  return routeRequest(
    new Request(url, {
      method,
      headers: await serviceRequestHeaders(url, {
        method,
        body: options.body,
        as: options.as,
        service: options.service,
        actor: options.actor,
      }),
      body: options.body,
    }),
    { ...env, TEAMS_ENFORCEMENT: mode },
    createExecutionContext()
  );
}

async function slackWrite(
  path: string,
  mode: string,
  options: { actor?: string | null; signedPath?: string } = {}
) {
  const url = `${BASE}${path}`;
  const form = new FormData();
  form.append(
    "file",
    new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "image.png", {
      type: "image/png",
    })
  );
  const upload = new URL(url).pathname.endsWith("/attachments");
  const request = new Request(url, {
    method: "POST",
    headers: upload ? undefined : { "Content-Type": "application/json" },
    body: upload
      ? form
      : JSON.stringify({
          content: "Scope check",
          source: "web",
          callbackContext: {
            source: "slack",
            channel: "C-UNBOUND",
            threadTs: "1.0",
            repoFullName: "acme/web-app",
            model: "anthropic/claude-haiku-4-5",
          },
        }),
  });
  const headers = await buildServiceAuthHeaders({
    service: "slack-bot",
    secret: "test-service-secret-slack-bot",
    method: "POST",
    url: `${BASE}${options.signedPath ?? path}`,
    body: await request.clone().arrayBuffer(),
    actor: options.actor === null ? undefined : (options.actor ?? "slack:U-SCOPE"),
  });
  for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
  return routeRequest(request, { ...env, TEAMS_ENFORCEMENT: mode }, createExecutionContext());
}

async function auditRows(action: string) {
  return (
    await env.DB.prepare(
      "SELECT action, resource_type, resource_id, team_id, reason_code, actor_user_id_snapshot FROM authorization_audit_events WHERE action = ? ORDER BY occurred_at"
    )
      .bind(action)
      .all()
  ).results;
}

describe("HTTP session access by enforcement mode", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    expect((await fetchMode("/me/authorization", "on")).status).toBe(200);
    expect(
      (
        await fetchMode("/me/authorization", "on", {
          as: { userId: MEMBER, role: "member" },
        })
      ).status
    ).toBe(200);
    await seedActiveUser(CREATOR);
  });

  afterEach(() => vi.restoreAllMocks());

  async function session(visibility: "team" | "private" | "workspace") {
    const team = await new TeamStore(env.DB).create({
      slug: `access-${crypto.randomUUID()}`,
      name: "Access Team",
      joinPolicy: "invite_only",
    });
    const { sessionName, stub } = await initSession({ userId: CREATOR });
    await waitForSandboxStatus(stub, "failed");
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ?, visibility = ? WHERE id = ?")
      .bind(team.id, visibility, sessionName)
      .run();
    return { sessionName, team, stub };
  }

  async function otherTeam() {
    return new TeamStore(env.DB).create({
      slug: "other",
      name: "Other",
      joinPolicy: "invite_only",
    });
  }

  async function bindSlackChannel(teamId: string) {
    await env.DB.prepare(
      "INSERT INTO team_channel_bindings (provider, external_id, team_id, kind, created_at) VALUES ('slack', 'C1', ?, 'source', ?)"
    )
      .bind(teamId, Date.now())
      .run();
  }

  it("conceals a team session on read and token mint when enforcement is on", async () => {
    const { sessionName, team } = await session("team");
    const as = { userId: MEMBER, role: "member" } as const;
    const snapshot = await fetchMode(`/sessions/${sessionName}`, "on", { as });
    const token = await fetchMode(`/sessions/${sessionName}/ws-token`, "on", {
      as,
      method: "POST",
    });
    expect(snapshot.status).toBe(404);
    expect(await snapshot.json()).toEqual({ error: "Session not found" });
    expect(token.status).toBe(404);
    const denied = await auditRows("authorization.request_denied");
    expect(denied.filter((row) => row.reason_code === "session_not_visible")).toHaveLength(2);
    expect(denied.find((row) => row.reason_code === "session_not_visible")?.team_id).toBe(team.id);
  });

  it("uses the signed Slack channel binding for actorless event reads", async () => {
    const { sessionName, team } = await session("team");
    const other = await otherTeam();
    await bindSlackChannel(other.id);
    const runtime = vi.spyOn(env.SESSION, "get");
    const hidden = await fetchMode(`/sessions/${sessionName}/events?channel=slack:C1`, "on", {
      service: "slack-bot",
    });
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: "Session not found" });
    expect(runtime).not.toHaveBeenCalled();
    runtime.mockRestore();
    await env.DB.prepare("UPDATE team_channel_bindings SET team_id = ? WHERE external_id = 'C1'")
      .bind(team.id)
      .run();
    expect(
      (
        await fetchMode(`/sessions/${sessionName}/events?channel=slack:C1`, "on", {
          service: "slack-bot",
        })
      ).status
    ).toBe(200);
    expect(
      (
        await fetchMode(`/sessions/${sessionName}/events`, "on", {
          service: "slack-bot",
        })
      ).status
    ).toBe(200);
  });

  it.each(["off", "shadow", "on"] as const)(
    "retains Linear channel-scoped event semantics in %s mode without Slack publication authority",
    async (mode) => {
      const { sessionName, team } = await session("team");
      const other = await otherTeam();
      const bindings = new TeamChannelBindingStore(env.DB);
      const bindingActor = { actorUserId: OWNER, requestId: "linear-read-binding" };
      await bindings.put(
        { provider: "linear", externalId: "L1", teamId: other.id, kind: "source" },
        bindingActor
      );
      const path = `/sessions/${sessionName}/events?channel=linear:L1`;
      const runtime = vi.spyOn(env.SESSION, "get");
      expect((await fetchMode(path, mode, { service: "linear-bot" })).status).toBe(
        mode === "on" ? 404 : 200
      );
      if (mode === "on") expect(runtime).not.toHaveBeenCalled();
      runtime.mockRestore();
      await bindings.remove(other.id, "linear", "L1", bindingActor);
      await bindings.put(
        { provider: "linear", externalId: "L1", teamId: team.id, kind: "source" },
        bindingActor
      );
      expect((await fetchMode(path, mode, { service: "linear-bot" })).status).toBe(200);
      expect(
        (await fetchMode(`${path}&purpose=slack-post`, mode, { service: "linear-bot" })).status
      ).toBe(404);
      await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
        .bind(sessionName)
        .run();
      expect((await fetchMode(path, mode, { service: "linear-bot" })).status).toBe(404);
    }
  );

  describe.each(["slack", "linear"] as const)("unbound %s reads", (provider) => {
    it.each(["off", "shadow", "on"])(
      "revokes team-owned reads in %s mode without hiding workspace sessions",
      async (mode) => {
        const { sessionName, team } = await session("team");
        const bindings = new TeamChannelBindingStore(env.DB);
        const bindingActor = { actorUserId: OWNER, requestId: `${provider}-unbind` };
        const externalId = provider === "slack" ? "C1" : "L1";
        await bindings.put({ provider, externalId, teamId: team.id, kind: "source" }, bindingActor);
        const purposes = provider === "slack" ? ["", "&purpose=slack-post"] : [""];
        const resources = ["events", "artifacts"] as const;
        const read = (resource: (typeof resources)[number], purpose: string) =>
          fetchMode(
            `/sessions/${sessionName}/${resource}?channel=${provider}:${externalId}${purpose}`,
            mode,
            { service: `${provider}-bot` }
          );
        for (const purpose of purposes) {
          for (const resource of resources) {
            expect((await read(resource, purpose)).status).toBe(200);
          }
        }

        await bindings.remove(team.id, provider, externalId, bindingActor);
        const runtime = vi.spyOn(env.SESSION, "get");
        for (const visibility of ["team", "workspace", "private"]) {
          await env.DB.prepare("UPDATE sessions SET visibility = ? WHERE id = ?")
            .bind(visibility, sessionName)
            .run();
          for (const purpose of purposes) {
            for (const resource of resources) {
              const response = await read(resource, purpose);
              expect(response.status).toBe(404);
              expect(await response.json()).toEqual({ error: "Session not found" });
            }
          }
        }
        expect(runtime).not.toHaveBeenCalled();
        runtime.mockRestore();
        const denials = await auditRows("authorization.request_denied");
        expect(denials).toHaveLength(resources.length * purposes.length * 3);
        expect(
          denials.every(
            (row) => row.team_id === team.id && row.reason_code === "session_not_visible"
          )
        ).toBe(true);

        await env.DB.prepare("UPDATE sessions SET visibility = 'workspace' WHERE id = ?")
          .bind(sessionName)
          .run();
        expect(
          (await fetchMode(`/sessions/${sessionName}/events`, mode, { service: `${provider}-bot` }))
            .status
        ).toBe(200);

        await env.DB.prepare("UPDATE sessions SET owner_team_id = NULL WHERE id = ?")
          .bind(sessionName)
          .run();
        for (const purpose of purposes) {
          for (const resource of resources) {
            expect((await read(resource, purpose)).status).toBe(200);
          }
        }
        await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
          .bind(sessionName)
          .run();
        for (const purpose of purposes) {
          for (const resource of resources) {
            expect((await read(resource, purpose)).status).toBe(404);
          }
        }
      }
    );
  });

  it.each(["linear:", "unknown:L1", "slack:L1", "linear:L1&channel=linear:L2"])(
    "fails closed for invalid Linear event scope %s",
    async (channel) => {
      const { sessionName } = await session("team");
      const runtime = vi.spyOn(env.SESSION, "get");
      expect(
        (
          await fetchMode(`/sessions/${sessionName}/events?channel=${channel}`, "on", {
            service: "linear-bot",
          })
        ).status
      ).toBe(404);
      expect(runtime).not.toHaveBeenCalled();
    }
  );

  it("keeps a participant's concealed prompt separate from trusted channel publication access", async () => {
    const { sessionName, team } = await session("team");
    await bindSlackChannel(team.id);
    const denied = await fetchMode(`/sessions/${sessionName}/prompt`, "on", {
      as: { userId: MEMBER, role: "member" },
      method: "POST",
      body: JSON.stringify({ content: "not admitted" }),
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "Session not found" });
    const proofPath = `/sessions/${sessionName}/artifacts?channel=slack:C1&purpose=slack-post`;
    const proof = await fetchMode(proofPath, "on", { service: "slack-bot" });
    expect(proof.status).toBe(200);
    expect(await proof.json()).toMatchObject({ artifacts: [] });
    await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
      .bind(sessionName)
      .run();
    const unavailable = await fetchMode(proofPath, "on", { service: "slack-bot" });
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toEqual({ error: "Session not found" });
  });

  it.each(["slack:", "unknown:C1", "linear:C1", "slack:C1&channel=slack:C2"])(
    "fails closed for invalid actorless channel scope %s",
    async (channel) => {
      const { sessionName } = await session("team");
      expect(
        (
          await fetchMode(`/sessions/${sessionName}/events?channel=${channel}`, "on", {
            service: "slack-bot",
          })
        ).status
      ).toBe(404);
    }
  );

  it.each(["off", "shadow"])(
    "retains %s semantics for channel-scoped service reads",
    async (mode) => {
      const { sessionName } = await session("team");
      const other = await otherTeam();
      await bindSlackChannel(other.id);
      expect(
        (
          await fetchMode(`/sessions/${sessionName}/events?channel=slack:C1`, mode, {
            service: "slack-bot",
          })
        ).status
      ).toBe(200);
    }
  );

  it.each(["off", "shadow", "on"])(
    "blocks queued Slack publication after channel rebinding in %s mode",
    async (mode) => {
      const { sessionName, team } = await session("workspace");
      const other = await otherTeam();
      await bindSlackChannel(team.id);
      const path = `/sessions/${sessionName}/events?channel=slack:C1&purpose=slack-post`;
      expect((await fetchMode(path, mode, { service: "slack-bot" })).status).toBe(200);
      await env.DB.prepare(
        "UPDATE team_channel_bindings SET team_id = ? WHERE provider = 'slack' AND external_id = 'C1'"
      )
        .bind(other.id)
        .run();
      expect(
        (
          await fetchMode(`/sessions/${sessionName}/events?channel=slack:C1`, mode, {
            service: "slack-bot",
          })
        ).status
      ).toBe(200);
      const runtime = vi.spyOn(env.SESSION, "get");
      for (const resource of ["events", "artifacts", "media/artifact_1"]) {
        expect(
          (
            await fetchMode(
              `/sessions/${sessionName}/${resource}?channel=slack:C1&purpose=slack-post`,
              mode,
              { service: "slack-bot" }
            )
          ).status
        ).toBe(404);
      }
      expect(runtime).not.toHaveBeenCalled();
      runtime.mockRestore();
      expect((await auditRows("authorization.request_denied")).slice(-3)).toMatchObject([
        { team_id: team.id },
        { team_id: team.id },
        { team_id: team.id },
      ]);
    }
  );

  describe.each(["off", "shadow", "on"])("Slack write scope in %s mode", (mode) => {
    it("admits same-team and workspace/unbound writes", async () => {
      const { sessionName, team } = await session("team");
      await new UserStore(env.DB).createIdentity({
        userId: MEMBER,
        provider: "slack",
        providerUserId: "U-SCOPE",
      });
      await new TeamMembershipStore(env.DB).add(team.id, MEMBER);
      await bindSlackChannel(team.id);
      const workspace = await initSession({ userId: CREATOR });
      await waitForSandboxStatus(workspace.stub, "failed");
      for (const [id, channel] of [
        [sessionName, "C1"],
        [workspace.sessionName, "C-UNBOUND"],
      ]) {
        for (const resource of SLACK_WRITES) {
          const response = await slackWrite(
            `/sessions/${id}/${resource}?channel=slack:${channel}`,
            mode
          );
          expect(response.status).toBe(resource === "prompt" ? 200 : 201);
        }
      }
    });

    it("denies live rebind/unbind despite original or dual membership, before any writes", async () => {
      const { sessionName, team, stub } = await session("workspace");
      const other = await otherTeam();
      const users = new UserStore(env.DB);
      await users.createIdentity({ userId: MEMBER, provider: "slack", providerUserId: "U-SCOPE" });
      const memberships = new TeamMembershipStore(env.DB);
      await memberships.add(team.id, MEMBER);
      await bindSlackChannel(team.id);
      for (const resource of SLACK_WRITES) {
        const response = await slackWrite(
          `/sessions/${sessionName}/${resource}?channel=slack:C1`,
          mode
        );
        expect(response.status).toBe(resource === "prompt" ? 200 : 201);
      }
      const countsSql = `SELECT
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM attachments) AS attachments,
        (SELECT COUNT(*) FROM participants) AS participants`;
      const before = await queryDO(stub, countsSql);
      const runtime = vi.spyOn(env.SESSION, "get");
      const storage = vi.spyOn(env.MEDIA_BUCKET, "put");
      const enroll = vi.spyOn(UserStore.prototype, "resolveOrCreateUser");
      for (const state of ["rebound", "dual-member", "unbound"] as const) {
        if (state === "rebound") {
          await env.DB.prepare(
            "UPDATE team_channel_bindings SET team_id = ? WHERE external_id = 'C1'"
          )
            .bind(other.id)
            .run();
        } else if (state === "dual-member") {
          await memberships.add(other.id, MEMBER);
        } else {
          await env.DB.prepare("DELETE FROM team_channel_bindings WHERE external_id = 'C1'").run();
        }
        for (const resource of SLACK_WRITES) {
          for (const actor of ["slack:U-SCOPE", "slack:U-FIRST-CONTACT"]) {
            const response = await slackWrite(
              `/sessions/${sessionName}/${resource}?channel=slack:C1&teamId=${team.id}`,
              mode,
              { actor }
            );
            expect(response.status, `${state} ${resource} ${actor}`).toBe(403);
            expect(await response.json()).toEqual(SCOPE_REFUSAL);
          }
        }
      }
      expect(runtime).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      expect(enroll).not.toHaveBeenCalled();
      expect(await users.getIdentity("slack", "U-FIRST-CONTACT")).toBeNull();
      expect(await queryDO(stub, countsSql)).toEqual(before);
      const denials = await auditRows("authorization.request_denied");
      expect(denials).toHaveLength(12);
      expect(denials.every((row) => row.reason_code === SCOPE_REFUSAL.code)).toBe(true);
    });

    it("denies bound channels writing to workspace-owned sessions", async () => {
      const { sessionName, team } = await session("workspace");
      await env.DB.prepare(
        "UPDATE sessions SET owner_team_id = NULL, visibility = 'workspace' WHERE id = ?"
      )
        .bind(sessionName)
        .run();
      await bindSlackChannel(team.id);
      const runtime = vi.spyOn(env.SESSION, "get");
      const storage = vi.spyOn(env.MEDIA_BUCKET, "put");
      const enroll = vi.spyOn(UserStore.prototype, "resolveOrCreateUser");
      for (const resource of SLACK_WRITES) {
        const response = await slackWrite(
          `/sessions/${sessionName}/${resource}?channel=slack:C1`,
          mode
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual(SCOPE_REFUSAL);
      }
      expect(runtime).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      expect(enroll).not.toHaveBeenCalled();
    });

    it("requires exactly one well-formed Slack query coordinate before enrollment or dispatch", async () => {
      const binding = vi.spyOn(TeamChannelBindingStore.prototype, "get");
      const sessionRead = vi.spyOn(SessionIndexStore.prototype, "get");
      const enroll = vi.spyOn(UserStore.prototype, "resolveOrCreateUser");
      const runtime = vi.spyOn(env.SESSION, "get");
      const storage = vi.spyOn(env.MEDIA_BUCKET, "put");
      for (const query of [
        "",
        "?channel=",
        "?channel=slack:",
        "?channel=slack:C1:extra",
        "?channel=slack:C%201",
        "?channel=unknown:C1",
        "?channel=linear:C1",
        "?channel=slack:C1&channel=slack:C1",
        "?channel=slack:C1&channel=slack:C2",
      ]) {
        for (const resource of SLACK_WRITES) {
          const response = await slackWrite(`/sessions/missing/${resource}${query}`, mode);
          expect(response.status, `${resource} ${query}`).toBe(400);
          expect(await response.json()).toEqual(SCOPE_REFUSAL);
        }
      }
      expect(binding).not.toHaveBeenCalled();
      expect(sessionRead).not.toHaveBeenCalled();
      expect(enroll).not.toHaveBeenCalled();
      expect(runtime).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
    });

    it("retains the scope code for missing sessions and either authority read failure", async () => {
      const runtime = vi.spyOn(env.SESSION, "get");
      const storage = vi.spyOn(env.MEDIA_BUCKET, "put");
      const enroll = vi.spyOn(UserStore.prototype, "resolveOrCreateUser");
      for (const authority of [null, TeamChannelBindingStore, SessionIndexStore]) {
        const read = authority
          ? vi
              .spyOn(authority.prototype, "get")
              .mockRejectedValue(new Error("Authority unavailable"))
          : null;
        for (const resource of SLACK_WRITES) {
          const response = await slackWrite(`/sessions/missing/${resource}?channel=slack:C1`, mode);
          expect(response.status).toBe(authority ? 503 : 404);
          expect(await response.json()).toEqual(SCOPE_REFUSAL);
        }
        read?.mockRestore();
      }
      expect(enroll).not.toHaveBeenCalled();
      expect(runtime).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
    });

    it("preserves actorless rejection and cryptographically rejects changed query coordinates", async () => {
      const binding = vi.spyOn(TeamChannelBindingStore.prototype, "get");
      const enroll = vi.spyOn(UserStore.prototype, "resolveOrCreateUser");
      const runtime = vi.spyOn(env.SESSION, "get");
      for (const resource of SLACK_WRITES) {
        const path = `/sessions/missing/${resource}`;
        for (const query of ["", "?channel=slack:C1"]) {
          const response = await slackWrite(`${path}${query}`, mode, { actor: null });
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({ code: "service_actor_required" });
        }
        for (const query of ["", "?channel=slack:C2", "?channel=slack:C1&channel=slack:C2"]) {
          const response = await slackWrite(`${path}${query}`, mode, {
            signedPath: `${path}?channel=slack:C1`,
          });
          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({ error: "Unauthorized" });
        }
      }
      expect(binding).not.toHaveBeenCalled();
      expect(enroll).not.toHaveBeenCalled();
      expect(runtime).not.toHaveBeenCalled();
    });

    it("still enforces membership, role, suspension, and private collaboration after a scope match", async () => {
      const { sessionName, team } = await session("workspace");
      await new UserStore(env.DB).createIdentity({
        userId: MEMBER,
        provider: "slack",
        providerUserId: "U-SCOPE",
      });
      await bindSlackChannel(team.id);
      for (const [state, status, body] of [
        [
          "nonmember",
          403,
          { error: "Forbidden", code: "session_action_denied", reason_code: "not_member" },
        ],
        [
          "viewer",
          403,
          { error: "Forbidden", code: "session_action_denied", reason_code: "missing_permission" },
        ],
        ["suspended", 403, { error: "Forbidden", code: "active_user_required" }],
        ["private", 404, { error: "Session not found" }],
      ] as const) {
        if (state === "viewer") {
          await new TeamMembershipStore(env.DB).add(team.id, MEMBER);
          await env.DB.prepare(
            "UPDATE user_role_assignments SET role_id = 'role_builtin_viewer' WHERE user_id = ?"
          )
            .bind(MEMBER)
            .run();
        } else if (state === "suspended") {
          await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(MEMBER).run();
        } else if (state === "private") {
          await env.DB.batch([
            env.DB.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?").bind(MEMBER),
            env.DB.prepare(
              "UPDATE user_role_assignments SET role_id = 'role_builtin_member' WHERE user_id = ?"
            ).bind(MEMBER),
            env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?").bind(
              sessionName
            ),
          ]);
        }
        for (const resource of SLACK_WRITES) {
          const response = await slackWrite(
            `/sessions/${sessionName}/${resource}?channel=slack:C1`,
            mode
          );
          expect(response.status, `${state} ${resource}`).toBe(status);
          expect(await response.json()).toEqual(body);
        }
      }
      await new SessionCollaboratorStore(env.DB).add(sessionName, MEMBER, CREATOR);
      for (const resource of SLACK_WRITES) {
        const response = await slackWrite(
          `/sessions/${sessionName}/${resource}?channel=slack:C1`,
          mode
        );
        expect(response.status).toBe(resource === "prompt" ? 200 : 201);
      }
    });

    it("leaves other services and Slack collaborate/media routes outside this scope gate", async () => {
      const { sessionName, stub } = await initSession({ userId: CREATOR });
      await waitForSandboxStatus(stub, "failed");
      for (const service of ["linear-bot", "github-bot"] as const) {
        for (const resource of SLACK_WRITES) {
          const response = await fetchMode(`/sessions/${sessionName}/${resource}`, mode, {
            service,
            actor: `${service.replace("-bot", "")}:U-OUTSIDE-SCOPE`,
            method: "POST",
            body: JSON.stringify({ content: "Other integration" }),
          });
          expect(response.status).toBe(resource === "prompt" ? 200 : 400);
          if (resource === "attachments") {
            expect(await response.json()).toEqual({ error: "Invalid multipart form data" });
          }
        }
      }
      for (const [resource, message] of [
        ["pr", "title and body are required"],
        ["media", "Invalid multipart form data"],
      ]) {
        const response = await fetchMode(`/sessions/${sessionName}/${resource}`, mode, {
          service: "slack-bot",
          actor: "slack:U-OUTSIDE-SCOPE",
          method: "POST",
          body: "{}",
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: message });
      }
    });
  });

  it("defers the team and delete rules in shadow but records each would-be denial", async () => {
    const { sessionName, team } = await session("team");
    const as = { userId: MEMBER, role: "member" } as const;
    const snapshot = await fetchMode(`/sessions/${sessionName}`, "shadow", { as });
    expect(snapshot.status).toBe(200);
    const shadowRows = (await auditRows("authorization.request_allowed")).filter(
      (row) => typeof row.reason_code === "string" && row.reason_code.startsWith("shadow_denied:")
    );
    expect(shadowRows).toMatchObject([
      { reason_code: "shadow_denied:not_member", team_id: team.id },
    ]);

    await new TeamMembershipStore(env.DB).add(team.id, MEMBER);
    const denied = await fetchMode(`/sessions/${sessionName}`, "on", { as });
    expect(denied.status).toBe(200);
    const deletion = await fetchMode(`/sessions/${sessionName}`, "on", { as, method: "DELETE" });
    expect(deletion.status).toBe(403);
    expect(await deletion.json()).toEqual({
      error: "Forbidden",
      code: "session_action_denied",
      reason_code: "not_owner_or_lead",
    });
    await new TeamMembershipStore(env.DB).setRole(team.id, MEMBER, "lead");
    expect(
      (await fetchMode(`/sessions/${sessionName}`, "on", { as, method: "DELETE" })).status
    ).toBe(200);
  });

  it("audits shadow read observations and enforced team action denials with the real status", async () => {
    const { sessionName } = await session("team");
    for (const [path, method, body] of [
      [`/sessions/${sessionName}`, "GET", undefined],
      [`/sessions/${sessionName}/budget`, "PATCH", JSON.stringify({ maxCostUsd: 20 })],
    ] as const) {
      const response = await fetchMode(path, "shadow", {
        method,
        body,
        as: { userId: MEMBER, role: "member" },
      });
      const rows = (
        await env.DB.prepare(
          "SELECT action, reason_code, metadata_json FROM authorization_audit_events WHERE request_id = ?"
        )
          .bind(response.headers.get("x-request-id"))
          .all()
      ).results;
      expect(response.status).toBe(method === "GET" ? 200 : 403);
      expect(rows).toHaveLength(1);
      const reason = method === "GET" ? "shadow_denied:not_member" : "not_member";
      expect(rows[0].reason_code).toBe(reason);
      expect(rows[0].action).toBe(
        method === "GET" ? "authorization.request_allowed" : "authorization.request_denied"
      );
      expect(JSON.parse(String(rows[0].metadata_json))).toMatchObject({
        httpStatus: response.status,
        responseCode: reason,
      });
    }
  });

  it("enforces team deletion ownership in shadow and off", async () => {
    const as = { userId: MEMBER, role: "member" } as const;
    const shadow = await session("team");
    await new TeamMembershipStore(env.DB).add(shadow.team.id, MEMBER);
    expect(
      (await fetchMode(`/sessions/${shadow.sessionName}`, "shadow", { method: "DELETE", as }))
        .status
    ).toBe(403);
    expect(
      (await auditRows("authorization.request_denied")).filter(
        (row) => row.reason_code === "not_owner_or_lead"
      )
    ).toHaveLength(1);
    const off = await session("team");
    expect(
      (await fetchMode(`/sessions/${off.sessionName}`, "off", { method: "DELETE", as })).status
    ).toBe(403);
  });

  it.each(["off", "shadow", "on"] as const)(
    "requires current membership for workspace-visible team interaction in %s mode",
    async (mode) => {
      const { sessionName, team, stub } = await session("workspace");
      await queryDO(
        stub,
        "UPDATE sandbox SET status = 'ready', code_server_url = ?, vnc_url = ?, ttyd_url = ?, tunnel_urls = ?, modal_object_id = ?",
        "https://code.example.test",
        "https://vnc.example.test",
        "https://terminal.example.test",
        JSON.stringify({ "3000": "https://app.example.test" }),
        "team-access-sandbox"
      );
      for (const as of [
        { userId: MEMBER, role: "member" },
        { userId: CREATOR, role: "member" },
        { userId: OWNER, role: "owner" },
        { userId: "44444444444444444444444444444444", role: "administrator" },
      ] as const) {
        for (const [path, method] of [
          ["prompt", "POST"],
          ["sandbox-access", "GET"],
        ] as const) {
          const response = await fetchMode(`/sessions/${sessionName}/${path}`, mode, {
            as,
            method,
            body: method === "POST" ? JSON.stringify({ content: "Denied" }) : undefined,
          });
          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({
            error: "Forbidden",
            code: "session_action_denied",
            reason_code: "not_member",
          });
        }
        const snapshot = await fetchMode(`/sessions/${sessionName}`, mode, { as });
        expect(snapshot.status).toBe(200);
        const body = await snapshot.json();
        expect(body).toMatchObject({
          session: {
            capabilities: {
              canRead: true,
              canCollaborate: false,
              canManageLifecycle: false,
              canDelete: false,
              canSandbox: false,
              canManageCollaborators: false,
              canChangeVisibility: false,
            },
          },
        });
        for (const field of [
          "codeServerUrl",
          "sandboxDashboardUrl",
          "vncUrl",
          "ttydUrl",
          "tunnelUrls",
        ]) {
          expect(body).not.toHaveProperty(`session.${field}`);
        }
      }
      await new TeamMembershipStore(env.DB).add(team.id, MEMBER);
      const as = { userId: MEMBER, role: "member" } as const;
      expect(
        (await fetchMode(`/sessions/${sessionName}/sandbox-access`, mode, { as })).status
      ).toBe(200);
      const prompt = await fetchMode(`/sessions/${sessionName}/prompt`, mode, {
        as,
        method: "POST",
        body: JSON.stringify({ content: "Allowed" }),
      });
      expect(prompt.status).toBe(200);
      expect(
        await (await fetchMode(`/sessions/${sessionName}`, mode, { as })).json()
      ).toMatchObject({
        session: {
          capabilities: { canCollaborate: true, canManageLifecycle: true, canSandbox: true },
        },
      });
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "refuses a removed owner's private team prompt and honors collaborators only as members in %s mode",
    async (mode) => {
      const { sessionName, team } = await session("private");
      const memberships = new TeamMembershipStore(env.DB);
      await memberships.add(team.id, CREATOR);
      await memberships.remove(team.id, CREATOR);
      const prompt = await fetchMode(`/sessions/${sessionName}/prompt`, mode, {
        as: { userId: CREATOR, role: "member" },
        method: "POST",
        body: JSON.stringify({ content: "Denied" }),
      });
      expect(prompt.status).toBe(403);
      expect(await prompt.json()).toMatchObject({ reason_code: "not_member" });
      const collaborators = new SessionCollaboratorStore(env.DB);
      await collaborators.add(sessionName, MEMBER, CREATOR);
      const as = { userId: MEMBER, role: "member" } as const;
      const collaboratorPrompt = await fetchMode(`/sessions/${sessionName}/prompt`, mode, {
        as,
        method: "POST",
        body: JSON.stringify({ content: "Denied" }),
      });
      expect(collaboratorPrompt.status).toBe(404);
      const selfRemove = () =>
        fetchMode(`/sessions/${sessionName}/collaborators/${MEMBER}`, mode, {
          as,
          method: "DELETE",
        });
      expect((await selfRemove()).status).toBe(404);
      expect(await collaborators.listUserIds(sessionName)).toEqual([MEMBER]);
      await memberships.add(team.id, MEMBER);
      expect((await selfRemove()).status).toBe(200);
      expect(await collaborators.listUserIds(sessionName)).toEqual([]);
    }
  );

  it("conceals another team's export even when the viewer holds sessions.export", async () => {
    const { sessionName } = await session("team");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, is_system)
         VALUES ('role_export_reader', NULL, 'Export Reader', 'export reader', 0)`
      ),
      env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ('role_export_reader', 'sessions.read'),
                ('role_export_reader', 'sessions.export')`
      ),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_export_reader' WHERE user_id = ?"
      ).bind(MEMBER),
    ]);
    const response = await fetchMode(`/sessions/${sessionName}/export`, "on", {
      as: { userId: MEMBER, role: "member" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("keeps private sessions concealed in all modes and audits Owner break-glass once per read", async () => {
    const { sessionName, team } = await session("private");
    const as = { userId: MEMBER, role: "member" } as const;
    await new TeamMembershipStore(env.DB).add(team.id, MEMBER);
    for (const mode of ["off", "shadow", "on"] as const) {
      expect((await fetchMode(`/sessions/${sessionName}`, mode, { as })).status).toBe(404);
    }
    expect((await fetchMode(`/sessions/${sessionName}`, "on")).status).toBe(200);
    expect(await auditRows("session.private_break_glass")).toMatchObject([
      {
        resource_type: "session",
        resource_id: sessionName,
        team_id: team.id,
        actor_user_id_snapshot: OWNER,
      },
    ]);
    await new SessionCollaboratorStore(env.DB).add(sessionName, MEMBER, OWNER);
    expect((await fetchMode(`/sessions/${sessionName}`, "on", { as })).status).toBe(200);
    expect(await auditRows("session.private_break_glass")).toHaveLength(1);
  });

  it.each(["off", "shadow", "on"] as const)(
    "refuses an Owner break-glass prompt on a private session in %s mode",
    async (mode) => {
      const { sessionName } = await session("private");
      const response = await fetchMode(`/sessions/${sessionName}/prompt`, mode, {
        method: "POST",
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Forbidden",
        code: "session_action_denied",
        reason_code: "not_member",
      });
    }
  );

  it("loads memberships for snapshot capabilities even in off mode", async () => {
    const { sessionName } = await session("team");
    const list = vi.spyOn(TeamMembershipStore.prototype, "listForUser");
    try {
      expect(
        (
          await fetchMode(`/sessions/${sessionName}`, "off", {
            as: { userId: MEMBER, role: "member" },
          })
        ).status
      ).toBe(200);
      expect(list).toHaveBeenCalledOnce();
    } finally {
      list.mockRestore();
    }
  });

  it("loads collaborators and memberships for an off-mode private team session", async () => {
    const { sessionName } = await session("private");
    const members = vi.spyOn(TeamMembershipStore.prototype, "listForUser");
    const collaborators = vi.spyOn(SessionCollaboratorStore.prototype, "listUserIds");
    try {
      expect((await fetchMode(`/sessions/${sessionName}`, "off")).status).toBe(200);
      expect(members).toHaveBeenCalledOnce();
      expect(collaborators).toHaveBeenCalledOnce();
    } finally {
      members.mockRestore();
      collaborators.mockRestore();
    }
  });

  it("admits actorless Linear stop on non-private sessions in every mode, but hides private sessions", async () => {
    const team = await session("team");
    const privateSession = await session("private");
    const workspace = await initSession({ userId: CREATOR });
    await waitForSandboxStatus(workspace.stub, "failed");
    for (const mode of ["off", "shadow", "on"] as const) {
      for (const id of [team.sessionName, workspace.sessionName]) {
        const response = await fetchMode(`/sessions/${id}/stop`, mode, {
          method: "POST",
          service: "linear-bot",
        });
        expect(response.status).toBe(200);
      }
      expect(
        (
          await fetchMode(`/sessions/${privateSession.sessionName}/stop`, mode, {
            method: "POST",
            service: "linear-bot",
          })
        ).status
      ).toBe(404);
    }
    expect(
      (await auditRows("authorization.request_allowed")).filter(
        (row) => row.reason_code === "shadow_denied:missing_permission"
      )
    ).toEqual([]);
  });

  it("conceals an invisible child even when its parent is visible", async () => {
    const parent = await initSession({ userId: CREATOR });
    await waitForSandboxStatus(parent.stub, "failed");
    const child = await session("team");
    await env.DB.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
      .bind(parent.sessionName, child.sessionName)
      .run();
    const as = { userId: MEMBER, role: "member" } as const;
    expect(
      (
        await fetchMode(`/sessions/${parent.sessionName}/children/${child.sessionName}`, "on", {
          as,
        })
      ).status
    ).toBe(404);
    expect(
      (
        await fetchMode(
          `/sessions/${parent.sessionName}/children/${child.sessionName}/cancel`,
          "on",
          { as, method: "POST" }
        )
      ).status
    ).toBe(404);
    expect(
      (await auditRows("authorization.request_denied")).filter(
        (row) => row.reason_code === "session_not_visible"
      )
    ).toMatchObject([{ team_id: child.team.id }, { team_id: child.team.id }]);
  });

  it("lists only children visible in the selected enforcement mode", async () => {
    const parent = await initSession({ userId: CREATOR });
    await waitForSandboxStatus(parent.stub, "failed");
    const workspace = await initSession({ userId: CREATOR });
    await waitForSandboxStatus(workspace.stub, "failed");
    const team = await session("team");
    const hidden = await session("private");
    for (const childId of [workspace.sessionName, team.sessionName, hidden.sessionName]) {
      await env.DB.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
        .bind(parent.sessionName, childId)
        .run();
    }

    for (const mode of ["off", "shadow", "on"] as const) {
      const response = await fetchMode(`/sessions/${parent.sessionName}/children`, mode, {
        as: { userId: MEMBER, role: "member" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { children: { id: string }[] };
      expect(body.children.map((child) => child.id).sort()).toEqual(
        (mode === "on" ? [workspace.sessionName] : [workspace.sessionName, team.sessionName]).sort()
      );
    }
  });

  it("audits both private reads when an Owner accesses a private child", async () => {
    const parent = await session("private");
    const child = await session("private");
    await env.DB.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
      .bind(parent.sessionName, child.sessionName)
      .run();
    await fetchMode(`/sessions/${parent.sessionName}/children/${child.sessionName}`, "on");
    expect(
      (await auditRows("session.private_break_glass")).map((row) => row.resource_id).sort()
    ).toEqual([parent.sessionName, child.sessionName].sort());
  });

  it("audits a permitted private read before a later handler denial", async () => {
    const { sessionName } = await session("private");
    const response = await fetchMode(`/sessions/${sessionName}/budget`, "off", {
      method: "PATCH",
      body: JSON.stringify({ maxCostUsd: 20 }),
    });
    expect(response.status).toBe(403);
    expect((await auditRows("session.private_break_glass")).map((row) => row.resource_id)).toEqual([
      sessionName,
    ]);
  });

  it("responds 503 to an invalid mode for both item and batch routes", async () => {
    expect((await fetchMode("/sessions/missing", "invalid")).status).toBe(503);
    expect(
      (
        await fetchMode("/sessions/batch-archive", "invalid", {
          method: "POST",
          body: JSON.stringify({ sessionIds: ["missing"] }),
        })
      ).status
    ).toBe(503);
  });

  it("skips hidden and action-denied batch targets independently", async () => {
    const hidden = await session("private");
    const visible = await session("team");
    await new TeamMembershipStore(env.DB).add(visible.team.id, MEMBER);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, is_system)
         VALUES ('role_batch_viewer', NULL, 'Batch Viewer', 'batch viewer', 0)`
      ),
      env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ('role_batch_viewer', 'sessions.bulk_archive'),
                ('role_batch_viewer', 'sessions.read')`
      ),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_batch_viewer' WHERE user_id = ?"
      ).bind(MEMBER),
    ]);
    const memberships = vi.spyOn(TeamMembershipStore.prototype, "listForUser");
    const response = await fetchMode("/sessions/batch-archive", "on", {
      method: "POST",
      as: { userId: MEMBER, role: "member" },
      body: JSON.stringify({ sessionIds: [hidden.sessionName, visible.sessionName] }),
    });
    expect(memberships).toHaveBeenCalledOnce();
    memberships.mockRestore();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [],
      skipped: [
        { sessionId: hidden.sessionName, reason: "not_found" },
        { sessionId: visible.sessionName, reason: "missing_permission" },
      ],
    });
  });

  it.each(["off", "shadow", "on"] as const)(
    "refuses bulk-only custom-role team archiving without lifecycle permission in %s mode",
    async (mode) => {
      const { sessionName, team } = await session("team");
      await new TeamMembershipStore(env.DB).add(team.id, MEMBER);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO roles (id, key, name, normalized_name, is_system)
           VALUES ('role_bulk_only', NULL, 'Bulk Only', 'bulk only', 0)`
        ),
        env.DB.prepare(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ('role_bulk_only', 'sessions.bulk_archive'),
                  ('role_bulk_only', 'sessions.read')`
        ),
        env.DB.prepare(
          "UPDATE user_role_assignments SET role_id = 'role_bulk_only' WHERE user_id = ?"
        ).bind(MEMBER),
      ]);

      const response = await fetchMode("/sessions/batch-archive", mode, {
        method: "POST",
        as: { userId: MEMBER, role: "member" },
        body: JSON.stringify({ sessionIds: [sessionName] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        results: [],
        skipped: [{ sessionId: sessionName, reason: "missing_permission" }],
      });
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "reports team membership, not permission, when a workspace owner batch-archives a team session in %s mode",
    async (mode) => {
      const { sessionName } = await session("workspace");
      const response = await fetchMode("/sessions/batch-archive", mode, {
        method: "POST",
        body: JSON.stringify({ sessionIds: [sessionName] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        results: [],
        skipped: [{ sessionId: sessionName, reason: "not_member" }],
      });
    }
  );

  it("lists, idempotently adds, and removes collaborators", async () => {
    const { sessionName } = await session("private");
    const store = new SessionCollaboratorStore(env.DB);
    expect(await store.add(sessionName, MEMBER, OWNER)).toBe(true);
    expect(await store.add(sessionName, MEMBER, OWNER)).toBe(false);
    expect(await store.listUserIds(sessionName)).toEqual([MEMBER]);
    expect(await store.listForUser(MEMBER)).toEqual([sessionName]);
    expect(await store.remove(sessionName, MEMBER)).toBe(true);
    expect(await store.remove(sessionName, MEMBER)).toBe(false);
    expect(await store.listUserIds(sessionName)).toEqual([]);
  });
});
