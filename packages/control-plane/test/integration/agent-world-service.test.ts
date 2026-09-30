import { beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { UserStore } from "../../src/db/user-store";
import { REPOS_CACHE_KEY, reposCacheIdentity } from "../../src/routes/repos";
import { cleanD1Tables } from "./cleanup";

const AGENT_WORLD_SECRET = "test-service-secret-agent-world";
const MEMBER_ACTOR = "github:4242";
const MANAGED_SESSION_ID = "6a1f0c2e-8b3d-4e5f-9a70-1b2c3d4e5f60";

async function agentWorldFetch(p: {
  method: string;
  path: string;
  body?: string;
  actor?: string;
}): Promise<Response> {
  const url = `https://test.local${p.path}`;
  const headers = await buildServiceAuthHeaders({
    service: "agent-world",
    secret: AGENT_WORLD_SECRET,
    method: p.method,
    url,
    body: p.body,
    actor: p.actor,
  });
  return SELF.fetch(url, {
    method: p.method,
    headers: { "Content-Type": "application/json", ...headers },
    body: p.body,
  });
}

async function seedMember(): Promise<string> {
  const user = await new UserStore(env.DB).resolveOrCreateUser({
    provider: "github",
    providerUserId: "4242",
    displayName: "Existing Member",
  });
  await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
    .bind("role_builtin_member", user.id)
    .run();
  return user.id;
}

async function countUsers(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

async function createSession(): Promise<Response> {
  return agentWorldFetch({
    method: "POST",
    path: "/sessions",
    actor: MEMBER_ACTOR,
    body: JSON.stringify({
      title: "Agent World quest",
      model: "anthropic/claude-haiku-4-5",
      managedSessionId: MANAGED_SESSION_ID,
    }),
  });
}

describe("agent-world service principal", () => {
  beforeEach(cleanD1Tables);

  it("creates, follows, prompts, and stops a session for an existing member", async () => {
    const memberId = await seedMember();

    const created = await createSession();
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ sessionId: MANAGED_SESSION_ID });
    await expect(
      env.DB.prepare(
        "SELECT user_id AS userId, spawn_source AS spawnSource FROM sessions WHERE id = ?"
      )
        .bind(MANAGED_SESSION_ID)
        .first()
    ).resolves.toEqual({ userId: memberId, spawnSource: "agent-world" });

    for (const path of ["events", "artifacts", "messages"]) {
      const read = await agentWorldFetch({
        method: "GET",
        path: `/sessions/${MANAGED_SESSION_ID}/${path}`,
        actor: MEMBER_ACTOR,
      });
      expect(read.status, `GET ${path}`).toBe(200);
    }

    const prompt = await agentWorldFetch({
      method: "POST",
      path: `/sessions/${MANAGED_SESSION_ID}/prompt`,
      actor: MEMBER_ACTOR,
      body: JSON.stringify({ content: "Follow-up from Agent World" }),
    });
    expect(prompt.status).toBe(200);

    const stop = await agentWorldFetch({
      method: "POST",
      path: `/sessions/${MANAGED_SESSION_ID}/stop`,
      actor: MEMBER_ACTOR,
    });
    expect(stop.status).toBe(200);
  });

  it("lists repositories for an existing member", async () => {
    await seedMember();
    await env.REPOS_CACHE.put(
      REPOS_CACHE_KEY,
      JSON.stringify({
        repos: [],
        cachedAt: new Date().toISOString(),
        scmIdentity: await reposCacheIdentity(env),
        freshUntil: Date.now() + 60_000,
      })
    );

    const response = await agentWorldFetch({ method: "GET", path: "/repos", actor: MEMBER_ACTOR });

    expect(response.status).toBe(200);
  });

  it.each([
    ["POST", "pr", { title: "Unapproved", body: "Should not open" }],
    ["POST", "slack-notify", { text: "Should not post" }],
  ] as const)(
    "refuses %s /sessions/:id/%s even for an existing member",
    async (method, path, body) => {
      await seedMember();
      expect((await createSession()).status).toBe(201);

      const response = await agentWorldFetch({
        method,
        path: `/sessions/${MANAGED_SESSION_ID}/${path}`,
        actor: MEMBER_ACTOR,
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "service_route_not_allowed" });
    }
  );

  it("rejects an unknown GitHub actor without enrolling a user", async () => {
    const before = await countUsers();

    const response = await agentWorldFetch({
      method: "POST",
      path: "/sessions",
      actor: "github:9999",
      body: JSON.stringify({ title: "Stranger", model: "anthropic/claude-haiku-4-5" }),
    });

    expect(response.status).toBe(401);
    expect(await countUsers()).toBe(before);
    await expect(new UserStore(env.DB).getIdentity("github", "9999")).resolves.toBeNull();
  });

  it("refuses to act for a suspended member", async () => {
    const memberId = await seedMember();
    await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(memberId).run();

    const response = await createSession();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "active_user_required" });
  });
});
