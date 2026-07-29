import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import {
  ACTOR_HEADER,
  buildServiceAuthHeaders,
  generateInternalToken,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  type ServiceName,
} from "@open-inspect/shared";
import { GlobalSecretsStore } from "../../src/db/global-secrets";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";

const SERVICE_SECRET: Record<ServiceName, string> = {
  web: "test-service-secret-web",
  "slack-bot": "test-service-secret-slack-bot",
  "github-bot": "test-service-secret-github-bot",
  "linear-bot": "test-service-secret-linear-bot",
  modal: "test-service-secret-modal",
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

  it("accepts a signed GET from every non-web service", async () => {
    for (const service of Object.keys(SERVICE_SECRET).filter(
      (candidate): candidate is Exclude<ServiceName, "web"> => candidate !== "web"
    )) {
      const response = await signedFetch({
        service,
        method: "GET",
        url: "https://test.local/sessions",
      });
      expect(response.status, service).toBe(200);
      const body = await response.json<{ sessions: unknown[] }>();
      expect(body.sessions).toEqual([]);
    }
  });

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
      service: "modal",
      secret: SERVICE_SECRET.modal,
      method: "GET",
      url: signedUrl,
    });
    const response = await SELF.fetch(
      `https://test.local/sessions?createdBy=${createdBy}&limit=5`,
      {
        headers,
      }
    );
    expect(response.status).toBe(200);
  });

  it("delivers the signed body intact to the handler (D1 write lands)", async () => {
    const response = await signedFetch({
      service: "modal",
      method: "PUT",
      url: "https://test.local/secrets",
      body: JSON.stringify({ secrets: { SIGNED_BODY_TEST: "intact" } }),
    });
    expect(response.status).toBe(200);

    const secrets = await new GlobalSecretsStore(
      env.DB,
      env.REPO_SECRETS_ENCRYPTION_KEY!
    ).getDecryptedSecrets();
    expect(secrets.SIGNED_BODY_TEST).toBe("intact");
  });

  it("rejects a body tampered after signing", async () => {
    const url = "https://test.local/secrets";
    const intactBody = JSON.stringify({ secrets: { SIGNED_BODY_TEST: "intact" } });
    const headers = await buildServiceAuthHeaders({
      service: "modal",
      secret: SERVICE_SECRET.modal,
      method: "PUT",
      url,
      body: intactBody,
    });
    const intact = await SELF.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: intactBody,
    });
    expect(intact.status).toBe(200);

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

  it("denies actor assertions from web and modal", async () => {
    for (const service of ["web", "modal"] as const) {
      const response = await signedFetch({
        service,
        method: "GET",
        url: "https://test.local/sessions",
        actor: service === "web" ? "slack:U1" : "github:1",
      });
      expect(response.status, service).toBe(401);
    }
  });

  it("persists bot session ownership from the signed actor", async () => {
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
      service: "modal",
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
