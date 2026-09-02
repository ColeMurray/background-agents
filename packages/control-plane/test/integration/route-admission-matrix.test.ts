/**
 * Drives every catalog route through the deployed Worker with each credential
 * class it can meet, so each endpoint has one Request/Response observation of
 * its Hono selection and admission outcome.
 *
 * The invariants assert admission behavior per authentication class. The
 * snapshots freeze the observed status per route so a change in any
 * endpoint's admission or handler-owned outcome is a reviewable diff.
 */

import { SELF, env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { createExecutionContext } from "cloudflare:test";
import {
  cloudflareHost,
  createControlPlaneApp,
  createControlPlaneHttpHandler,
} from "../../src/routing/hono-app";
import { listRouteContracts, type RouteContract } from "../../src/routing/route-contracts";
import type { Env } from "../../src/types";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { catalog } from "../../src/routes/catalog";
import type { Route } from "../../src/routes/shared";
import { cleanD1Tables } from "./cleanup";
import {
  initSession,
  seedSandboxAuth,
  serviceFetch,
  serviceRequestHeaders,
  waitForSandboxStatus,
} from "./helpers";

const BASE = "https://test.local";
const BROWSER_USER_ID = "11111111111111111111111111111111";
const SANDBOX_TOKEN = "matrix-sandbox-token";
const BOT_SERVICES = ["slack-bot", "github-bot", "linear-bot"] as const;
const PROTECTED_STATUSES = new Set([401, 403]);
const ROUTE_MISS_BODY = JSON.stringify({ error: "Not found" });
// Each pass issues one request per catalog route, and a fresh session per
// mutating session route, so the default per-test budget is too small under
// full-suite load.
const MATRIX_TIMEOUT_MS = 60_000;
/** Every production route with its policy, in precedence order, as Hono registered it. */
const routes: readonly RouteContract[] = listRouteContracts(
  createControlPlaneApp(catalog, cloudflareHost)
);

interface MatrixFixtures {
  readonlySessionId: string;
  sandboxSessionId: string;
  automationId: string;
}

function automation(id: string, userId: string): AutomationRow {
  return {
    id,
    name: id,
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: userId,
    user_id: userId,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
}

const PARAMETER_VALUES: Record<string, string> = {
  owner: "acme",
  name: "web-app",
  provider: "openai",
  key: "MATRIX_KEY",
};

function materialize(route: RouteContract, values: Record<string, string>): string {
  return route.path.replace(/:(\w+)/g, (_parameter, parameter: string) => {
    return values[parameter] ?? PARAMETER_VALUES[parameter] ?? `matrix-${parameter}`;
  });
}

function isSessionRoute(route: RouteContract): boolean {
  return route.path.startsWith("/sessions/:id");
}

function isAutomationRoute(route: RouteContract): boolean {
  return route.path.startsWith("/automations/:id");
}

let automationSequence = 0;
async function createAutomation(): Promise<string> {
  const id = `matrix-automation-${automationSequence++}`;
  await new AutomationStore(env.DB).create(automation(id, BROWSER_USER_ID));
  return id;
}

function isMutation(route: RouteContract): boolean {
  return route.method !== "GET";
}

async function createReadySession(): Promise<string> {
  const { stub, sessionName } = await initSession({ userId: BROWSER_USER_ID });
  await waitForSandboxStatus(stub, "failed");
  return sessionName;
}

async function bodyText(response: Response): Promise<string> {
  return response.text();
}

function outcome(label: string, status: number): string {
  return `${label}=${status}`;
}

describe("route admission matrix", { timeout: MATRIX_TIMEOUT_MS }, () => {
  const fixtures: MatrixFixtures = {
    readonlySessionId: "",
    sandboxSessionId: "",
    automationId: "",
  };

  beforeAll(async () => {
    await cleanD1Tables();
    // Enroll the browser owner so seeded resources can be attributed to it.
    expect((await serviceFetch(`${BASE}/me/authorization`)).status).toBe(200);
    fixtures.readonlySessionId = await createReadySession();

    const { stub, sessionName } = await initSession({ userId: BROWSER_USER_ID });
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: "sb-matrix" });
    fixtures.sandboxSessionId = sessionName;

    fixtures.automationId = await createAutomation();
  }, MATRIX_TIMEOUT_MS);

  afterAll(async () => {
    await cleanD1Tables();
  }, MATRIX_TIMEOUT_MS);

  it("rejects every credentialed route anonymously by its authentication class", async () => {
    const observed: string[] = [];
    for (const route of routes) {
      const url = `${BASE}${materialize(route, { id: "matrix-anonymous" })}`;
      const response = await SELF.fetch(url, { method: route.method });
      const identity = `${route.method} ${route.path}`;
      observed.push(`${identity} ${outcome("anonymous", response.status)}`);

      expect(response.headers.get("x-request-id"), identity).toBeTruthy();
      expect(response.headers.get("x-trace-id"), identity).toBeTruthy();
      expect(response.headers.get("Access-Control-Allow-Origin"), identity).toBe("*");

      switch (route.authentication.kind) {
        case "public":
          expect(response.status, identity).toBe(200);
          break;
        case "handler-authenticated":
          // The handler owns credential verification and its own error order.
          expect(response.status, identity).toBeGreaterThanOrEqual(400);
          expect(response.status, identity).toBeLessThan(500);
          break;
        default:
          expect(response.status, identity).toBe(401);
          expect(await bodyText(response), identity).not.toBe(ROUTE_MISS_BODY);
      }
    }
    expect(observed).toMatchSnapshot();
  });

  it("admits the workspace owner through every browser-reachable route", async () => {
    const observed: string[] = [];
    for (const route of routes) {
      const kind = route.authentication.kind;
      if (kind === "sandbox" || kind === "service" || kind === "public") continue;
      if (kind === "handler-authenticated") continue;

      // Mutating routes get a fresh resource so an earlier DELETE or state
      // change cannot turn later routes into handler-owned 404s.
      const id = isAutomationRoute(route)
        ? isMutation(route)
          ? await createAutomation()
          : fixtures.automationId
        : isSessionRoute(route) && isMutation(route)
          ? await createReadySession()
          : fixtures.readonlySessionId;
      const url = `${BASE}${materialize(route, { id })}`;
      const response = await serviceFetch(url, {
        method: route.method,
        ...(isMutation(route) ? { body: "{}" } : {}),
      });
      const identity = `${route.method} ${route.path}`;
      observed.push(`${identity} ${outcome("owner", response.status)}`);

      // Raw web-service routes (browser auth, autofix activity) admit the web
      // principal and then let their handler own every status, including 403.
      if (kind !== "web-service") {
        expect(PROTECTED_STATUSES.has(response.status), `${identity} -> ${response.status}`).toBe(
          false
        );
      }
      expect(response.headers.get("x-request-id"), identity).toBeTruthy();
      if (response.status === 404) {
        expect(await bodyText(response), identity).not.toBe(ROUTE_MISS_BODY);
      }
      if (route.cacheControl) {
        expect(response.headers.get("Cache-Control"), identity).toBe(route.cacheControl);
      }
    }
    expect(observed).toMatchSnapshot();
  });

  it("admits only the named bot on every exact-service route", async () => {
    const observed: string[] = [];
    const serviceRoutes = routes.filter((route) => route.authentication.kind === "service");
    expect(serviceRoutes.length).toBeGreaterThan(0);

    for (const route of serviceRoutes) {
      const identity = `${route.method} ${route.path}`;
      if (route.authorization.kind !== "service") {
        throw new Error(`${identity} declares service authentication without a service policy`);
      }
      const url = `${BASE}${materialize(route, {})}`;
      const services: readonly string[] = route.authorization.services;
      const allowedService = route.authorization.services[0];
      const deniedService = BOT_SERVICES.find((service) => !services.includes(service));
      if (!deniedService) throw new Error(`${identity} admits every bot service`);

      const admitted = await serviceFetch(url, {
        method: route.method,
        service: allowedService,
        body: "{}",
      });
      expect(PROTECTED_STATUSES.has(admitted.status), `${identity} allowed bot`).toBe(false);

      const wrongBot = await serviceFetch(url, {
        method: route.method,
        service: deniedService,
        body: "{}",
      });
      expect(wrongBot.status, `${identity} wrong bot`).toBe(403);
      await expect(wrongBot.json(), identity).resolves.toMatchObject({
        code: "service_capability_required",
      });

      const browser = await serviceFetch(url, { method: route.method, body: "{}" });
      expect(browser.status, `${identity} browser owner`).toBe(403);
      await expect(browser.json(), identity).resolves.toMatchObject({
        code: "service_capability_required",
      });

      observed.push(
        `${identity} ${outcome(allowedService, admitted.status)} ${outcome(deniedService, wrongBot.status)} ${outcome("web", browser.status)}`
      );
    }
    expect(observed).toMatchSnapshot();
  });

  it("admits a session-bound sandbox token on every sandbox-accepting route", async () => {
    const observed: string[] = [];
    const sandboxRoutes = routes.filter(
      (route) =>
        route.authentication.kind === "sandbox" ||
        route.authentication.kind === "user-or-service-with-sandbox-fallback"
    );
    expect(sandboxRoutes.length).toBeGreaterThan(0);

    for (const route of sandboxRoutes) {
      const identity = `${route.method} ${route.path}`;
      const url = `${BASE}${materialize(route, { id: fixtures.sandboxSessionId })}`;
      const init = {
        method: route.method,
        headers: {
          Authorization: `Bearer ${SANDBOX_TOKEN}`,
          ...(isMutation(route) ? { "Content-Type": "application/json" } : {}),
        },
        ...(isMutation(route) ? { body: "{}" } : {}),
      };

      const admitted = await SELF.fetch(url, init);
      expect(PROTECTED_STATUSES.has(admitted.status), `${identity} -> ${admitted.status}`).toBe(
        false
      );
      if (admitted.status === 404) {
        expect(await bodyText(admitted), identity).not.toBe(ROUTE_MISS_BODY);
      }

      const wrongToken = await SELF.fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: "Bearer not-the-sandbox-token" },
      });
      expect(wrongToken.status, `${identity} wrong token`).toBe(401);

      observed.push(
        `${identity} ${outcome("sandbox", admitted.status)} ${outcome("wrong-token", wrongToken.status)}`
      );
    }
    expect(observed).toMatchSnapshot();
  });

  it("passes percent-encoded path segments through undecoded", async () => {
    // Session ids are looked up by the raw segment, so an encoded letter misses.
    const encodedSessionId = `%74${fixtures.readonlySessionId.slice(1)}`;
    const session = await serviceFetch(`${BASE}/sessions/${encodedSessionId}`);
    expect(session.status).toBe(404);
    await expect(session.json()).resolves.toEqual({ error: "Session not found" });

    // The sandbox binding verifies the token against the same raw segment.
    const sandboxInit = { headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` } };
    const encodedSandboxId = `%74${fixtures.sandboxSessionId.slice(1)}`;
    const plain = await SELF.fetch(
      `${BASE}/sessions/${fixtures.sandboxSessionId}/tunnel-urls`,
      sandboxInit
    );
    expect(plain.status).toBe(200);
    const encoded = await SELF.fetch(
      `${BASE}/sessions/${encodedSandboxId}/tunnel-urls`,
      sandboxInit
    );
    expect(encoded.status).toBe(401);

    // Repository segments decode exactly once in the handler: a nested owner
    // arrives as one segment, a slash in the name is refused after that one
    // decode, and a doubly-encoded slash survives it because nothing decodes
    // the segment a second time.
    const nested = await serviceFetch(`${BASE}/repos/group%2Fsubgroup/web-app/secrets`);
    expect(nested.status).not.toBe(400);
    const slashInName = await serviceFetch(`${BASE}/repos/acme/web%2Fapp/secrets`);
    expect(slashInName.status).toBe(400);
    await expect(slashInName.json()).resolves.toEqual({
      error: "Owner and name must be valid repository path segments",
    });
    const doubleEncoded = await serviceFetch(`${BASE}/repos/acme/web%252Fapp/secrets`);
    expect(doubleEncoded.status).not.toBe(400);

    // RBAC member ids decode once too: an id that is canonical only after a
    // second decode is refused.
    const memberInit = {
      method: "PUT",
      body: JSON.stringify({ roleId: "role_builtin_member" }),
    };
    const canonical = "1".repeat(32);
    const control = await serviceFetch(`${BASE}/members/${canonical}/role`, memberInit);
    expect(control.status).not.toBe(400);
    const twiceEncoded = await serviceFetch(
      `${BASE}/members/${"1".repeat(31)}%2531/role`,
      memberInit
    );
    expect(twiceEncoded.status).toBe(400);
    await expect(twiceEncoded.json()).resolves.toEqual({ error: "Invalid user ID" });
  });
});

/**
 * Admission proof independent of handler behavior: every production policy is
 * kept, every handler is replaced by a sentinel, and each credential class is
 * asserted to reach the sentinel exactly when the route's policy admits it.
 */
describe("route admission sentinel", { timeout: MATRIX_TIMEOUT_MS }, () => {
  const fixtures: MatrixFixtures = {
    readonlySessionId: "",
    sandboxSessionId: "",
    automationId: "",
  };
  const shadow: Route[] = routes.map((route) => ({
    ...route,
    handler: async () => Response.json({ sentinel: `${route.method} ${route.path}` }),
  }));
  const handle = createControlPlaneHttpHandler(shadow);

  beforeAll(async () => {
    await cleanD1Tables();
    expect((await serviceFetch(`${BASE}/me/authorization`)).status).toBe(200);
    fixtures.readonlySessionId = await createReadySession();
    const { stub, sessionName } = await initSession({ userId: BROWSER_USER_ID });
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: "sb-sentinel" });
    fixtures.sandboxSessionId = sessionName;
    fixtures.automationId = await createAutomation();
  }, MATRIX_TIMEOUT_MS);

  afterAll(async () => {
    await cleanD1Tables();
  }, MATRIX_TIMEOUT_MS);

  async function reachedSentinel(response: Response, identity: string): Promise<boolean> {
    if (response.status !== 200) return false;
    const body = (await response.json().catch(() => null)) as { sentinel?: string } | null;
    return body?.sentinel === identity;
  }

  async function botHeaders(
    url: string,
    method: string,
    service: (typeof BOT_SERVICES)[number],
    actor?: string
  ): Promise<Record<string, string>> {
    return buildServiceAuthHeaders({
      service,
      secret: `test-service-secret-${service}`,
      method,
      url,
      actor,
    });
  }

  function send(url: string, method: string, headers: Record<string, string>): Promise<Response> {
    return handle(
      new Request(url, { method, headers }),
      env as unknown as Env,
      createExecutionContext()
    );
  }

  it("admits exactly the credential classes each route's policy accepts", async () => {
    for (const route of routes) {
      const identity = `${route.method} ${route.path}`;
      const kind = route.authentication.kind;
      const sessionId =
        kind === "sandbox" || kind === "user-or-service-with-sandbox-fallback"
          ? fixtures.sandboxSessionId
          : fixtures.readonlySessionId;
      const url = `${BASE}${materialize(route, {
        id: isAutomationRoute(route) ? fixtures.automationId : sessionId,
      })}`;
      const method = route.method;
      const expectReach = async (
        headers: Record<string, string>,
        label: string,
        reach: boolean
      ) => {
        const response = await send(url, method, headers);
        expect(await reachedSentinel(response, identity), `${identity} [${label}]`).toBe(reach);
      };

      const owner = await serviceRequestHeaders(url, { method });
      const sandbox = { Authorization: `Bearer ${SANDBOX_TOKEN}` };
      const wrongSandbox = { Authorization: "Bearer not-the-sandbox-token" };
      const actorBot = await botHeaders(url, method, "slack-bot", "slack:U-SENTINEL");

      switch (kind) {
        case "public":
          await expectReach({}, "anonymous", true);
          break;
        case "handler-authenticated":
          // The handler owns credential verification, so admission is open.
          await expectReach({}, "anonymous", true);
          break;
        case "web-service":
          await expectReach(owner, "web", true);
          await expectReach({}, "anonymous", false);
          await expectReach(actorBot, "bot", false);
          break;
        case "user":
          await expectReach(owner, "owner", true);
          await expectReach({}, "anonymous", false);
          await expectReach(actorBot, "bot actor", false);
          break;
        case "user-or-service":
          await expectReach(owner, "owner", true);
          await expectReach({}, "anonymous", false);
          await expectReach(wrongSandbox, "bearer", false);
          break;
        case "service": {
          if (route.authorization.kind !== "service") throw new Error(identity);
          const services: readonly string[] = route.authorization.services;
          const denied = BOT_SERVICES.find((service) => !services.includes(service));
          if (!denied) throw new Error(`${identity} admits every bot service`);
          await expectReach(
            await botHeaders(url, method, route.authorization.services[0]),
            "bot",
            true
          );
          await expectReach(await botHeaders(url, method, denied), "wrong bot", false);
          await expectReach(owner, "web", false);
          await expectReach({}, "anonymous", false);
          break;
        }
        case "sandbox":
          await expectReach(sandbox, "sandbox", true);
          await expectReach(wrongSandbox, "wrong token", false);
          await expectReach(owner, "owner", false);
          await expectReach({}, "anonymous", false);
          break;
        case "user-or-service-with-sandbox-fallback":
          await expectReach(sandbox, "sandbox", true);
          await expectReach(owner, "owner", true);
          await expectReach(wrongSandbox, "wrong token", false);
          await expectReach({}, "anonymous", false);
          break;
      }
    }
  });

  it("delivers raw path segments to handlers", async () => {
    const echo: Route[] = routes.map((route) => ({
      ...route,
      handler: async (_request, _env, match) => Response.json({ groups: { ...match.groups } }),
    }));
    const handleEcho = createControlPlaneHttpHandler(echo);
    const cases: Array<{ method: string; url: string; groups: Record<string, string> }> = [
      {
        method: "GET",
        url: `${BASE}/sessions/abc%2Fdef`,
        groups: { id: "abc%2Fdef" },
      },
      {
        method: "GET",
        url: `${BASE}/repos/group%2Fsubgroup/web%252Fapp/secrets`,
        groups: { owner: "group%2Fsubgroup", name: "web%252Fapp" },
      },
      {
        method: "PUT",
        url: `${BASE}/members/${"1".repeat(31)}%2531/role`,
        groups: { id: `${"1".repeat(31)}%2531` },
      },
    ];

    for (const { method, url, groups } of cases) {
      const headers = await serviceRequestHeaders(url, { method });
      const response = await handleEcho(
        new Request(url, { method, headers }),
        env as unknown as Env,
        createExecutionContext()
      );
      expect(response.status, url).toBe(200);
      await expect(response.json(), url).resolves.toEqual({ groups });
    }
  });
});
