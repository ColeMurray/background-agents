import { describe, expect, it, vi } from "vitest";
import { enforceRoutePrincipal, handleRequest, routes } from "./router";
import { TEST_BACKGROUND_TASK_CONTEXT } from "./router.test-support";
import { serviceAllowsPermission } from "./authorization/service-permissions";
import { SCOPED_PERMISSION_PAIRS } from "@open-inspect/shared/rbac";

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
          route.authorization &&
          (route.supportedScmProviders === "all" || route.supportedScmProviders.length > 0)
      )
    ).toBe(true);
  });

  it("has no duplicate method and pattern declarations", () => {
    const identities = routes.map((route) => `${route.method}:${route.pattern}`);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("declares authorization compatible with authentication", () => {
    for (const route of routes) {
      const authentication = route.authentication.kind;
      const authorization = route.authorization;
      if (authorization.kind === "none") {
        expect(["public", "handler-authenticated", "web-service", "sandbox"]).toContain(
          authentication
        );
      } else if (authorization.kind === "authenticated" || authorization.kind === "active-self") {
        expect(authentication).toBe("user");
      } else if (authorization.kind === "service") {
        expect(authentication).toBe("service");
        expect(authorization.services.length).toBeGreaterThan(0);
      } else if (authorization.kind === "active-global") {
        expect(["user", "user-or-service"]).toContain(authentication);
      } else {
        expect(["user", "user-or-service", "user-or-service-with-sandbox-fallback"]).toContain(
          authentication
        );
        expect(authorization.allOf.length).toBeGreaterThan(0);
        for (const requirement of authorization.allOf) {
          if (requirement.kind === "automation") {
            expect(route.pattern.source).toContain(`?<${requirement.automationIdParam}>`);
          }
        }
        if (authorization.service.kind === "actor") {
          for (const grant of authorization.service.actorlessGrants ?? []) {
            for (const pathParam of Object.keys(grant.pathParams ?? {})) {
              expect(route.pattern.source).toContain(`?<${pathParam}>`);
            }
          }
        }
      }
    }
  });

  it.each([
    ["GET", "/repos", [{ service: "slack-bot" }, { service: "linear-bot" }]],
    ["GET", "/repos/acme/widgets/metadata", [{ service: "github-bot" }]],
    ["GET", "/environments", [{ service: "slack-bot" }, { service: "linear-bot" }]],
    ["GET", "/environments/env-1", [{ service: "github-bot" }]],
    ["GET", "/integration-settings/slack", [{ service: "slack-bot", pathParams: { id: "slack" } }]],
    [
      "GET",
      "/integration-settings/github/resolved/acme/widgets",
      [
        { service: "github-bot", pathParams: { id: "github" } },
        { service: "linear-bot", pathParams: { id: "linear" } },
      ],
    ],
    ["GET", "/integration-settings/slack/watched-channels", [{ service: "slack-bot" }]],
    ["GET", "/model-preferences", [{ service: "slack-bot" }]],
    ["GET", "/sessions/session-1/events", [{ service: "slack-bot" }, { service: "linear-bot" }]],
    ["GET", "/sessions/session-1/artifacts", [{ service: "slack-bot" }, { service: "linear-bot" }]],
  ])("declares the exact actorless grants for %s %s", (method, path, expected) => {
    const authorization = routeFor(method, path)?.authorization;
    expect(["active-user", "active-global"]).toContain(authorization?.kind);
    if (authorization?.kind === "active-user" || authorization?.kind === "active-global") {
      expect(authorization.service.kind).toBe("actor");
      if (authorization.service.kind === "actor") {
        expect(authorization.service.actorlessGrants).toEqual(expected);
      }
    }
  });

  it("does not declare actorless grants on other routes", () => {
    const expected = new Set([
      routeFor("GET", "/repos"),
      routeFor("GET", "/repos/acme/widgets/metadata"),
      routeFor("GET", "/environments"),
      routeFor("GET", "/environments/env-1"),
      routeFor("GET", "/integration-settings/slack"),
      routeFor("GET", "/integration-settings/github/resolved/acme/widgets"),
      routeFor("GET", "/integration-settings/slack/watched-channels"),
      routeFor("GET", "/model-preferences"),
      routeFor("GET", "/sessions/session-1/events"),
      routeFor("GET", "/sessions/session-1/artifacts"),
      routeFor("POST", "/sessions/session-1/stop"),
      routeFor("GET", "/sessions/session-1/media/artifact-1"),
    ]);
    const granted = routes.filter(
      (route) =>
        (route.authorization.kind === "active-user" ||
          route.authorization.kind === "active-global") &&
        route.authorization.service.kind === "actor" &&
        (route.authorization.service.actorlessGrants?.length ?? 0) > 0
    );

    expect(new Set(granted)).toEqual(expected);
  });

  it("keeps every actorless route grant within its service permission ceiling", () => {
    for (const route of routes) {
      if (route.authorization.kind !== "active-user") continue;
      if (route.authorization.service.kind !== "actor") continue;
      for (const grant of route.authorization.service.actorlessGrants ?? []) {
        for (const requirement of route.authorization.allOf) {
          if (requirement.kind === "permission") {
            expect(
              serviceAllowsPermission(grant.service, requirement.permission),
              `${grant.service} must allow ${requirement.permission} for ${route.method} ${route.pattern}`
            ).toBe(true);
          } else if (requirement.kind === "scoped-permission") {
            expect(
              serviceAllowsPermission(grant.service, SCOPED_PERMISSION_PAIRS[requirement.stem].own)
            ).toBe(true);
          }
        }
      }
    }
  });

  it("keeps contextual route requirements explicit", () => {
    expect(routeFor("GET", "/keyboard-shortcuts")?.authorization).toEqual({
      kind: "active-self",
    });
    expect(routeFor("GET", "/model-preferences")?.authorization).toMatchObject({
      kind: "active-global",
      service: { kind: "actor", actorlessGrants: [{ service: "slack-bot" }] },
    });
    expect(routeFor("GET", "/sessions")?.authorization).toMatchObject({
      kind: "active-user",
      allOf: [{ kind: "permission", permission: "sessions.read" }],
      service: { kind: "actor" },
    });
    expect(routeFor("GET", "/sessions/inbox")?.authorization).toMatchObject({
      kind: "active-user",
      allOf: [{ kind: "permission", permission: "sessions.read" }],
      service: { kind: "deny" },
    });
    expect(routeFor("POST", "/sessions/session-1/ws-token")?.authorization).toMatchObject({
      kind: "active-user",
      allOf: [{ kind: "permission", permission: "sessions.read" }],
    });
    expect(routeFor("POST", "/sessions/session-1/stop")?.authorization).toMatchObject({
      service: { kind: "actor", actorlessGrants: [{ service: "linear-bot" }] },
    });
    expect(routeFor("GET", "/sessions/session-1/media/artifact-1")?.authorization).toMatchObject({
      service: { kind: "actor", actorlessGrants: [{ service: "slack-bot" }] },
    });
    expect(routeFor("POST", "/sessions/session-1/participants")).toBeUndefined();
    expect(routeFor("POST", "/sessions/parent/children")?.authorization).toMatchObject({
      kind: "active-user",
      allOf: [
        { kind: "permission", permission: "sessions.create" },
        { kind: "permission", permission: "sessions.collaborate" },
      ],
    });
    expect(routeFor("GET", "/sessions/parent/children/child")?.authorization).toMatchObject({
      kind: "active-user",
      allOf: [{ kind: "permission", permission: "sessions.read" }],
    });
    expect(routeFor("POST", "/internal/github-event")?.authorization).toMatchObject({
      kind: "service",
      services: ["github-bot"],
    });
    expect(routeFor("POST", "/internal/github-event")?.authentication).toEqual({
      kind: "service",
    });
    expect(routeFor("POST", "/internal/slack-event")?.authentication).toEqual({
      kind: "service",
    });
  });

  it("returns 400 for a malformed percent-encoded role ID before querying D1", async () => {
    const path = "/roles/%E0%A4%A";
    const route = routeFor("GET", path);
    const match = path.match(route!.pattern)!;
    const prepare = vi.fn();

    const response = await route!.handler(
      new Request(`https://test.local${path}`),
      {} as never,
      match,
      {
        principal: { kind: "user", userId: "user-1" },
        db: { prepare },
      } as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid role ID" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["PUT", "/automations/automation-1", "manage"],
    ["DELETE", "/automations/automation-1", "manage"],
    ["POST", "/automations/automation-1/pause", "manage"],
    ["POST", "/automations/automation-1/resume", "manage"],
    ["POST", "/automations/automation-1/trigger", "trigger"],
    ["POST", "/automations/automation-1/regenerate-key", "manage"],
  ])("declares automation ownership authorization for %s %s", (method, path, operation) => {
    expect(routeFor(method, path)?.authorization).toMatchObject({
      kind: "active-user",
      allOf: [{ kind: "automation", operation, automationIdParam: "id" }],
      service: { kind: "deny" },
    });
  });

  it.each([
    ["GET", "/health", "public"],
    ["POST", "/webhooks/sentry/automation-1", "handler-authenticated"],
    ["POST", "/webhooks/automation/automation-1", "handler-authenticated"],
    ["POST", "/image-builds/build-complete", "handler-authenticated"],
    ["POST", "/image-builds/build-failed", "handler-authenticated"],
    ["GET", "/api/auth/get-session", "web-service"],
    ["GET", "/internal/auth/sign-in-providers", "web-service"],
    ["GET", "/model-provider-accounts", "user"],
    ["POST", "/model-provider-accounts", "user"],
    ["POST", "/model-provider-accounts/openai/device-authorizations", "user"],
    [
      "POST",
      `/model-provider-accounts/openai/device-authorizations/${"0".repeat(64)}/poll`,
      "user",
    ],
    ["DELETE", `/model-provider-accounts/openai/device-authorizations/${"0".repeat(64)}`, "user"],
    ["GET", "/model-provider-accounts/legacy-credentials", "user"],
    ["GET", "/model-provider-account-defaults", "user"],
    ["PUT", "/model-provider-account-defaults/openai", "user"],
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
    expect(route?.authorization.kind).toBe("active-user");
  });

  it.each([
    ["POST", "/sessions/session-1/scm-credentials"],
    ["GET", "/sessions/session-1/commit-signing"],
    ["POST", "/sessions/session-1/commit-signing"],
    ["POST", "/sessions/parent-1/children/child-1/prompt"],
    ["POST", "/sessions/session-1/openai-token-refresh"],
    ["POST", "/sessions/session-1/xai-token-refresh"],
    ["GET", "/sessions/session-1/sandbox-skills"],
    ["POST", "/sessions/session-1/provider-auth/openai/access-token"],
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
    ["POST", "/skills"],
    ["POST", "/skills/import"],
    ["POST", "/skills/skill-1/reimport"],
    ["GET", "/skill-profiles"],
  ])("owns the human-user restriction for %s %s", (method, path) => {
    expect(routeFor(method, path)?.authentication.kind).toBe("user");
  });

  it.each([
    ["GET", "/skills"],
    ["POST", "/skills/preview"],
    ["POST", "/skills/resolve-preview"],
    ["GET", "/skills/skill-1"],
  ])("preserves user-or-service access for read-only skill routes %s %s", (method, path) => {
    expect(routeFor(method, path)?.authentication.kind).toBe("user-or-service");
  });

  it("keeps diff authentication method-specific", () => {
    expect(routeFor("GET", "/sessions/session-1/diff")?.authentication.kind).toBe(
      "user-or-service"
    );
    expect(routeFor("POST", "/sessions/session-1/diff/retry")?.authentication.kind).toBe(
      "user-or-service"
    );
  });

  it("marks management and broker routes as non-cacheable", () => {
    expect(routeFor("GET", "/model-provider-accounts")?.cacheControl).toBe("private, no-store");
    expect(
      routeFor("POST", "/model-provider-accounts/openai/device-authorizations")?.cacheControl
    ).toBe("private, no-store");
    expect(
      routeFor("POST", "/sessions/session-1/provider-auth/openai/access-token")?.cacheControl
    ).toBe("no-store");
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

  it("keeps health dependency-free when D1 is unavailable", async () => {
    const testEnv = env("github");
    testEnv.DB.prepare = vi.fn(() => {
      throw new Error("D1 unavailable");
    });

    const response = await handleRequest(
      new Request("https://test.local/health"),
      testEnv as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "healthy",
      service: "open-inspect-control-plane",
    });
  });

  it("applies broker cache policy when sandbox authentication is unavailable", async () => {
    const testEnv = env("github") as ReturnType<typeof env> & {
      SESSION: {
        idFromName: (name: string) => string;
        get: () => { fetch: () => Promise<Response> };
      };
    };
    testEnv.SESSION = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => Promise.reject(new Error("DO unavailable")) }),
    };

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/provider-auth/openai/access-token", {
        method: "POST",
        headers: { Authorization: "Bearer sandbox-token" },
      }),
      testEnv as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("route principal policy", () => {
  it.each([
    [{ kind: "web-service" } as const, { kind: "service", service: "web", actor: null } as const],
    [{ kind: "user" } as const, { kind: "user", userId: "user-1" } as const],
    [
      { kind: "service" } as const,
      { kind: "service", service: "github-bot", actor: null } as const,
    ],
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
    [{ kind: "service" } as const, { kind: "user", userId: "user-1" } as const, 403],
  ])("rejects mismatched principals for %o", (authentication, principal, status) => {
    expect(enforceRoutePrincipal(authentication, principal)?.status).toBe(status);
  });
});
