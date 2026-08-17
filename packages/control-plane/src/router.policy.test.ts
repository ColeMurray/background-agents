import { describe, expect, it, vi } from "vitest";
import { enforceRoutePrincipal, handleRequest, routes } from "./router";
import { TEST_BACKGROUND_TASK_CONTEXT } from "./router.test-support";

function routeFor(method: string, path: string) {
  return routes.find((route) => route.method === method && route.pattern.test(path));
}

describe("route policy table", () => {
  it("has complete metadata", () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(
      routes.every(
        (route) =>
          route.authentication &&
          (route.supportedScmProviders === "all" || route.supportedScmProviders.length > 0)
      )
    ).toBe(true);
  });

  it.each([
    ["GET", "/health", "public"],
    ["POST", "/webhooks/sentry/automation-1", "handler-authenticated"],
    ["POST", "/webhooks/automation/automation-1", "handler-authenticated"],
    ["POST", "/image-builds/build-complete", "handler-authenticated"],
    ["POST", "/image-builds/build-failed", "handler-authenticated"],
    ["GET", "/api/auth/get-session", "web-service"],
    ["GET", "/internal/auth/sign-in-providers", "web-service"],
  ])("owns the auth policy for %s %s", (method, path, expectedKind) => {
    expect(routeFor(method, path)?.authentication.kind).toBe(expectedKind);
  });

  it.each([
    ["POST", "/sessions/session-1/pr"],
    ["GET", "/sessions/session-1/tunnel-urls"],
    ["POST", "/sessions/session-1/media"],
    ["GET", "/sessions/session-1/attachments/attachment-1"],
    ["GET", "/sessions/session-1/children"],
    ["POST", "/sessions/session-1/children"],
    ["GET", "/sessions/session-1/children/child-1"],
    ["POST", "/sessions/session-1/children/child-1/cancel"],
    ["POST", "/sessions/session-1/slack-notify"],
    ["PUT", "/sessions/session-1/diff"],
    ["POST", "/sessions/session-1/diff/failure"],
  ])("allows user/service auth with sandbox fallback for %s %s", (method, path) => {
    const route = routeFor(method, path);
    const match = path.match(route!.pattern)!;
    expect(route?.authentication.kind).toBe("user-or-service-with-sandbox-fallback");
    if (route?.authentication.kind === "user-or-service-with-sandbox-fallback") {
      expect(route.authentication.getSessionId(match)).toBe("session-1");
    }
  });

  it.each([
    ["POST", "/sessions/session-1/scm-credentials"],
    ["GET", "/sessions/session-1/commit-signing"],
    ["POST", "/sessions/session-1/commit-signing"],
    ["POST", "/sessions/parent-1/children/child-1/prompt"],
    ["POST", "/sessions/session-1/openai-token-refresh"],
    ["POST", "/sessions/session-1/xai-token-refresh"],
    ["GET", "/sessions/session-1/sandbox-skills"],
  ])("requires the bound sandbox for %s %s", (method, path) => {
    const route = routeFor(method, path);
    const match = path.match(route!.pattern)!;
    expect(route?.authentication.kind).toBe("sandbox");
    if (route?.authentication.kind === "sandbox") {
      expect(route.authentication.getSessionId(match)).toBe(
        path.includes("/children/") ? "parent-1" : "session-1"
      );
    }
  });

  it.each([
    ["GET", "/sessions/session-1"],
    ["GET", "/sessions/inbox"],
    ["GET", "/sessions/session-1/sandbox-access"],
    ["PATCH", "/sessions/session-1/read-state"],
    ["GET", "/sessions/session-1/skills"],
  ])("owns the human-user restriction for %s %s", (method, path) => {
    expect(routeFor(method, path)?.authentication.kind).toBe("user");
  });

  it("keeps diff authentication method-specific", () => {
    expect(routeFor("GET", "/sessions/session-1/diff")?.authentication.kind).toBe(
      "user-or-service"
    );
    expect(routeFor("POST", "/sessions/session-1/diff/retry")?.authentication.kind).toBe(
      "user-or-service"
    );
  });

  it.each([
    ["GET", "/scm-settings"],
    ["GET", "/analytics/summary"],
    ["GET", "/skills"],
    ["GET", "/skill-profiles"],
    ["GET", "/sessions/session-1"],
    ["GET", "/sessions/inbox"],
    ["PATCH", "/sessions/session-1/read-state"],
    ["GET", "/sessions/session-1/sandbox-access"],
    ["GET", "/sessions/session-1/tunnel-urls"],
    ["GET", "/sessions/session-1/commit-signing"],
    ["GET", "/sessions/session-1/participant-profiles"],
    ["POST", "/sessions/session-1/openai-token-refresh"],
    ["GET", "/sessions/session-1/skills"],
    ["GET", "/sessions/session-1/diff"],
    ["POST", "/sessions/parent-1/children/child-1/prompt"],
  ])("supports every SCM provider for %s %s", (method, path) => {
    expect(routeFor(method, path)?.supportedScmProviders).toBe("all");
  });

  it("keeps SCM credentials as the only GitLab-specific exception", () => {
    expect(
      routes.filter(
        (route) =>
          route.supportedScmProviders !== "all" && route.supportedScmProviders.includes("gitlab")
      )
    ).toEqual([routeFor("POST", "/sessions/session-1/scm-credentials")]);
    expect(routeFor("POST", "/sessions/session-1/scm-credentials")?.supportedScmProviders).toEqual([
      "github",
      "gitlab",
    ]);
  });
});

describe("route policy dispatch ordering", () => {
  function env(scmProvider: string) {
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
    };
    return {
      SCM_PROVIDER: scmProvider,
      DB: {
        prepare: vi.fn(() => statement),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };
  }

  it("authenticates before rejecting an unsupported provider", async () => {
    const response = await handleRequest(
      new Request("https://test.local/repos"),
      env("gitlab") as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );
    expect(response.status).toBe(401);
  });

  it("preserves invalid SCM configuration errors for public routes", async () => {
    const response = await handleRequest(
      new Request("https://test.local/health"),
      env("invalid") as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid SCM_PROVIDER value 'invalid'. Supported values: github, bitbucket, gitlab.",
    });
  });
});

describe("route principal policy", () => {
  it.each([
    [{ kind: "web-service" } as const, { kind: "service", service: "web", actor: null } as const],
    [{ kind: "user" } as const, { kind: "user", userId: "user-1" } as const],
    [
      { kind: "user-or-service" } as const,
      { kind: "service", service: "linear-bot", actor: null } as const,
    ],
  ])("accepts matching principals for %o", (authentication, principal) => {
    expect(enforceRoutePrincipal(authentication, principal)).toBeNull();
  });

  it.each([
    [
      { kind: "web-service" } as const,
      { kind: "service", service: "linear-bot", actor: null } as const,
      401,
    ],
    [{ kind: "web-service" } as const, { kind: "user", userId: "user-1" } as const, 401],
    [
      { kind: "user" } as const,
      { kind: "service", service: "linear-bot", actor: null } as const,
      403,
    ],
  ])("rejects mismatched principals for %o", (authentication, principal, status) => {
    expect(enforceRoutePrincipal(authentication, principal)?.status).toBe(status);
  });
});
