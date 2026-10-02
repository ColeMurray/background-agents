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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { createExecutionContext } from "cloudflare:test";
import { cloudflareHost, createControlPlaneHttpHandler } from "../../src/cloudflare/http-host";
import { createControlPlaneApp } from "../../src/routing/hono-app";
import { listRouteContracts, type RouteContract } from "../../src/routing/route-contracts";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { EnvironmentStore } from "../../src/db/environments";
import { ProjectStore } from "../../src/db/project-store";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { catalog } from "../../src/routes/catalog";
import { Hono } from "hono";
import { admit } from "../../src/routing/admit";
import type { ControlPlaneHonoEnv } from "../../src/routing/hono-env";
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
  teamId: string;
  environmentId: string;
  projectId: string;
}

function automation(id: string, userId: string): AutomationRow {
  return {
    id,
    owner_team_id: null,
    name: id,
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    harness: "opencode",
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

function isProjectRoute(route: RouteContract): boolean {
  return route.path.startsWith("/projects/:id");
}

function isAutomationRoute(route: RouteContract): boolean {
  return route.path.startsWith("/automations/:id");
}

function isTeamRoute(route: RouteContract): boolean {
  return route.path.startsWith("/teams/:id");
}

function environmentRequirementFor(route: RouteContract) {
  return route.authorization.kind === "active-user"
    ? route.authorization.allOf.find((requirement) => requirement.kind === "environment")
    : undefined;
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
    projectId: "",
    teamId: "",
    environmentId: "",
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
    fixtures.projectId = (
      await new ProjectStore(env.DB).create(
        { name: "Matrix project", slug: "matrix-project" },
        { userId: BROWSER_USER_ID, requestId: "matrix-seed" }
      )
    ).id;
    fixtures.teamId = (
      await new TeamStore(env.DB).create({
        slug: "matrix-team",
        name: "Matrix",
        joinPolicy: "open",
      })
    ).id;
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
      const id = isProjectRoute(route)
        ? fixtures.projectId
        : isTeamRoute(route)
          ? fixtures.teamId
          : isAutomationRoute(route)
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

  it("rejects a parameter Hono could not decode, on every route, before admission", async () => {
    // Hono leaves an undecodable segment as it arrived; admission refuses it
    // uniformly rather than letting each handler discover it as data.
    const malformed = [
      `${BASE}/sessions/%E0%A4%A`,
      `${BASE}/sessions/%E0%A4%A/events`,
      `${BASE}/automations/%E0%A4%A`,
      `${BASE}/roles/%E0%A4%A`,
      `${BASE}/repos/acme/%E0%A4%A/secrets`,
    ];
    for (const url of malformed) {
      const response = await serviceFetch(url);
      expect(response.status, url).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid path encoding" });
    }
  });

  it("decodes percent-encoded path segments exactly once", async () => {
    // Session ids are decoded exactly once, by Hono, before the lookup and
    // before the sandbox binding, so an encoded letter still names the session.
    const encodedSessionId = `%74${fixtures.readonlySessionId.slice(1)}`;
    const session = await serviceFetch(`${BASE}/sessions/${encodedSessionId}`);
    expect(session.status).toBe(200);

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
    expect(encoded.status).toBe(200);

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
    projectId: "",
    teamId: "",
    environmentId: "env_sentinel",
  };
  // Every production contract, admitted by its own policy, in front of a
  // sentinel handler.
  const shadow = new Hono<ControlPlaneHonoEnv>();
  for (const route of routes) {
    shadow.on(route.method, route.path, admit(route), () =>
      Response.json({ sentinel: `${route.method} ${route.path}` })
    );
  }
  const handle = createControlPlaneHttpHandler([shadow]);
  let teamSessionId = "";
  let privateSessionId = "";
  const OTHER_MEMBER = "33333333333333333333333333333333";
  const TEAM_VIEWER = "44444444444444444444444444444444";
  const COLLABORATOR = "55555555555555555555555555555555";

  beforeAll(async () => {
    await cleanD1Tables();
    expect((await serviceFetch(`${BASE}/me/authorization`)).status).toBe(200);
    fixtures.readonlySessionId = await createReadySession();
    const { stub, sessionName } = await initSession({ userId: BROWSER_USER_ID });
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: "sb-sentinel" });
    fixtures.sandboxSessionId = sessionName;
    fixtures.automationId = await createAutomation();
    fixtures.projectId = (
      await new ProjectStore(env.DB).create(
        { name: "Matrix project", slug: "matrix-project" },
        { userId: BROWSER_USER_ID, requestId: "matrix-seed" }
      )
    ).id;
    fixtures.teamId = (
      await new TeamStore(env.DB).create({
        slug: "sentinel-team",
        name: "Sentinel",
        joinPolicy: "open",
      })
    ).id;
    await new EnvironmentStore(env.DB).create(
      {
        id: fixtures.environmentId,
        owner_team_id: null,
        name: "Sentinel environment",
        description: null,
        prebuild_enabled: 0,
        channel_associations: null,
        created_at: 1,
        updated_at: 1,
      },
      []
    );
    for (const [userId, role] of [
      [OTHER_MEMBER, "member"],
      [TEAM_VIEWER, "viewer"],
      [COLLABORATOR, "member"],
    ] as const) {
      await serviceRequestHeaders(`${BASE}/me/authorization`, { as: { userId, role } });
    }
    await new TeamMembershipStore(env.DB).add(fixtures.teamId, TEAM_VIEWER);
    teamSessionId = await createReadySession();
    privateSessionId = await createReadySession();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE sessions SET owner_team_id = ?, visibility = 'team' WHERE id = ?"
      ).bind(fixtures.teamId, teamSessionId),
      env.DB.prepare(
        "UPDATE sessions SET owner_team_id = ?, visibility = 'private', user_id = ? WHERE id = ?"
      ).bind(fixtures.teamId, OTHER_MEMBER, privateSessionId),
    ]);
    await new SessionCollaboratorStore(env.DB).add(privateSessionId, COLLABORATOR, OTHER_MEMBER);
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
      createCloudflareEnv(env),
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
        ...(environmentRequirementFor(route)?.kind === "environment"
          ? { [environmentRequirementFor(route)!.idParam]: fixtures.environmentId }
          : {}),
        id: isProjectRoute(route)
          ? fixtures.projectId
          : isTeamRoute(route)
            ? fixtures.teamId
            : isAutomationRoute(route)
              ? fixtures.automationId
              : environmentRequirementFor(route)?.idParam === "id"
                ? fixtures.environmentId
                : sessionId,
        childId: fixtures.sandboxSessionId,
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

  it("delivers path segments to handlers decoded exactly once", async () => {
    await initSession({ sessionName: "abc/def", userId: BROWSER_USER_ID });
    // Every production contract, admitted by its own policy, in front of a
    // handler that echoes the parameters Hono decoded.
    const echo = new Hono<ControlPlaneHonoEnv>();
    for (const route of routes) {
      echo.on(route.method, route.path, admit(route), (c) =>
        Response.json({ groups: c.req.param() })
      );
    }
    const handleEcho = createControlPlaneHttpHandler([echo]);
    const cases: Array<{ method: string; url: string; groups: Record<string, string> }> = [
      {
        method: "GET",
        url: `${BASE}/sessions/abc%2Fdef`,
        groups: { id: "abc/def" },
      },
      {
        method: "GET",
        url: `${BASE}/repos/group%2Fsubgroup/web%252Fapp/secrets`,
        groups: { owner: "group/subgroup", name: "web%2Fapp" },
      },
      {
        method: "PUT",
        url: `${BASE}/members/${"1".repeat(31)}%2531/role`,
        groups: { id: `${"1".repeat(31)}%31` },
      },
    ];

    for (const { method, url, groups } of cases) {
      const headers = await serviceRequestHeaders(url, { method });
      const response = await handleEcho(
        new Request(url, { method, headers }),
        createCloudflareEnv(env),
        createExecutionContext()
      );
      expect(response.status, url).toBe(200);
      await expect(response.json(), url).resolves.toEqual({ groups });
    }
  });

  it("admits team directory reads but conceals member tabs and denies capabilities in every mode", async () => {
    const observed: string[] = [];
    for (const mode of ["off", "shadow", "on"] as const) {
      for (const route of routes.filter(
        (item) => isTeamRoute(item) && item.authorization.kind === "active-user"
      )) {
        if (route.authorization.kind !== "active-user") throw new Error("Missing team policy");
        const requirement = route.authorization.allOf.find((entry) => entry.kind === "team");
        if (!requirement || requirement.kind !== "team")
          throw new Error("Missing team requirement");
        const url = `${BASE}${materialize(route, { id: fixtures.teamId, userId: TEAM_VIEWER })}`;
        const headers = await serviceRequestHeaders(url, {
          method: route.method,
          as: { userId: OTHER_MEMBER, role: "member" },
        });
        const response = await handle(
          new Request(url, { method: route.method, headers }),
          createCloudflareEnv({ ...env, TEAMS_ENFORCEMENT: mode }),
          createExecutionContext()
        );
        const expected =
          requirement.need === "read" || requirement.need === "canJoin"
            ? 200
            : requirement.need === "member" || requirement.need === "removeMember"
              ? 404
              : 403;
        const identity = `${route.method} ${route.path}`;
        observed.push(
          `${identity} ${mode}/nonmember=${response.status} auditAllowed=${route.authorization.auditAllowed}`
        );
        expect(response.status, identity).toBe(expected);
        if (expected === 403)
          await expect(response.json()).resolves.toMatchObject({
            reason_code: "team_capability_required",
          });
        if (expected === 404)
          await expect(response.json()).resolves.toEqual({ error: "Team not found" });
      }
    }
    expect(observed).toMatchSnapshot();
  });

  it("conceals all team item routes from another team before any handler or DO call", async () => {
    const get = vi.fn(() => {
      throw new Error("Denied route reached the Durable Object");
    });
    const requestEnv = createCloudflareEnv({
      ...env,
      TEAMS_ENFORCEMENT: "on",
      SESSION: new Proxy(env.SESSION, {
        get(target, property, receiver) {
          if (property === "get") return get;
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    const observed: string[] = [];
    for (const route of routes.filter(
      (item) => isSessionRoute(item) && item.authorization.kind === "active-user"
    )) {
      const identity = `${route.method} ${route.path}`;
      const url = `${BASE}${materialize(route, { id: teamSessionId, childId: fixtures.sandboxSessionId })}`;
      const headers = await serviceRequestHeaders(url, {
        method: route.method,
        as: { userId: OTHER_MEMBER, role: "member" },
      });
      const response = await handle(
        new Request(url, { method: route.method, headers }),
        requestEnv,
        createExecutionContext()
      );
      observed.push(`${identity} other-team=${response.status}`);
      expect(response.status, identity).toBe(404);
      await expect(response.json(), identity).resolves.toEqual({ error: "Session not found" });
    }
    expect(get).not.toHaveBeenCalled();
    expect(observed).toMatchSnapshot();
  });

  it("denies cross-target member removal before the handler in every mode", async () => {
    const memberships = new TeamMembershipStore(env.DB);
    await memberships.add(fixtures.teamId, COLLABORATOR);
    try {
      const url = `${BASE}/teams/${fixtures.teamId}/members/${TEAM_VIEWER}`;
      for (const mode of ["off", "shadow", "on"] as const) {
        const headers = await serviceRequestHeaders(url, {
          method: "DELETE",
          as: { userId: COLLABORATOR, role: "member" },
        });
        const response = await handle(
          new Request(url, { method: "DELETE", headers }),
          createCloudflareEnv({ ...env, TEAMS_ENFORCEMENT: mode }),
          createExecutionContext()
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ reason_code: "team_capability_required" });
      }
    } finally {
      await memberships.remove(fixtures.teamId, COLLABORATOR);
    }
  });

  it("reports action denials for a same-team Viewer and admits a private collaborator", async () => {
    const observed: string[] = [];
    for (const route of routes.filter(
      (item) => isSessionRoute(item) && item.authorization.kind === "active-user"
    )) {
      if (
        route.path.endsWith("/export") ||
        (route.path.endsWith("/children") && route.method === "POST")
      )
        continue;
      const url = `${BASE}${materialize(route, { id: teamSessionId, childId: fixtures.sandboxSessionId, userId: TEAM_VIEWER })}`;
      const headers = await serviceRequestHeaders(url, {
        method: route.method,
        as: { userId: TEAM_VIEWER, role: "viewer" },
      });
      const response = await handle(
        new Request(url, { method: route.method, headers }),
        createCloudflareEnv({ ...env, TEAMS_ENFORCEMENT: "on" }),
        createExecutionContext()
      );
      const expected =
        route.authorization.kind === "active-user" &&
        route.authorization.allOf.every(
          (entry) => entry.kind !== "session" || entry.action === "read"
        )
          ? 200
          : 403;
      observed.push(`${route.method} ${route.path} same-team-viewer=${response.status}`);
      expect(response.status, `${route.method} ${route.path}`).toBe(expected);
      if (expected === 403) {
        const ownershipOnly =
          route.authorization.kind === "active-user" &&
          route.authorization.allOf.some(
            (entry) =>
              entry.kind === "session" &&
              (entry.action === "changeVisibility" || entry.action === "manageCollaborators")
          );
        await expect(response.json()).resolves.toMatchObject({
          reason_code: ownershipOnly ? "not_owner_or_lead" : "missing_permission",
        });
      }
    }
    expect(observed).toMatchSnapshot();
    const url = `${BASE}/sessions/${privateSessionId}/events`;
    const headers = await serviceRequestHeaders(url, {
      as: { userId: COLLABORATOR, role: "member" },
    });
    // Team-owned collaborator grants are honored only for current team members.
    const memberships = new TeamMembershipStore(env.DB);
    await memberships.add(fixtures.teamId, COLLABORATOR);
    let response: Response;
    try {
      response = await handle(
        new Request(url, { headers }),
        createCloudflareEnv({ ...env, TEAMS_ENFORCEMENT: "on" }),
        createExecutionContext()
      );
    } finally {
      await memberships.remove(fixtures.teamId, COLLABORATOR);
    }
    expect(response.status).toBe(200);
    expect([`collaborator-on-private=${response.status}`]).toMatchSnapshot();
  });

  it("admits actorless reads of team and workspace sessions but not private ones", async () => {
    const observed: string[] = [];
    for (const id of [fixtures.readonlySessionId, teamSessionId, privateSessionId]) {
      const url = `${BASE}/sessions/${id}/events`;
      const response = await handle(
        new Request(url, {
          headers: await botHeaders(url, "GET", "slack-bot"),
        }),
        createCloudflareEnv({ ...env, TEAMS_ENFORCEMENT: "on" }),
        createExecutionContext()
      );
      observed.push(
        `actorless-${id === fixtures.readonlySessionId ? "workspace" : id === teamSessionId ? "team" : "private"}=${response.status}`
      );
      expect(response.status).toBe(id === privateSessionId ? 404 : 200);
    }
    expect(observed).toMatchSnapshot();
  });

  it("audits one workspace Owner break-glass admission for a private session", async () => {
    const url = `${BASE}/sessions/${privateSessionId}`;
    const headers = await serviceRequestHeaders(url);
    const response = await handle(
      new Request(url, { headers }),
      createCloudflareEnv({ ...env, TEAMS_ENFORCEMENT: "on" }),
      createExecutionContext()
    );
    expect(response.status).toBe(200);
    const audits = await env.DB.prepare(
      "SELECT resource_type, resource_id, team_id, actor_user_id_snapshot FROM authorization_audit_events WHERE action = 'session.private_break_glass'"
    ).all();
    expect(audits.results).toEqual([
      {
        resource_type: "session",
        resource_id: privateSessionId,
        team_id: fixtures.teamId,
        actor_user_id_snapshot: BROWSER_USER_ID,
      },
    ]);
    expect([
      `owner-role-break-glass=${response.status}:${audits.results.length}`,
    ]).toMatchSnapshot();
  });
});
