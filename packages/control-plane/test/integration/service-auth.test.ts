import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import {
  ACTOR_HEADER,
  buildServiceAuthHeaders,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  type ServiceName,
} from "@open-inspect/shared/service-auth";
import { generateInternalToken } from "@open-inspect/shared/auth";
import { GlobalSecretsStore } from "../../src/db/global-secrets";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";

const SERVICE_SECRET: Record<ServiceName, string> = {
  web: "test-service-secret-web",
  "slack-bot": "test-service-secret-slack-bot",
  "github-bot": "test-service-secret-github-bot",
  "linear-bot": "test-service-secret-linear-bot",
};

async function signedFetch(p: {
  service: ServiceName;
  method: string;
  url: string;
  body?: string;
  actor?: string;
  mutateHeaders?: (headers: Record<string, string>) => void;
}): Promise<Response> {
  const headers = await buildServiceAuthHeaders({
    service: p.service,
    secret: SERVICE_SECRET[p.service],
    method: p.method,
    url: p.url,
    body: p.body,
    actor: p.actor,
  });
  p.mutateHeaders?.(headers);
  return SELF.fetch(p.url, {
    method: p.method,
    headers: { "Content-Type": "application/json", ...headers },
    body: p.body,
  });
}

describe("sig1 service-credential authentication", () => {
  beforeEach(cleanD1Tables);

  it("rejects actorless service requests on broad routes", async () => {
    for (const service of Object.keys(SERVICE_SECRET).filter(
      (candidate): candidate is Exclude<ServiceName, "web"> => candidate !== "web"
    )) {
      const response = await signedFetch({
        service,
        method: "GET",
        url: "https://test.local/sessions",
      });
      expect(response.status, service).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "service_actor_required" });
    }
  });

  it.each([
    ["slack-bot", "/repos", 200],
    ["linear-bot", "/repos", 200],
    ["github-bot", "/repos/acme/widgets/metadata", 200],
    ["slack-bot", "/environments", 200],
    ["linear-bot", "/environments", 200],
    ["github-bot", "/environments/missing", 404],
    ["slack-bot", "/integration-settings/slack", 200],
    ["slack-bot", "/integration-settings/slack/watched-channels", 200],
    ["slack-bot", "/model-preferences", 200],
  ] as const)(
    "allows actorless %s metadata/config read %s",
    async (service, path, expectedStatus) => {
      if (path === "/repos") {
        await env.REPOS_CACHE.put(
          "repos:list:v2",
          JSON.stringify({
            repos: [],
            cachedAt: new Date().toISOString(),
            freshUntil: Date.now() + 60_000,
          })
        );
      }
      const response = await signedFetch({
        service,
        method: "GET",
        url: `https://test.local${path}`,
      });
      expect(response.status).toBe(expectedStatus);
    }
  );

  it("denies an actorless service without the route's exact grant", async () => {
    const response = await signedFetch({
      service: "linear-bot",
      method: "GET",
      url: "https://test.local/integration-settings/slack",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_actor_required" });
  });

  it("denies actorless resolved settings for the wrong integration", async () => {
    const response = await signedFetch({
      service: "github-bot",
      method: "GET",
      url: "https://test.local/integration-settings/linear/resolved/acme/widgets",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_actor_required" });
  });

  it.each([
    ["github-bot", "github"],
    ["linear-bot", "linear"],
  ] as const)(
    "authorizes actorless %s only for matching resolved settings",
    async (service, id) => {
      const response = await signedFetch({
        service,
        method: "GET",
        url: `https://test.local/integration-settings/${id}/resolved/missing/repository`,
      });

      expect(response.status).not.toBe(403);
    }
  );

  it("requires a browser session in addition to the web service channel", async () => {
    const response = await signedFetch({
      service: "web",
      method: "GET",
      url: "https://test.local/sessions",
    });
    expect(response.status).toBe(401);
  });

  it("accepts a signed request with a query string regardless of param order", async () => {
    const createdBy = "a".repeat(32);
    const signedUrl = `https://test.local/sessions?limit=5&createdBy=${createdBy}`;
    const headers = await buildServiceAuthHeaders({
      service: "linear-bot",
      secret: SERVICE_SECRET["linear-bot"],
      method: "GET",
      url: signedUrl,
      actor: "linear:query-order",
    });
    const response = await SELF.fetch(
      `https://test.local/sessions?createdBy=${createdBy}&limit=5`,
      {
        headers,
      }
    );
    expect(response.status).toBe(200);
  });

  it("does not let an actorless service mutate global secrets", async () => {
    const response = await signedFetch({
      service: "linear-bot",
      method: "PUT",
      url: "https://test.local/secrets",
      body: JSON.stringify({ secrets: { SIGNED_BODY_TEST: "intact" } }),
    });
    expect(response.status).toBe(403);

    const secrets = await new GlobalSecretsStore(
      env.DB,
      env.REPO_SECRETS_ENCRYPTION_KEY!
    ).getDecryptedSecrets();
    expect(secrets.SIGNED_BODY_TEST).toBeUndefined();
  });

  it("rejects a body tampered after signing", async () => {
    const url = "https://test.local/secrets";
    const intactBody = JSON.stringify({ secrets: { SIGNED_BODY_TEST: "intact" } });
    const headers = await buildServiceAuthHeaders({
      service: "linear-bot",
      secret: SERVICE_SECRET["linear-bot"],
      method: "PUT",
      url,
      body: intactBody,
      actor: "linear:tamper-test",
    });
    const intact = await SELF.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: intactBody,
    });
    expect(intact.status).toBe(403);

    const tampered = await SELF.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ secrets: { SIGNED_BODY_TEST: "tampered" } }),
    });
    expect(tampered.status).toBe(401);
  });

  it("rejects a signature replayed against a different method or path", async () => {
    const url = "https://test.local/sessions";
    const headers = await buildServiceAuthHeaders({
      service: "web",
      secret: SERVICE_SECRET.web,
      method: "GET",
      url,
    });
    const wrongPath = await SELF.fetch("https://test.local/repos", { headers });
    expect(wrongPath.status).toBe(401);

    const wrongMethod = await SELF.fetch(url, { method: "POST", headers });
    expect(wrongMethod.status).toBe(401);
  });

  it("rejects a query string added after signing", async () => {
    const headers = await buildServiceAuthHeaders({
      service: "web",
      secret: SERVICE_SECRET.web,
      method: "GET",
      url: "https://test.local/sessions",
    });
    const response = await SELF.fetch("https://test.local/sessions?createdBy=someone-else", {
      headers,
    });
    expect(response.status).toBe(401);
  });

  it("rejects an actor header rewritten after signing", async () => {
    const response = await signedFetch({
      service: "slack-bot",
      method: "GET",
      url: "https://test.local/sessions",
      actor: "slack:U0001",
      mutateHeaders: (headers) => {
        headers[ACTOR_HEADER] = "slack:U0002";
      },
    });
    expect(response.status).toBe(401);
  });

  it("denies actors outside the service's namespace", async () => {
    const response = await signedFetch({
      service: "slack-bot",
      method: "GET",
      url: "https://test.local/sessions",
      actor: "github:1",
    });
    expect(response.status).toBe(401);
  });

  it("denies actor assertions from web", async () => {
    const response = await signedFetch({
      service: "web",
      method: "GET",
      url: "https://test.local/sessions",
      actor: "slack:U1",
    });
    expect(response.status).toBe(401);
  });

  it("persists bot creator attribution and permits cross-actor collaboration", async () => {
    const created = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "slack:U0001",
      body: JSON.stringify({
        title: "Slack-owned session",
        model: "anthropic/claude-haiku-4-5",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json<{ sessionId: string }>();

    const identity = await new UserStore(env.DB).getIdentity("slack", "U0001");
    expect(identity).not.toBeNull();
    const listed = await signedFetch({
      service: "slack-bot",
      method: "GET",
      url: "https://test.local/sessions",
      actor: "slack:U0001",
    });
    const body = await listed.json<{
      sessions: Array<{ title: string; userId: string; spawnSource: string }>;
    }>();
    expect(body.sessions).toContainEqual(
      expect.objectContaining({
        title: "Slack-owned session",
        userId: identity!.userId,
        spawnSource: "slack-bot",
      })
    );

    const collaboratorList = await signedFetch({
      service: "slack-bot",
      method: "GET",
      url: "https://test.local/sessions",
      actor: "slack:U0002",
    });
    expect(collaboratorList.status).toBe(200);
    await expect(collaboratorList.json()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ title: "Slack-owned session" })],
    });

    const collaborator = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: `https://test.local/sessions/${createdBody.sessionId}/prompt`,
      actor: "slack:U0002",
      body: JSON.stringify({ content: "Cross-session prompt" }),
    });
    expect(collaborator.status).toBe(200);

    const deniedByServiceCeiling = await signedFetch({
      service: "slack-bot",
      method: "DELETE",
      url: `https://test.local/sessions/${createdBody.sessionId}`,
      actor: "slack:U0002",
    });
    expect(deniedByServiceCeiling.status).toBe(403);
    await expect(deniedByServiceCeiling.json()).resolves.toMatchObject({
      code: "service_capability_required",
    });
  });

  it("allows only narrow actorless session callbacks and completion reads", async () => {
    const created = await signedFetch({
      service: "linear-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "linear:U-CREATOR",
      body: JSON.stringify({
        title: "Linear callback session",
        model: "anthropic/claude-haiku-4-5",
      }),
    });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json<{ sessionId: string }>();

    const linearStop = await signedFetch({
      service: "linear-bot",
      method: "POST",
      url: `https://test.local/sessions/${sessionId}/stop`,
    });
    expect(linearStop.status).not.toBe(403);

    for (const service of ["slack-bot", "linear-bot"] as const) {
      for (const path of ["events", "artifacts"] as const) {
        const completionRead = await signedFetch({
          service,
          method: "GET",
          url: `https://test.local/sessions/${sessionId}/${path}`,
        });
        expect(completionRead.status, `${service} GET ${path}`).not.toBe(403);
      }
    }

    const slackMedia = await signedFetch({
      service: "slack-bot",
      method: "GET",
      url: `https://test.local/sessions/${sessionId}/media/missing-artifact`,
    });
    expect(slackMedia.status).not.toBe(403);

    const wrongService = await signedFetch({
      service: "github-bot",
      method: "POST",
      url: `https://test.local/sessions/${sessionId}/stop`,
    });
    expect(wrongService.status).toBe(403);
    await expect(wrongService.json()).resolves.toMatchObject({ code: "service_actor_required" });
  });

  it("denies suspended canonical bot actors and actorless broad requests", async () => {
    await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "slack:U-SUSPENDED",
      body: JSON.stringify({ title: "Actor session", model: "anthropic/claude-haiku-4-5" }),
    });
    const identity = await new UserStore(env.DB).getIdentity("slack", "U-SUSPENDED");
    await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?")
      .bind(identity!.userId)
      .run();

    const attributed = await signedFetch({
      service: "slack-bot",
      method: "GET",
      url: "https://test.local/sessions",
      actor: "slack:U-SUSPENDED",
    });
    const actorless = await signedFetch({
      service: "slack-bot",
      method: "GET",
      url: "https://test.local/sessions",
    });

    expect(attributed.status).toBe(403);
    await expect(attributed.json()).resolves.toMatchObject({ code: "active_user_required" });
    expect(actorless.status).toBe(403);
    await expect(actorless.json()).resolves.toMatchObject({ code: "service_actor_required" });
  });

  it("intersects an actor role with the service ceiling", async () => {
    await signedFetch({
      service: "slack-bot",
      method: "GET",
      url: "https://test.local/sessions",
      actor: "slack:U-VIEWER",
    });
    const identity = await new UserStore(env.DB).getIdentity("slack", "U-VIEWER");
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind("role_builtin_viewer", identity!.userId)
      .run();

    const response = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "slack:U-VIEWER",
      body: JSON.stringify({ title: "Viewer session", model: "anthropic/claude-haiku-4-5" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "sessions.create",
    });
  });

  it("denies a first-contact Slack actor using the Viewer role selected by its attested email", async () => {
    const users = new UserStore(env.DB);
    const viewer = await users.createUser({
      displayName: "Existing Viewer",
      email: "viewer@corp.test",
      emailVerified: true,
    });
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind("role_builtin_viewer", viewer.id)
      .run();

    const response = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "slack:U-FIRST-CONTACT-VIEWER",
      body: JSON.stringify({
        title: "Must not be created",
        model: "anthropic/claude-haiku-4-5",
        actorEmail: "viewer@corp.test",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "sessions.create",
    });
    await expect(users.getIdentity("slack", "U-FIRST-CONTACT-VIEWER")).resolves.toMatchObject({
      userId: viewer.id,
    });
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions) AS sessions,
           (SELECT COUNT(*) FROM users) AS users`
      ).first<{ sessions: number; users: number }>()
    ).resolves.toEqual({ sessions: 0, users: 1 });
  });

  it("rejects bot automation creation at the service ceiling without enrolling its actor", async () => {
    const response = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/automations",
      actor: "slack:U-AUTOMATION-DENIED",
      body: JSON.stringify({
        name: "Denied automation",
        instructions: "Must not run",
        scheduleCron: "0 9 * * *",
        scheduleTz: "UTC",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "service_capability_required",
    });
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM user_identities) AS identities,
           (SELECT COUNT(*) FROM user_role_assignments) AS assignments,
           (SELECT COUNT(*) FROM automations) AS automations`
      ).first<{
        users: number;
        identities: number;
        assignments: number;
        automations: number;
      }>()
    ).resolves.toEqual({ users: 0, identities: 0, assignments: 0, automations: 0 });
  });

  it("does not enroll an actor on an exact-service internal route", async () => {
    const response = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/internal/slack-event",
      actor: "slack:U-INTERNAL-NONMEMBER",
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Invalid event"),
    });
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM user_identities) AS identities,
           (SELECT COUNT(*) FROM user_role_assignments) AS assignments`
      ).first<{ users: number; identities: number; assignments: number }>()
    ).resolves.toEqual({ users: 0, identities: 0, assignments: 0 });
  });

  it("creates a session for the active Member selected by a first-contact Slack email claim", async () => {
    const users = new UserStore(env.DB);
    const member = await users.createUser({
      displayName: "Existing Member",
      email: "member@corp.test",
      emailVerified: true,
    });
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind("role_builtin_member", member.id)
      .run();

    const response = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "slack:U-FIRST-CONTACT-MEMBER",
      body: JSON.stringify({
        title: "Readable after claim extraction",
        model: "anthropic/claude-haiku-4-5",
        actorEmail: "member@corp.test",
      }),
    });

    expect(response.status).toBe(201);
    await expect(users.getIdentity("slack", "U-FIRST-CONTACT-MEMBER")).resolves.toMatchObject({
      userId: member.id,
    });
    await expect(
      env.DB.prepare("SELECT title, user_id AS userId FROM sessions").first<{
        title: string;
        userId: string;
      }>()
    ).resolves.toEqual({ title: "Readable after claim extraction", userId: member.id });
  });

  it("denies a first-contact Linear actor whose attested email selects a suspended Member", async () => {
    const users = new UserStore(env.DB);
    const suspended = await users.createUser({
      displayName: "Suspended Member",
      email: "suspended@corp.test",
      emailVerified: true,
    });
    await env.DB.batch([
      env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
        "role_builtin_member",
        suspended.id
      ),
      env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").bind(1, suspended.id),
    ]);

    const response = await signedFetch({
      service: "linear-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "linear:FIRST-CONTACT-SUSPENDED",
      body: JSON.stringify({
        title: "Must not be created",
        model: "anthropic/claude-haiku-4-5",
        actorEmail: "suspended@corp.test",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "active_user_required" });
    await expect(users.getIdentity("linear", "FIRST-CONTACT-SUSPENDED")).resolves.toMatchObject({
      userId: suspended.id,
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{ count: number }>()
    ).resolves.toMatchObject({ count: 0 });
  });

  it("denies a first-contact actor whose attested email selects an unassigned user", async () => {
    const users = new UserStore(env.DB);
    const unassigned = await users.createUser({
      displayName: "Unassigned User",
      email: "unassigned@corp.test",
      emailVerified: true,
    });
    await env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?")
      .bind(unassigned.id)
      .run();

    const response = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "slack:U-FIRST-CONTACT-UNASSIGNED",
      body: JSON.stringify({
        title: "Must not be created",
        model: "anthropic/claude-haiku-4-5",
        actorEmail: "unassigned@corp.test",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "assignment_required" });
    await expect(users.getIdentity("slack", "U-FIRST-CONTACT-UNASSIGNED")).resolves.toMatchObject({
      userId: unassigned.id,
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{ count: number }>()
    ).resolves.toMatchObject({ count: 0 });
  });

  it.each([
    [
      "repository",
      "repositories.use",
      "role_session_creator_without_repo_use",
      "U-FIRST-CONTACT-CONSTRAINED-REPO",
      { repoOwner: "acme", repoName: "widgets" },
    ],
    [
      "environment",
      "environments.use",
      "role_session_creator_without_environment_use",
      "U-FIRST-CONTACT-CONSTRAINED-ENV",
      { environmentId: "missing-environment" },
    ],
  ] as const)(
    "uses the first-contact canonical actor's custom-role %s target permissions",
    async (_targetKind, expectedPermission, roleId, providerUserId, target) => {
      const users = new UserStore(env.DB);
      const constrained = await users.createUser({
        displayName: "Constrained Session Creator",
        email: "constrained@corp.test",
        emailVerified: true,
      });
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO roles
          (id, key, name, normalized_name, description, is_system)
         VALUES (?, NULL, ?, ?, NULL, 0)`
        ).bind(
          roleId,
          `Session Creator ${providerUserId}`,
          `session creator ${providerUserId.toLowerCase()}`
        ),
        env.DB.prepare(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, 'sessions.create')"
        ).bind(roleId),
        env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
          roleId,
          constrained.id
        ),
      ]);

      const response = await signedFetch({
        service: "slack-bot",
        method: "POST",
        url: "https://test.local/sessions",
        actor: `slack:${providerUserId}`,
        body: JSON.stringify({
          ...target,
          title: "Must not use the target",
          model: "anthropic/claude-haiku-4-5",
          actorEmail: "constrained@corp.test",
        }),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "permission_required",
        permission: expectedPermission,
      });
      await expect(users.getIdentity("slack", providerUserId)).resolves.toMatchObject({
        userId: constrained.id,
      });
      await expect(
        env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{ count: number }>()
      ).resolves.toMatchObject({ count: 0 });
    }
  );

  it.each([
    [
      "forbidden identity fields",
      "U-FIRST-CONTACT-FORBIDDEN-BODY",
      JSON.stringify({
        title: "Forbidden body",
        model: "anthropic/claude-haiku-4-5",
        actorEmail: "body-target@corp.test",
        userId: "caller-controlled-user",
      }),
    ],
    [
      "malformed JSON",
      "U-FIRST-CONTACT-MALFORMED-BODY",
      '{"title":"Malformed","actorEmail":"body-target@corp.test"',
    ],
  ])("rejects %s before enrolling the actor", async (_caseName, providerUserId, body) => {
    const users = new UserStore(env.DB);
    const bodyTarget = await users.createUser({
      displayName: "Body Target",
      email: "body-target@corp.test",
      emailVerified: true,
    });
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind("role_builtin_viewer", bodyTarget.id)
      .run();

    const response = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: `slack:${providerUserId}`,
      body,
    });

    expect(response.status).toBe(400);
    await expect(users.getIdentity("slack", providerUserId)).resolves.toBeNull();
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions) AS sessions,
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM user_identities) AS identities`
      ).first<{ sessions: number; users: number; identities: number }>()
    ).resolves.toEqual({ sessions: 0, users: 1, identities: 0 });
    void bodyTarget;
  });

  it("does not relink a known actor when a session body carries a conflicting email", async () => {
    const users = new UserStore(env.DB);
    const knownActor = await users.resolveOrCreateUser({
      provider: "slack",
      providerUserId: "U-KNOWN-IMMUTABLE",
      displayName: "Known Actor",
    });
    const conflictingViewer = await users.createUser({
      displayName: "Conflicting Viewer",
      email: "conflicting-viewer@corp.test",
      emailVerified: true,
    });
    await env.DB.batch([
      env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
        "role_builtin_member",
        knownActor.id
      ),
      env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
        "role_builtin_viewer",
        conflictingViewer.id
      ),
    ]);

    const response = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "slack:U-KNOWN-IMMUTABLE",
      body: JSON.stringify({
        title: "Known actor remains canonical",
        model: "anthropic/claude-haiku-4-5",
        actorEmail: "conflicting-viewer@corp.test",
      }),
    });

    expect(response.status).toBe(201);
    await expect(users.getIdentity("slack", "U-KNOWN-IMMUTABLE")).resolves.toMatchObject({
      userId: knownActor.id,
      providerEmail: null,
    });
    await expect(
      env.DB.prepare("SELECT user_id AS userId FROM sessions").first<{ userId: string }>()
    ).resolves.toEqual({ userId: knownActor.id });
  });

  it("does not let a GitHub body email select an existing canonical user", async () => {
    const users = new UserStore(env.DB);
    const viewer = await users.createUser({
      displayName: "Existing Viewer",
      email: "github-body-target@corp.test",
      emailVerified: true,
    });
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind("role_builtin_viewer", viewer.id)
      .run();

    const response = await signedFetch({
      service: "github-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "github:987654321",
      body: JSON.stringify({
        title: "GitHub email is cosmetic",
        model: "anthropic/claude-haiku-4-5",
        actorEmail: "github-body-target@corp.test",
      }),
    });

    expect(response.status).toBe(201);
    const identity = await users.getIdentity("github", "987654321");
    expect(identity).toMatchObject({ providerEmail: null });
    expect(identity?.userId).not.toBe(viewer.id);
    await expect(
      env.DB.prepare("SELECT user_id AS userId FROM sessions").first<{ userId: string }>()
    ).resolves.toEqual({ userId: identity!.userId });
  });

  it("requires a user or signed actor before any service can create a session", async () => {
    for (const service of Object.keys(SERVICE_SECRET) as ServiceName[]) {
      const response = await signedFetch({
        service,
        method: "POST",
        url: "https://test.local/sessions",
        body: JSON.stringify({
          title: "Actorless session",
          model: "anthropic/claude-haiku-4-5",
        }),
      });
      expect(response.status, service).toBe(service === "web" ? 401 : 403);
    }

    const sessionCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{
      n: number;
    }>();
    expect(sessionCount?.n).toBe(0);
  });

  it("rejects an unknown service name", async () => {
    const response = await signedFetch({
      service: "linear-bot",
      method: "GET",
      url: "https://test.local/sessions",
      mutateHeaders: (headers) => {
        headers[SERVICE_HEADER] = "not-a-service";
      },
    });
    expect(response.status).toBe(401);
  });

  it("a failed service signature is terminal even with a bearer alongside", async () => {
    const response = await signedFetch({
      service: "web",
      method: "GET",
      url: "https://test.local/sessions",
      mutateHeaders: (headers) => {
        headers[SERVICE_SIGNATURE_HEADER] = headers[SERVICE_SIGNATURE_HEADER].replace(/.$/, (c) =>
          c === "0" ? "1" : "0"
        );
        headers["Authorization"] = "Bearer some-other-credential";
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects the retired shared bearer", async () => {
    const token = await generateInternalToken("test-hmac-secret-for-integration-tests");
    const response = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });
});
