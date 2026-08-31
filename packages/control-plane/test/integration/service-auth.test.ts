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
import { insertCanonicalUser } from "./identity-seed-helpers";

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

  it("does not authorize a first-contact actor as one user and attribute it to a Viewer", async () => {
    await insertCanonicalUser({
      id: "existing-viewer",
      email: "viewer@example.com",
      emailVerified: 1,
      displayName: "Existing Viewer",
    });
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind("role_builtin_viewer", "existing-viewer")
      .run();

    const body = JSON.stringify({
      title: "First-contact actor",
      model: "anthropic/claude-haiku-4-5",
      actorEmail: "viewer@example.com",
    });
    const first = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "slack:U-EMAIL-VIEWER",
      body,
    });

    expect(first.status).toBe(409);
    await expect(first.json()).resolves.toMatchObject({ code: "actor_identity_changed" });
    const identity = await new UserStore(env.DB).getIdentity("slack", "U-EMAIL-VIEWER");
    expect(identity?.userId).toBe("existing-viewer");

    const retry = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "slack:U-EMAIL-VIEWER",
      body,
    });
    expect(retry.status).toBe(403);
    await expect(retry.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "sessions.create",
    });

    const sessions = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{
      count: number;
    }>();
    expect(sessions?.count).toBe(0);
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
