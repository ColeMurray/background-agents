import { env } from "cloudflare:test";
import { buildServiceAuthHeaders, type ServiceName } from "@open-inspect/shared";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/router";
import type { Env } from "../../src/types";

const CONTROL_PLANE_ORIGIN = "https://control-plane.test.local";
const PUBLIC_WEB_ORIGIN = "https://app.test.local";
const WEB_SERVICE_SECRET = "test-service-secret-web";

async function signedServiceRequest(
  path: string,
  body: unknown,
  service: ServiceName = "web",
  secret = WEB_SERVICE_SECRET
): Promise<Request> {
  const url = `${CONTROL_PLANE_ORIGIN}${path}`;
  const serializedBody = JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PUBLIC_WEB_ORIGIN,
      ...(await buildServiceAuthHeaders({
        service,
        secret,
        method: "POST",
        url,
        body: serializedBody,
      })),
    },
    body: serializedBody,
  });
}

describe("browser auth router", () => {
  it("accepts a signed web-channel request on the social sign-in endpoint", async () => {
    const request = await signedServiceRequest("/api/auth/sign-in/social", {
      provider: "github",
      callbackURL: "/",
      disableRedirect: true,
    });

    const response = await handleRequest(request, env);

    expect(response.status).toBe(200);
    const body = await response.json<{ url: string }>();
    const providerUrl = new URL(body.url);
    expect(providerUrl.origin).toBe("https://github.com");
    expect(providerUrl.searchParams.get("redirect_uri")).toBe(
      `${PUBLIC_WEB_ORIGIN}/api/auth/callback/github`
    );
  });

  it("keeps browser authentication available on GitLab deployments", async () => {
    const request = await signedServiceRequest("/api/auth/sign-in/social", {
      provider: "github",
      callbackURL: "/",
      disableRedirect: true,
    });

    const response = await handleRequest(request, {
      ...env,
      SCM_PROVIDER: "gitlab",
    } as Env);

    expect(response.status).toBe(200);
  });

  it("rejects a direct browser request without the web channel", async () => {
    const response = await handleRequest(
      new Request(`${CONTROL_PLANE_ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: PUBLIC_WEB_ORIGIN,
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/",
          disableRedirect: true,
        }),
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it("rejects a non-web service on the browser-auth proxy", async () => {
    const request = await signedServiceRequest(
      "/api/auth/sign-in/social",
      {
        provider: "github",
        callbackURL: "/",
        disableRedirect: true,
      },
      "modal",
      "test-service-secret-modal"
    );

    const response = await handleRequest(request, env);

    expect(response.status).toBe(401);
  });

  it("does not expose Better Auth endpoints outside the positive allowlist", async () => {
    const request = await signedServiceRequest("/api/auth/list-sessions", {});

    const response = await handleRequest(request, env);

    expect(response.status).toBe(404);
  });
});
