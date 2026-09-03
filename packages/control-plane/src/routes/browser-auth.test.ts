import { BROWSER_AUTH_PROXY_ROUTES } from "@open-inspect/shared/browser-auth-routes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { UserAuthConfigurationError } from "../auth/user/runtime";
import type * as UserRuntimeModule from "../auth/user/runtime";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { browserAuthRoutes, forwardBrowserAuthRequest } from "./browser-auth";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getUserAuth: vi.fn(),
}));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../auth/user/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof UserRuntimeModule>()),
  getUserAuth: mocks.getUserAuth,
}));

const handleRequest = createTestRequestHandler([browserAuthRoutes]);
const env = {
  ...TEST_SERVICE_SECRETS,
  SCM_PROVIDER: "github",
  DB: ownerAuthorizationDatabase(),
} as unknown as Env;

function webServicePrincipal() {
  mocks.authenticate.mockImplementation(async (request: Request) => ({
    principal: { kind: "service", service: "web", actor: null },
    request,
  }));
}

function callRoute(method: string, path: string): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local${path}`, { method }),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("forwardBrowserAuthRequest", () => {
  it("uses the direct API wrapper for session lookup", async () => {
    const getSession = vi.fn(async () => Response.json({ user: { id: "user-1" } }));
    const handler = vi.fn(async () => {
      throw new Error("HTTP handler should not serve session lookup");
    });
    const auth = {
      api: { getSession },
      handler,
    } as never;
    const request = new Request("https://control-plane.test/api/auth/get-session", {
      headers: { Cookie: "session=value" },
    });

    const response = await forwardBrowserAuthRequest(auth, request);

    expect(response.status).toBe(200);
    expect(getSession).toHaveBeenCalledWith({
      headers: request.headers,
      asResponse: true,
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("browser auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webServicePrincipal();
  });

  it.each(BROWSER_AUTH_PROXY_ROUTES.map(([method, path]) => [method, path]))(
    "proxies %s %s to Better Auth",
    async (method, path) => {
      const handler = vi.fn(async (request: Request) =>
        Response.json({ path: new URL(request.url).pathname }, { status: 202 })
      );
      const getSession = vi.fn(async () =>
        Response.json({ path: "/api/auth/get-session" }, { status: 202 })
      );
      mocks.getUserAuth.mockReturnValue({ api: { getSession }, handler });

      const response = await callRoute(method, path);

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ path });
      // Session reads take Better Auth's direct API; everything else its HTTP handler.
      const direct = method === "GET" && path === "/api/auth/get-session";
      expect(getSession).toHaveBeenCalledTimes(direct ? 1 : 0);
      expect(handler).toHaveBeenCalledTimes(direct ? 0 : 1);
    }
  );

  it("passes Better Auth's status through with no-store and no-referrer headers", async () => {
    const handler = vi.fn(
      async () =>
        new Response("redirecting", {
          status: 302,
          headers: {
            Location: "https://web.test/",
            "Set-Cookie": "session=abc; Path=/; HttpOnly",
          },
        })
    );
    mocks.getUserAuth.mockReturnValue({ api: { getSession: vi.fn() }, handler });

    const response = await callRoute("GET", "/api/auth/callback/github");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://web.test/");
    expect(response.headers.get("Set-Cookie")).toBe("session=abc; Path=/; HttpOnly");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("answers 503 when browser authentication is not configured", async () => {
    mocks.getUserAuth.mockImplementation(() => {
      throw new UserAuthConfigurationError("missing secret");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await callRoute("GET", "/api/auth/get-session");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Browser authentication is not configured",
    });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("refuses a caller that is not the signed web service", async () => {
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    mocks.getUserAuth.mockReturnValue({ api: { getSession: vi.fn() }, handler: vi.fn() });

    const response = await callRoute("GET", "/api/auth/get-session");

    expect(response.status).toBe(401);
    expect(mocks.getUserAuth).not.toHaveBeenCalled();
  });

  it("does not expose paths outside the allowlist", async () => {
    mocks.getUserAuth.mockReturnValue({ api: { getSession: vi.fn() }, handler: vi.fn() });

    const response = await callRoute("GET", "/api/auth/sign-in/social");

    expect(response.status).toBe(404);
    expect(mocks.getUserAuth).not.toHaveBeenCalled();
  });
});
