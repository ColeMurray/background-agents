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

  it("accepts a signed GET from every registered service", async () => {
    for (const service of Object.keys(SERVICE_SECRET) as ServiceName[]) {
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

  it("accepts a signed request with a query string regardless of param order", async () => {
    const response = await signedFetch({
      service: "web",
      method: "GET",
      url: `https://test.local/sessions?limit=5&createdBy=${"a".repeat(32)}`,
    });
    expect(response.status).toBe(200);
  });

  it("delivers the signed body intact to the handler (D1 write lands)", async () => {
    const response = await signedFetch({
      service: "web",
      method: "PUT",
      url: "https://test.local/provider-identities/github/424242",
      body: JSON.stringify({ providerLogin: "octocat", displayName: "Octo Cat" }),
    });
    expect(response.status).toBe(200);

    const identity = await new UserStore(env.DB).getIdentity("github", "424242");
    expect(identity?.providerLogin).toBe("octocat");
  });

  it("rejects a body tampered after signing", async () => {
    const url = "https://test.local/provider-identities/github/424242";
    const headers = await buildServiceAuthHeaders({
      service: "web",
      secret: SERVICE_SECRET.web,
      method: "PUT",
      url,
      body: JSON.stringify({ providerLogin: "octocat" }),
    });
    const response = await SELF.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ providerLogin: "evilcat" }),
    });
    expect(response.status).toBe(401);
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
