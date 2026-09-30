import { describe, expect, it, vi } from "vitest";
import {
  fakeSessionRuntimeDispatch,
  handleRequest,
  routeContracts as routes,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "./router.test-support";
import {
  serviceAllowsPermission,
  serviceRouteAllowlist,
} from "./authorization/service-permissions";

const MEMBER_IDENTITY = {
  id: "ident-gh",
  user_id: "user-gh",
  provider: "github",
  provider_user_id: "4242",
  provider_login: "member",
  provider_email: null,
  created_at: 1,
};

function createEnv(identityRow: Record<string, unknown> | null = null) {
  const doFetch = vi.fn(async () => Response.json({ ok: true }));
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => identityRow),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };
  const env = {
    ...TEST_SERVICE_SECRETS,
    DB: { prepare: vi.fn(() => statement), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() },
    SESSION: fakeSessionRuntimeDispatch(doFetch),
  };
  return { env, doFetch, statement };
}

describe("agent-world service principal", () => {
  it("is never granted an actorless or service-only route", () => {
    for (const route of routes) {
      const authorization = route.authorization;
      if (authorization.kind === "service") {
        expect(authorization.services, `${route.method} ${route.path}`).not.toContain(
          "agent-world"
        );
      }
      if (
        (authorization.kind === "active-user" || authorization.kind === "active-global") &&
        authorization.service.kind === "actor"
      ) {
        const services = (authorization.service.actorlessGrants ?? []).map(
          (grant) => grant.service as string
        );
        expect(services, `${route.method} ${route.path}`).not.toContain("agent-world");
      }
    }
  });

  it("allowlists only real routes that fit inside its permission ceiling", () => {
    const allowlist = serviceRouteAllowlist("agent-world");
    expect(allowlist).not.toBeNull();
    for (const key of allowlist ?? []) {
      const route = routes.find((entry) => `${entry.method} ${entry.path}` === key);
      expect(route, key).toBeDefined();
      if (route?.authorization.kind !== "active-user") continue;
      for (const requirement of route.authorization.allOf) {
        if (requirement.kind === "permission") {
          expect(serviceAllowsPermission("agent-world", requirement.permission), key).toBe(true);
        }
      }
    }
  });

  it("requires an acting member to read session events", async () => {
    const { env, doFetch } = createEnv();
    const request = await signedServiceRequest("https://test.local/sessions/session-1/events", {
      service: "agent-world",
    });

    const response = await handleRequest(request, env as never, TEST_BACKGROUND_TASK_CONTEXT);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_actor_required" });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("rejects an actor that is not an existing member without enrolling it", async () => {
    const { env, statement, doFetch } = createEnv(null);
    const request = await signedServiceRequest("https://test.local/sessions/session-1/events", {
      service: "agent-world",
      actor: "github:9999",
    });

    const response = await handleRequest(request, env as never, TEST_BACKGROUND_TASK_CONTEXT);

    expect(response.status).toBe(401);
    expect(statement.run).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/sessions/session-1/pr"],
    ["POST", "/sessions/session-1/slack-notify"],
    ["POST", "/sessions/session-1/media"],
    ["PATCH", "/sessions/session-1/budget"],
    ["GET", "/sessions/session-1"],
    ["GET", "/environments"],
    ["GET", "/integration-settings/slack/watched-channels"],
  ])("denies %s %s outside its route allowlist", async (method, path) => {
    const { env, doFetch, statement } = createEnv(MEMBER_IDENTITY);
    const request = await signedServiceRequest(`https://test.local${path}`, {
      method,
      service: "agent-world",
      actor: "github:4242",
      ...(method === "GET" ? {} : { body: "{}" }),
    });

    const response = await handleRequest(request, env as never, TEST_BACKGROUND_TASK_CONTEXT);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_route_not_allowed" });
    expect(statement.run).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });
});
