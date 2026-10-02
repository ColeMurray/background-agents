import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type { TeamChannelBinding } from "@open-inspect/shared/types/team-channel-bindings";
import {
  TeamChannelBindingConflictError,
  TeamChannelBindingStore,
} from "../../src/db/team-channel-bindings";
import { IntegrationSettingsStore } from "../../src/db/integration-settings";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamStore } from "../../src/db/teams";
import { UserStore } from "../../src/db/user-store";
import type { SqlDatabase, SqlStatement } from "../../src/db/sql-database";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceFetch, serviceRequestHeaders, sqlDatabase } from "./helpers";

const BASE = "https://test.local";
const OWNER = "11111111111111111111111111111111";
const SLACK_SERVICE_SECRET = "test-channel-info-service-secret";
const actor = { actorUserId: OWNER, requestId: "binding-request" };

async function createTeam(slug: string) {
  return new TeamStore(env.DB).create({ slug, name: slug, joinPolicy: "invite_only" });
}

function slackBinding(teamId: string, kind: TeamChannelBinding["kind"]): TeamChannelBinding {
  return { provider: "slack", externalId: "C123", teamId, kind };
}

async function bindingAudits(teamId: string) {
  const rows = await env.DB.prepare(
    `SELECT action, actor_user_id_snapshot, team_id, metadata_json
     FROM authorization_audit_events
     WHERE team_id = ? AND action IN ('team.binding_added', 'team.binding_removed')
     ORDER BY occurred_at, id`
  )
    .bind(teamId)
    .all<{
      action: string;
      actor_user_id_snapshot: string;
      team_id: string;
      metadata_json: string;
    }>();
  return rows.results;
}

beforeEach(async () => {
  await cleanD1Tables();
  await serviceFetch(`${BASE}/me/authorization`);
});
afterEach(() => vi.unstubAllGlobals());

describe("team channel binding store", () => {
  it("gets provider-keyed bindings and lists only the requested team", async () => {
    const team = await createTeam("engineering");
    const other = await createTeam("other");
    const store = new TeamChannelBindingStore(env.DB);
    expect(await store.get("slack", "C123")).toBeNull();
    const slack = slackBinding(team.id, "primary");
    const linear: TeamChannelBinding = { ...slack, provider: "linear", kind: "source" };
    await store.put(slack, actor);
    await store.put(linear, actor);
    await store.put({ ...slack, externalId: "C456", teamId: other.id }, actor);
    expect(await store.get("slack", "C123")).toEqual(slack);
    expect(await store.get("linear", "C123")).toEqual(linear);
    expect(await store.listByTeam(team.id)).toEqual([linear, slack]);
  });

  it("rejects cross-team rebinding and a second primary without auditing failed writes", async () => {
    const team = await createTeam("engineering");
    const other = await createTeam("other");
    const store = new TeamChannelBindingStore(env.DB);
    const binding = slackBinding(team.id, "primary");
    await store.put(binding, actor);
    await expect(store.put({ ...binding, teamId: other.id }, actor)).rejects.toBeInstanceOf(
      TeamChannelBindingConflictError
    );
    await expect(store.put({ ...binding, externalId: "C456" }, actor)).rejects.toBeInstanceOf(
      TeamChannelBindingConflictError
    );
    expect(await store.get("slack", "C123")).toEqual(binding);
    expect(await store.get("slack", "C456")).toBeNull();
    expect(await bindingAudits(other.id)).toEqual([]);
    expect(await bindingAudits(team.id)).toHaveLength(1);
  });

  it("updates kind, permits a replacement primary, and audits only applied mutations", async () => {
    const team = await createTeam("engineering");
    const store = new TeamChannelBindingStore(env.DB);
    const binding = slackBinding(team.id, "primary");
    await store.put(binding, actor);
    await store.put(binding, actor);
    const created = await bindingAudits(team.id);
    expect(created).toHaveLength(1);
    expect(JSON.parse(created[0]!.metadata_json)).toEqual({
      before: {},
      requested: {},
      after: binding,
    });
    await store.put({ ...binding, kind: "source" }, actor);
    await store.put({ ...binding, externalId: "C456" }, actor);
    await expect(store.put(binding, actor)).rejects.toBeInstanceOf(TeamChannelBindingConflictError);
    expect((await store.get("slack", "C123"))?.kind).toBe("source");
    expect(await store.remove(team.id, "slack", "C123", actor)).toBe(true);
    expect(await store.remove(team.id, "slack", "C123", actor)).toBe(false);
    const events = await bindingAudits(team.id);
    expect(events.filter((event) => event.action === "team.binding_added")).toHaveLength(3);
    expect(events.map((event) => JSON.parse(event.metadata_json))).toContainEqual({
      before: binding,
      requested: {},
      after: { ...binding, kind: "source" },
    });
    const removed = events.find((event) => event.action === "team.binding_removed")!;
    expect(removed.actor_user_id_snapshot).toBe(OWNER);
    expect(JSON.parse(removed.metadata_json)).toEqual({
      before: { ...binding, kind: "source" },
      requested: {},
      after: {},
    });
  });

  it("does not let a team remove another team's binding", async () => {
    const team = await createTeam("engineering");
    const other = await createTeam("other");
    const store = new TeamChannelBindingStore(env.DB);
    await store.put(
      { provider: "slack", externalId: "C123", teamId: team.id, kind: "source" },
      actor
    );
    expect(await store.remove(other.id, "slack", "C123", actor)).toBe(false);
    expect(await store.get("slack", "C123")).not.toBeNull();
    expect(await bindingAudits(other.id)).toEqual([]);
  });

  it("allows only one winner when teams concurrently bind the same channel", async () => {
    const first = await createTeam("first");
    const second = await createTeam("second");
    const store = new TeamChannelBindingStore(env.DB);
    const results = await Promise.allSettled(
      [first, second].map((team) =>
        store.put({ provider: "slack", externalId: "C123", teamId: team.id, kind: "source" }, actor)
      )
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(
      TeamChannelBindingConflictError
    );
    const winner = await store.get("slack", "C123");
    expect(await bindingAudits(winner!.teamId)).toHaveLength(1);
    const loser = winner!.teamId === first.id ? second : first;
    expect(await bindingAudits(loser.id)).toEqual([]);
  });

  it("rolls back creation, kind changes, and deletion when audit insertion fails", async () => {
    const team = await createTeam("engineering");
    const db = sqlDatabase(env.DB);
    const failAudit: SqlDatabase = {
      prepare(sql) {
        return sql.includes("INSERT INTO authorization_audit_events")
          ? db.prepare("INSERT INTO authorization_audit_events (id) VALUES (?)").bind("bad-audit")
          : db.prepare(sql);
      },
      batch<T>(statements: SqlStatement[]) {
        return db.batch<T>(statements);
      },
    };
    const binding = slackBinding(team.id, "source");
    const failing = new TeamChannelBindingStore(failAudit);
    const store = new TeamChannelBindingStore(env.DB);
    await expect(failing.put(binding, actor)).rejects.toThrow();
    expect(await store.get("slack", "C123")).toBeNull();
    await store.put(binding, actor);
    await expect(failing.put({ ...binding, kind: "primary" }, actor)).rejects.toThrow();
    expect(await store.get("slack", "C123")).toEqual(binding);
    await expect(failing.remove(team.id, "slack", "C123", actor)).rejects.toThrow();
    expect(await store.get("slack", "C123")).toEqual(binding);
    expect(await bindingAudits(team.id)).toHaveLength(1);
  });
});

describe("team channel binding routes", () => {
  const channelInfo = { id: "C123", name: "engineering", isMember: true, isExtShared: false };

  async function request(
    path: string,
    method = "GET",
    body?: object,
    overrides: object = {},
    slackFetch = vi.fn().mockResolvedValue(Response.json(channelInfo))
  ) {
    const url = `${BASE}${path}`;
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers = await serviceRequestHeaders(url, { method, body: raw });
    const bindings = {
      ...env,
      SERVICE_AUTH_SECRET_SLACK_BOT: SLACK_SERVICE_SECRET,
      SLACK_BOT: { fetch: slackFetch } as unknown as Fetcher,
      ...overrides,
    };
    return routeRequest(
      new Request(url, { method, headers, body: raw }),
      bindings,
      createExecutionContext()
    );
  }

  it("validates membership through a signed service binding and lists/deletes bindings", async () => {
    const team = await createTeam("engineering");
    const path = `/teams/${team.id}/channel-bindings`;
    const fetch = vi.fn().mockResolvedValue(Response.json(channelInfo));
    const response = await request(`${path}/slack/C123`, "PUT", { kind: "primary" }, {}, fetch);
    expect(response.status).toBe(200);
    const binding = { provider: "slack", externalId: "C123", teamId: team.id, kind: "primary" };
    expect(await response.json()).toEqual({ binding });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://internal/internal/channel-info");
    expect(init.method).toBe("POST");
    const { signature, ...payload } = JSON.parse(init.body);
    expect(payload).toEqual({ channelId: "C123", timestamp: expect.any(Number) });
    expect(signature).toBe(await computeHmacHex(JSON.stringify(payload), SLACK_SERVICE_SECRET));
    const list = await request(path);
    expect(list.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await list.json()).toEqual({ bindings: [binding] });
    expect((await request(`${path}/slack/C123`, "DELETE")).status).toBe(204);
    expect((await request(`${path}/slack/C123`, "DELETE")).status).toBe(204);
    expect(await (await request(path)).json()).toEqual({ bindings: [] });
  });

  it.each([
    { ...channelInfo, isMember: false },
    { ...channelInfo, isExtShared: true },
    { id: "C123", name: "engineering" },
    { ...channelInfo, id: "C456" },
    null,
  ])("fails closed for nonjoinable or absent channel information %j", async (info) => {
    const team = await createTeam("engineering");
    const fetch = vi.fn().mockResolvedValue(Response.json(info));
    const response = await request(
      `/teams/${team.id}/channel-bindings/slack/C123`,
      "PUT",
      { kind: "source" },
      {},
      fetch
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "channel_not_joinable" });
    expect(await new TeamChannelBindingStore(env.DB).listByTeam(team.id)).toEqual([]);
    expect(await bindingAudits(team.id)).toEqual([]);
  });

  it("rejects unsuccessful channel lookups and distinguishes unavailable service configuration", async () => {
    const team = await createTeam("engineering");
    const path = `/teams/${team.id}/channel-bindings/slack/C123`;
    for (const fetch of [
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
      vi.fn().mockResolvedValue(new Response("invalid JSON")),
    ]) {
      const response = await request(path, "PUT", { kind: "source" }, {}, fetch);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "channel_not_joinable" });
    }
    for (const overrides of [
      { SLACK_BOT: undefined },
      { SERVICE_AUTH_SECRET_SLACK_BOT: undefined },
    ]) {
      const response = await request(path, "PUT", { kind: "source" }, overrides);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "channel_info_unavailable" });
    }
    const unavailable = await request(
      path,
      "PUT",
      { kind: "source" },
      {},
      vi.fn().mockRejectedValue(new Error("offline"))
    );
    expect(unavailable.status).toBe(503);
    expect(await new TeamChannelBindingStore(env.DB).listByTeam(team.id)).toEqual([]);
  });

  it("requires canManageBindings for every Team binding route, independent of enforcement mode", async () => {
    const team = await createTeam("engineering");
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY.member.id, OWNER)
      .run();
    await new TeamMembershipStore(env.DB).add(team.id, OWNER);
    const fetch = vi.fn().mockResolvedValue(Response.json(channelInfo));
    const slackFetch = vi.fn();
    vi.stubGlobal("fetch", slackFetch);
    for (const mode of ["off", "shadow", "on"]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const path = `/teams/${team.id}/channel-bindings${method === "GET" ? "" : "/slack/C123"}`;
        const denied = await request(
          path,
          method,
          method === "PUT" ? { kind: "source" } : undefined,
          { TEAMS_ENFORCEMENT: mode },
          fetch
        );
        expect(denied.status).toBe(403);
      }
      for (const token of ["xoxb-test", undefined]) {
        const denied = await request(`/teams/${team.id}/slack-channels`, "GET", undefined, {
          TEAMS_ENFORCEMENT: mode,
          SLACK_BOT_TOKEN: token,
        });
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({ code: "team_capability_required" });
      }
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(slackFetch).not.toHaveBeenCalled();
    await new TeamMembershipStore(env.DB).setRole(team.id, OWNER, "lead");
    expect((await request(`/teams/${team.id}/channel-bindings`)).status).toBe(200);
    expect(
      (await request(`/teams/${team.id}/channel-bindings/slack/C123`, "PUT", { kind: "source" }))
        .status
    ).toBe(200);
    const actorless = await serviceFetch(`${BASE}/teams/${team.id}/channel-bindings`, {
      service: "slack-bot",
    });
    expect(actorless.status).toBe(403);
    expect(
      (await serviceFetch(`${BASE}/teams/${team.id}/slack-channels`, { service: "slack-bot" }))
        .status
    ).toBe(403);
  });

  it("lists Slack channel names for a team lead without automation permissions", async () => {
    const team = await createTeam("engineering");
    const otherTeam = await createTeam("other");
    const store = new TeamChannelBindingStore(env.DB);
    await store.put({ ...slackBinding(team.id, "source"), externalId: "C_OWN" }, actor);
    await store.put({ ...slackBinding(otherTeam.id, "source"), externalId: "C_OTHER" }, actor);
    await new TeamMembershipStore(env.DB).add(team.id, OWNER, "lead");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, description, is_system)
         VALUES ('binding_lead', NULL, 'Binding Lead', 'binding lead', NULL, 0)`
      ),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'binding_lead' WHERE user_id = ?"
      ).bind(OWNER),
    ]);
    const slackFetch = vi.fn().mockImplementation(async () =>
      Response.json({
        ok: true,
        channels: [
          { id: "C123", name: "engineering", is_private: false, is_member: true },
          { id: "C_OWN", name: "own-private", is_private: true, is_member: true },
          { id: "C_OTHER", name: "other-private", is_private: true, is_member: true },
          { id: "C_UNBOUND", name: "unbound-private", is_private: true, is_member: true },
        ],
      })
    );
    vi.stubGlobal("fetch", slackFetch);
    expect((await request("/integration-settings/slack/channels")).status).toBe(403);
    expect(slackFetch).not.toHaveBeenCalled();
    const response = await request(`/teams/${team.id}/slack-channels`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      channels: [
        { id: "C123", name: "engineering", isPrivate: false, isMember: true },
        { id: "C_OWN", name: "own-private", isPrivate: true, isMember: true },
      ],
    });
    expect(slackFetch).toHaveBeenCalledOnce();
    expect(slackFetch.mock.calls[0]?.[0]).toContain("https://slack.com/api/conversations.list");
    await env.DB.prepare(
      "INSERT INTO role_permissions (role_id, permission_id) VALUES ('binding_lead', 'automations.read')"
    ).run();
    const globalReader = await request(`/teams/${team.id}/slack-channels`);
    expect(await globalReader.json()).toMatchObject({
      channels: expect.arrayContaining([
        expect.objectContaining({ id: "C_OTHER" }),
        expect.objectContaining({ id: "C_UNBOUND" }),
      ]),
    });
  });

  it("returns conflicts without disclosing another team's identity", async () => {
    const team = await createTeam("engineering");
    const other = await createTeam("other");
    const store = new TeamChannelBindingStore(env.DB);
    await store.put(
      { provider: "slack", externalId: "C123", teamId: other.id, kind: "source" },
      actor
    );
    const response = await request(`/teams/${team.id}/channel-bindings/slack/C123`, "PUT", {
      kind: "source",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Channel binding conflicts with an existing binding",
      code: "channel_binding_conflict",
    });
    expect(await bindingAudits(team.id)).toEqual([]);
  });

  it("rejects unsupported providers and invalid kinds before checking Slack", async () => {
    const team = await createTeam("engineering");
    const fetch = vi.fn();
    for (const provider of ["github", "linear"]) {
      expect(
        (
          await request(
            `/teams/${team.id}/channel-bindings/${provider}/C123`,
            "PUT",
            { kind: "source" },
            {},
            fetch
          )
        ).status
      ).toBe(400);
    }
    expect(
      (
        await request(
          `/teams/${team.id}/channel-bindings/slack/C123`,
          "PUT",
          { kind: "other" },
          {},
          fetch
        )
      ).status
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("service channel binding lookup", () => {
  it("allows unbound DMs under reject policy without exempting regular channels", async () => {
    const unbound = await serviceFetch(`${BASE}/channel-bindings/slack/C123`, {
      service: "slack-bot",
    });
    expect(unbound.status).toBe(200);
    expect(await unbound.json()).toEqual({ teamId: null });
    await new IntegrationSettingsStore(env.DB).setGlobal("slack", {
      defaults: { unboundChannels: "reject" },
    });
    const dm = await serviceFetch(`${BASE}/channel-bindings/slack/D123`, { service: "slack-bot" });
    expect(dm.status).toBe(200);
    expect(await dm.json()).toEqual({ teamId: null });
    for (const channel of ["C123", "G123", "Dinvalid"]) {
      const rejected = await serviceFetch(`${BASE}/channel-bindings/slack/${channel}`, {
        service: "slack-bot",
      });
      expect(rejected.status).toBe(404);
      expect(await rejected.json()).toEqual({
        error: "Channel is not bound",
        code: "channel_unbound",
      });
    }
  });

  it("preserves any explicit DM binding rather than bypassing its team scope", async () => {
    const team = await createTeam("engineering");
    await new TeamChannelBindingStore(env.DB).put(
      { provider: "slack", externalId: "D123", teamId: team.id, kind: "source" },
      actor
    );
    await new IntegrationSettingsStore(env.DB).setGlobal("slack", {
      defaults: { unboundChannels: "reject" },
    });
    const dm = await serviceFetch(`${BASE}/channel-bindings/slack/D123`, { service: "slack-bot" });
    expect(dm.status).toBe(200);
    expect(await dm.json()).toEqual({ teamId: team.id, kind: "source" });
  });

  it("round-trips unboundChannels through the settings API and rejects invalid or repo-scoped policies", async () => {
    const endpoint = `${BASE}/integration-settings/slack`;
    for (const unboundChannels of ["workspace", "reject"]) {
      const updated = await serviceFetch(endpoint, {
        method: "PUT",
        body: JSON.stringify({ settings: { defaults: { unboundChannels } } }),
      });
      expect(updated.status).toBe(200);
      const settings = await serviceFetch(endpoint, { service: "slack-bot" });
      expect(await settings.json()).toEqual({
        integrationId: "slack",
        settings: { defaults: { unboundChannels } },
      });
    }
    expect(
      (
        await serviceFetch(endpoint, {
          method: "PUT",
          body: JSON.stringify({ settings: { defaults: { unboundChannels: "team" } } }),
        })
      ).status
    ).toBe(400);
    expect(
      (
        await serviceFetch(`${endpoint}/repos/acme/widgets`, {
          method: "PUT",
          body: JSON.stringify({ settings: { unboundChannels: "workspace" } }),
        })
      ).status
    ).toBe(400);
    expect(
      (await new IntegrationSettingsStore(env.DB).getGlobal("slack"))?.defaults?.unboundChannels
    ).toBe("reject");
  });

  it("grants actorless lookup only to slack-bot and rejects unsupported providers", async () => {
    const team = await createTeam("engineering");
    await new TeamChannelBindingStore(env.DB).put(slackBinding(team.id, "primary"), actor);
    await new IntegrationSettingsStore(env.DB).setGlobal("slack", {
      defaults: { unboundChannels: "reject" },
    });
    const response = await serviceFetch(`${BASE}/channel-bindings/slack/C123`, {
      service: "slack-bot",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ teamId: team.id, kind: "primary" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    for (const service of ["github-bot", "linear-bot"] as const) {
      expect((await serviceFetch(`${BASE}/channel-bindings/slack/C123`, { service })).status).toBe(
        403
      );
    }
    for (const provider of ["linear", "github"]) {
      const unsupported = await serviceFetch(`${BASE}/channel-bindings/${provider}/C123`, {
        service: "slack-bot",
      });
      expect(unsupported.status).toBe(400);
      expect(await unsupported.json()).toEqual({ error: "Unsupported channel binding provider" });
    }
  });

  it("denies human owners and custom-role integration readers", async () => {
    const team = await createTeam("engineering");
    await new TeamChannelBindingStore(env.DB).put(
      { provider: "slack", externalId: "C123", teamId: team.id, kind: "source" },
      actor
    );
    const endpoint = `${BASE}/channel-bindings/slack/C123`;
    const owner = await serviceFetch(endpoint);
    expect(owner.status).toBe(403);
    expect(await owner.json()).toMatchObject({ code: "service_capability_required" });

    const roleId = "role_channel_binding_integration_reader";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, description, is_system)
         VALUES (?, NULL, 'Integration Reader', 'integration reader', NULL, 0)`
      ).bind(roleId),
      env.DB.prepare(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, 'integrations.read')"
      ).bind(roleId),
      env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
        roleId,
        OWNER
      ),
    ]);
    expect((await serviceFetch(`${BASE}/integration-settings/slack`)).status).toBe(200);
    const reader = await serviceFetch(endpoint);
    expect(reader.status).toBe(403);
    expect(await reader.json()).toMatchObject({ code: "service_capability_required" });
  });

  it.each([
    { service: "github-bot", provider: "github", providerUserId: "208" },
    { service: "linear-bot", provider: "linear", providerUserId: "binding-reader" },
  ] as const)(
    "denies $service even with an owner actor",
    async ({ service, provider, providerUserId }) => {
      const team = await createTeam("engineering");
      await new TeamChannelBindingStore(env.DB).put(
        { provider: "slack", externalId: "C123", teamId: team.id, kind: "source" },
        actor
      );
      await new UserStore(env.DB).createIdentity({ userId: OWNER, provider, providerUserId });
      const denied = await serviceFetch(`${BASE}/channel-bindings/slack/C123`, {
        service,
        actor: `${provider}:${providerUserId}`,
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "service_capability_required" });
    }
  );
});
