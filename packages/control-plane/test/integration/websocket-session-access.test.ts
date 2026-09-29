import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { cleanD1Tables } from "./cleanup";
import { setSessionTeamsEnforcementMode } from "./session-do-access";
import {
  collectMessages,
  initNamedSession,
  issueClientWsToken,
  openClientWs,
  routeRequest,
  serviceRequestHeaders,
  waitForSandboxStatus,
} from "./helpers";

describe("session WebSocket D1 access", () => {
  beforeEach(cleanD1Tables);

  async function scopedSession(visibility: "team" | "private", mode?: "on") {
    const name = `ws-access-${crypto.randomUUID()}`;
    const { stub } = await initNamedSession(
      name,
      undefined,
      mode ? (sessionStub) => setSessionTeamsEnforcementMode(sessionStub, mode) : undefined
    );
    await waitForSandboxStatus(stub, "failed");
    const team = await new TeamStore(env.DB).create({
      slug: `ws-${crypto.randomUUID()}`,
      name: "Socket team",
      joinPolicy: "invite_only",
    });
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ?, visibility = ? WHERE id = ?")
      .bind(team.id, visibility, name)
      .run();
    return { name, team };
  }

  it("rejects a still-valid token after private access is removed and refuses re-mint", async () => {
    const { name } = await scopedSession("private");
    const userId = crypto.randomUUID().replaceAll("-", "");
    const url = `https://test.local/sessions/${name}/ws-token`;
    const headers = await serviceRequestHeaders(url, {
      method: "POST",
      as: { userId, role: "member" },
    });
    const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
    const collaborators = new SessionCollaboratorStore(env.DB);
    await collaborators.add(name, userId, "user-1");

    const { ws } = await openClientWs(name);
    const subscribed = collectMessages(ws, { until: (message) => message.type === "subscribed" });
    ws.send(JSON.stringify({ type: "subscribe", token, clientId: "collaborator" }));
    expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);
    await collaborators.remove(name, userId);

    const denied = collectMessages(ws, { until: (message) => message.type === "error" });
    ws.send(JSON.stringify({ type: "fetch_history", cursor: { timestamp: 0, id: "event" } }));
    expect((await denied).find((message) => message.type === "error")).toMatchObject({
      code: "PERMISSION_REQUIRED",
    });
    ws.close();

    const { ws: stale } = await openClientWs(name);
    const closed = new Promise<number>((resolve) =>
      stale.addEventListener("close", (event) => resolve(event.code))
    );
    stale.send(JSON.stringify({ type: "subscribe", token, clientId: "stale" }));
    await expect(closed).resolves.toBe(4010);

    const response = await routeRequest(
      new Request(url, {
        method: "POST",
        headers,
      }),
      { ...env, TEAMS_ENFORCEMENT: "on" },
      createExecutionContext()
    );
    expect(response.status).toBe(404);
  });

  it("samples team permissions in shadow and rechecks the private row on the next command", async () => {
    const { name, team } = await scopedSession("team");
    const userId = `team-member-${crypto.randomUUID()}`;
    const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
    await new TeamMembershipStore(env.DB).add(team.id, userId);
    const { ws } = await openClientWs(name);
    const subscribed = collectMessages(ws, { until: (message) => message.type === "subscribed" });
    ws.send(JSON.stringify({ type: "subscribe", token, clientId: "member" }));
    expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);

    await new TeamMembershipStore(env.DB).remove(team.id, userId);
    await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
      .bind(name)
      .run();
    const denied = collectMessages(ws, { until: (message) => message.type === "error" });
    ws.send(JSON.stringify({ type: "presence", status: "idle" }));
    expect((await denied).find((message) => message.type === "error")).toMatchObject({
      code: "PERMISSION_REQUIRED",
    });
    ws.close();
  });

  it("denies a member of another team at subscribe with enforcement on", async () => {
    const { name } = await scopedSession("team", "on");
    const otherTeam = await new TeamStore(env.DB).create({
      slug: `other-${crypto.randomUUID()}`,
      name: "Other team",
      joinPolicy: "invite_only",
    });
    const userId = `other-team-member-${crypto.randomUUID()}`;
    const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
    await new TeamMembershipStore(env.DB).add(otherTeam.id, userId);

    const { ws } = await openClientWs(name);
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code))
    );
    ws.send(JSON.stringify({ type: "subscribe", token, clientId: "other-team" }));

    await expect(closed).resolves.toBe(4010);
  });

  it("rechecks membership removal and a team move on the next command with enforcement on", async () => {
    const { name, team } = await scopedSession("team", "on");
    const userId = `removed-team-member-${crypto.randomUUID()}`;
    const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
    const memberships = new TeamMembershipStore(env.DB);
    await memberships.add(team.id, userId);

    const { ws } = await openClientWs(name);
    const subscribed = collectMessages(ws, { until: (message) => message.type === "subscribed" });
    ws.send(JSON.stringify({ type: "subscribe", token, clientId: "member" }));
    expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);

    await memberships.remove(team.id, userId);
    const deniedPrompt = collectMessages(ws, { until: (message) => message.type === "error" });
    ws.send(JSON.stringify({ type: "prompt", content: "not allowed", clientRequestId: "removed" }));
    expect((await deniedPrompt).find((message) => message.type === "error")).toMatchObject({
      code: "PERMISSION_REQUIRED",
    });

    await memberships.add(team.id, userId);
    const newTeam = await new TeamStore(env.DB).create({
      slug: `moved-${crypto.randomUUID()}`,
      name: "Destination team",
      joinPolicy: "invite_only",
    });
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ? WHERE id = ?")
      .bind(newTeam.id, name)
      .run();
    const deniedPresence = collectMessages(ws, { until: (message) => message.type === "error" });
    ws.send(JSON.stringify({ type: "presence", status: "idle" }));
    expect((await deniedPresence).find((message) => message.type === "error")).toMatchObject({
      code: "PERMISSION_REQUIRED",
    });
    ws.close();
  });
});
