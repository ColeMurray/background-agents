import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "./routes/catalog";
import {
  handleRequest,
  matchRoute,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "./router.test-support";

function routeFor(method: string, path: string) {
  return matchRoute(routes, method, path)?.route;
}

function createEnv(verifyStatus: number) {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: verifyStatus }))
    .mockResolvedValueOnce(Response.json({ ok: true }, { status: 202 }));
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };

  const env = {
    ...TEST_SERVICE_SECRETS,
    SCM_PROVIDER: "gitlab",
    GITLAB_ACCESS_TOKEN: "glpat-test",
    DB: {
      prepare: vi.fn(() => statement),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
    },
    SESSION: {
      idFromName: (name: string) => name,
      get: () => ({ fetch }),
    },
  };
  return { env, doFetch: fetch };
}

describe("router sandbox-token fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid sandbox token on a sandbox-accepting route", async () => {
    const { env } = createEnv(204);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/scm-credentials", {
        method: "POST",
        headers: { Authorization: "Bearer valid-sandbox-token" },
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(202);
  });

  it("rejects when sandbox verification also fails", async () => {
    const { env } = createEnv(401);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/scm-credentials", {
        method: "POST",
        headers: { Authorization: "Bearer invalid-token" },
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(401);
  });

  it("rejects unrecognized credentials on a non-sandbox route without trying sandbox auth", async () => {
    const { env, doFetch } = createEnv(401);

    const response = await handleRequest(
      new Request("https://test.local/analytics/summary", {
        headers: { Authorization: "Bearer invalid-token" },
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("does not fall back after a failed service credential attempt", async () => {
    const { env, doFetch } = createEnv(204);
    const request = await signedServiceRequest(
      "https://test.local/sessions/session-1/tunnel-urls",
      {
        service: "linear-bot",
        headers: { Authorization: "Bearer valid-sandbox-token" },
      }
    );
    request.headers.set("X-OpenInspect-Service-Signature", "invalid");

    const response = await handleRequest(request, env as never, TEST_BACKGROUND_TASK_CONTEXT);

    expect(response.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("retired browser-auth routes", () => {
  it.each([
    ["POST", "/auth/tokens/exchange"],
    ["POST", "/auth/tokens/refresh"],
    ["PUT", "/provider-identities/github/583231"],
  ])("does not expose %s %s", async (method, path) => {
    const { env } = createEnv(401);
    const response = await handleRequest(
      new Request(`https://test.local${path}`, { method }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(404);
  });
});

describe("managed skill browser authentication", () => {
  it.each([
    ["GET", "/skills", "user-or-service"],
    ["POST", "/skills/preview", "user-or-service"],
    ["GET", "/skills/skill_1", "user-or-service"],
    ["POST", "/skills", "user"],
    ["POST", "/skills/import", "user"],
    ["GET", "/skill-profiles", "user"],
    ["PATCH", "/skill-profiles/profile_1", "user"],
    ["GET", "/sessions/session_1/skills", "user"],
  ])("owns the browser authentication class for %s %s", (method, path, expectedKind) => {
    expect(routeFor(method, path)?.authentication.kind).toBe(expectedKind);
  });
});

describe("route-owned principal restrictions", () => {
  it("rejects a non-web service on web-service routes", async () => {
    const { env } = createEnv(401);
    const request = await signedServiceRequest(
      "https://test.local/internal/auth/sign-in-providers",
      { service: "linear-bot" }
    );

    const response = await handleRequest(request, env as never, TEST_BACKGROUND_TASK_CONTEXT);

    expect(response.status).toBe(401);
  });

  it("rejects a service principal on human-user routes", async () => {
    const { env } = createEnv(401);
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const request = await signedServiceRequest("https://test.local/sessions/session-1", {
      service: "linear-bot",
    });

    const response = await handleRequest(request, env as never, TEST_BACKGROUND_TASK_CONTEXT);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Human user authentication required",
    });
    const events = info.mock.calls.map(([line]) => JSON.parse(String(line)) as { event?: string });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "auth.principal" }),
        expect.objectContaining({ event: "http.request", http_status: 403 }),
      ])
    );
  });
});
