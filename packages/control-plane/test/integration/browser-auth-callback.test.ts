import { env } from "cloudflare:test";
import { buildServiceAuthHeaders, isCanonicalUserId } from "@open-inspect/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../../src/router";

const CONTROL_PLANE_ORIGIN = "https://control-plane.test.local";
const PUBLIC_WEB_ORIGIN = "https://app.test.local";
const WEB_SERVICE_SECRET = "test-service-secret-web";

async function signedWebRequest(
  path: string,
  init: {
    method: "GET" | "POST";
    body?: string;
    cookie?: string;
  }
): Promise<Request> {
  const url = `${CONTROL_PLANE_ORIGIN}${path}`;
  return new Request(url, {
    method: init.method,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.cookie ? { Cookie: init.cookie } : {}),
      Origin: PUBLIC_WEB_ORIGIN,
      ...(await buildServiceAuthHeaders({
        service: "web",
        secret: WEB_SERVICE_SECRET,
        method: init.method,
        url,
        body: init.body,
      })),
    },
    body: init.body,
  });
}

function cookiePair(response: Response, cookieName: string): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${cookieName}=`));
  if (!cookie) throw new Error(`Missing ${cookieName} cookie`);
  return cookie.split(";", 1)[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser auth callback", () => {
  it("creates and resolves a GitHub browser session through the signed proxy", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          access_token: "github-access-token",
          token_type: "bearer",
          expires_in: 28_800,
          refresh_token: "github-refresh-token",
          refresh_token_expires_in: 15_897_600,
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 583_231,
          login: "octocat",
          name: "The Octocat",
          avatar_url: "https://avatars.example/octocat",
        })
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            email: "octocat@example.com",
            primary: true,
            verified: true,
            visibility: "private",
          },
        ])
      );

    const initiationBody = JSON.stringify({
      provider: "github",
      callbackURL: "/after-sign-in",
      disableRedirect: true,
    });
    const initiationResponse = await handleRequest(
      await signedWebRequest("/api/auth/sign-in/social", {
        method: "POST",
        body: initiationBody,
      }),
      env
    );
    expect(initiationResponse.status).toBe(200);
    const providerUrl = new URL((await initiationResponse.json<{ url: string }>()).url);
    const state = providerUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    const stateCookie = cookiePair(initiationResponse, "__Secure-openinspect.state");

    const callbackResponse = await handleRequest(
      await signedWebRequest(
        `/api/auth/callback/github?code=authorization-code&state=${encodeURIComponent(state ?? "")}`,
        {
          method: "GET",
          cookie: stateCookie,
        }
      ),
      env
    );

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("Location")).toBe("/after-sign-in");
    const sessionCookie = cookiePair(callbackResponse, "__Secure-openinspect.session_token");

    const sessionResponse = await handleRequest(
      await signedWebRequest("/api/auth/get-session", {
        method: "GET",
        cookie: sessionCookie,
      }),
      env
    );

    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json<{
      user: { id: string; name: string; email: string };
      session: { userId: string };
    }>();
    expect(isCanonicalUserId(session.user.id)).toBe(true);
    expect(session).toMatchObject({
      user: {
        id: expect.any(String),
        name: "The Octocat",
        email: "octocat@example.com",
      },
      session: {
        userId: expect.any(String),
      },
    });

    await expect(
      env.DB.prepare(
        `SELECT id, display_name, email, avatar_url
         FROM users
         WHERE id = ?`
      )
        .bind(session.user.id)
        .first()
    ).resolves.toEqual({
      id: session.user.id,
      display_name: "The Octocat",
      email: "octocat@example.com",
      avatar_url: "https://avatars.example/octocat",
    });

    const resourceResponse = await handleRequest(
      await signedWebRequest("/model-preferences", {
        method: "GET",
        cookie: sessionCookie,
      }),
      env
    );
    expect(resourceResponse.status).toBe(200);

    const channelOnlyResponse = await handleRequest(
      await signedWebRequest("/model-preferences", {
        method: "GET",
      }),
      env
    );
    expect(channelOnlyResponse.status).toBe(401);
  });
});
