import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { SessionIndexStore } from "../../src/db/session-index";
import { UserStore, type User } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceRequestHeaders, type ServiceRequestInit } from "./helpers";

const BASE = "https://test.local";
const OWNER = "11111111111111111111111111111111";
const WORKSPACE_OWNER = "22222222222222222222222222222222";
const OUTSIDER = "33333333333333333333333333333333";

async function request(path: string, init: ServiceRequestInit = {}, mode = "off") {
  const url = `${BASE}${path}`;
  return routeRequest(
    new Request(url, {
      method: init.method ?? "GET",
      headers: await serviceRequestHeaders(url, init),
    }),
    { ...env, TEAMS_ENFORCEMENT: mode },
    createExecutionContext()
  );
}

describe("session collaborator candidates", () => {
  let candidate: User;

  beforeEach(async () => {
    await cleanD1Tables();
    await serviceRequestHeaders(`${BASE}/me/authorization`, {
      as: { userId: OWNER, role: "member" },
    });
    candidate = await new UserStore(env.DB).createUser({
      displayName: "Ada",
      email: "ada@example.com",
      avatarUrl: "https://example.com/ada.png",
    });
    await new SessionIndexStore(env.DB).create({
      id: "private-session",
      ownerTeamId: null,
      visibility: "private",
      userId: OWNER,
      title: null,
      repoOwner: null,
      repoName: null,
      baseBranch: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      status: "created",
      createdAt: 1,
      updatedAt: 1,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("lets a Member owner list minimal picker identities, add, and remove without directory access", async () => {
    const response = await request("/sessions/private-session/collaborator-candidates");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual([
      {
        userId: candidate.id,
        displayName: "Ada",
        email: null,
        avatarUrl: "https://example.com/ada.png",
      },
      {
        userId: OWNER,
        displayName: "Integration Browser User",
        email: null,
        avatarUrl: `${OWNER}@test.local`,
      },
    ]);
    expect((await request("/members")).status).toBe(403);
    const path = `/sessions/private-session/collaborators/${candidate.id}`;
    expect((await request(path, { method: "PUT" })).status).toBe(200);
    expect(await new SessionCollaboratorStore(env.DB).listUserIds("private-session")).toEqual([
      candidate.id,
    ]);
    expect((await request(path, { method: "DELETE" })).status).toBe(200);
    expect(await new SessionCollaboratorStore(env.DB).listUserIds("private-session")).toEqual([]);
  });

  it.each(["off", "shadow", "on"])(
    "returns emails only to a session owner with workspace member read permission in %s mode",
    async (mode) => {
      for (const role of ["member", "administrator"] as const) {
        await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
          .bind(BUILT_IN_ROLE_REGISTRY[role].id, OWNER)
          .run();
        const response = await request(
          "/sessions/private-session/collaborator-candidates",
          {},
          mode
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([
          {
            userId: candidate.id,
            displayName: "Ada",
            email: role === "administrator" ? candidate.email : null,
            avatarUrl: candidate.avatarUrl,
          },
          {
            userId: OWNER,
            displayName: "Integration Browser User",
            email: role === "administrator" ? `${OWNER}@test.local` : null,
            avatarUrl: `${OWNER}@test.local`,
          },
        ]);
      }
    }
  );

  it("excludes suspended and unassigned users while retaining nullable identity fields", async () => {
    const users = new UserStore(env.DB);
    const suspended = await users.createUser({ displayName: "Suspended" });
    const unassigned = await users.createUser({ displayName: "Unassigned" });
    const unnamed = await users.createUser({});
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(suspended.id),
      env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").bind(unassigned.id),
    ]);
    const response = await request("/sessions/private-session/collaborator-candidates");
    expect(response.status).toBe(200);
    const body = await response.json<Array<{ userId: string }>>();
    expect(body.map((user) => user.userId)).toEqual(
      expect.arrayContaining([OWNER, candidate.id, unnamed.id])
    );
    expect(body).toHaveLength(3);
    expect(body).toContainEqual({
      userId: unnamed.id,
      displayName: null,
      email: null,
      avatarUrl: null,
    });
  });

  it.each(["off", "shadow", "on"])(
    "denies a readable nonowner collaborator before the directory handler in %s mode",
    async (mode) => {
      await new SessionCollaboratorStore(env.DB).add("private-session", candidate.id, OWNER);
      const directory = vi.spyOn(UserStore.prototype, "listCollaboratorCandidates");
      const response = await request(
        "/sessions/private-session/collaborator-candidates",
        { as: { userId: candidate.id, role: "member" } },
        mode
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "session_action_denied",
        reason_code: "not_owner_or_lead",
      });
      expect(directory).not.toHaveBeenCalled();
      expect(
        (
          await request(`/sessions/private-session/collaborators/${OWNER}`, {
            method: "PUT",
            as: { userId: candidate.id, role: "member" },
          })
        ).status
      ).toBe(403);
    }
  );

  it.each(["off", "shadow", "on"])(
    "conceals invisible and missing sessions with identical 404s and no directory handler in %s mode",
    async (mode) => {
      const directory = vi.spyOn(UserStore.prototype, "listCollaboratorCandidates");
      const bodies = [];
      for (const id of ["private-session", "missing-session"]) {
        const response = await request(
          `/sessions/${id}/collaborator-candidates`,
          { as: { userId: OUTSIDER, role: "member" } },
          mode
        );
        expect(response.status).toBe(404);
        bodies.push(await response.json());
      }
      expect(bodies).toEqual([{ error: "Session not found" }, { error: "Session not found" }]);
      expect(directory).not.toHaveBeenCalled();
    }
  );

  it("allows an audited workspace-owner break-glass picker read", async () => {
    const response = await request("/sessions/private-session/collaborator-candidates", {
      as: { userId: WORKSPACE_OWNER, role: "owner" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: candidate.id })])
    );
    const audit = await env.DB.prepare(
      "SELECT actor_user_id_snapshot, resource_id FROM authorization_audit_events WHERE action = 'session.private_break_glass'"
    ).all();
    expect(audit.results).toEqual([
      { actor_user_id_snapshot: WORKSPACE_OWNER, resource_id: "private-session" },
    ]);
  });

  it("refuses service principals even with a user actor", async () => {
    await new UserStore(env.DB).createIdentity({
      userId: OWNER,
      provider: "slack",
      providerUserId: "U-OWNER",
    });
    const directory = vi.spyOn(UserStore.prototype, "listCollaboratorCandidates");
    const response = await request("/sessions/private-session/collaborator-candidates", {
      service: "slack-bot",
      actor: "slack:U-OWNER",
    });
    expect(response.status).toBe(403);
    expect(directory).not.toHaveBeenCalled();
  });

  it.each(["suspended", "unassigned"])("refuses an %s session owner", async (state) => {
    await env.DB.prepare(
      state === "suspended"
        ? "UPDATE users SET suspended_at = 1 WHERE id = ?"
        : "DELETE FROM user_role_assignments WHERE user_id = ?"
    )
      .bind(OWNER)
      .run();
    const directory = vi.spyOn(UserStore.prototype, "listCollaboratorCandidates");
    const response = await request("/sessions/private-session/collaborator-candidates");
    expect(response.status).toBe(403);
    expect(directory).not.toHaveBeenCalled();
  });
});
