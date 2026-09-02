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
import { beforeAll, describe, expect, it } from "vitest";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { routes } from "../../src/routes/catalog";
import type { Route } from "../../src/routes/shared";
import { cleanD1Tables } from "./cleanup";
import { initSession, seedSandboxAuth, serviceFetch, waitForSandboxStatus } from "./helpers";

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

function materialize(route: Route, values: Record<string, string>): string {
  return route.path.replace(/:(\w+)/g, (_parameter, parameter: string) => {
    return values[parameter] ?? PARAMETER_VALUES[parameter] ?? `matrix-${parameter}`;
  });
}

function isSessionRoute(route: Route): boolean {
  return route.path.startsWith("/sessions/:id");
}

function isMutation(route: Route): boolean {
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

    fixtures.automationId = "matrix-automation";
    await new AutomationStore(env.DB).create(automation(fixtures.automationId, BROWSER_USER_ID));
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

      const sessionId =
        isSessionRoute(route) && isMutation(route)
          ? await createReadySession()
          : fixtures.readonlySessionId;
      const url = `${BASE}${materialize(route, { id: route.path.startsWith("/automations/") ? fixtures.automationId : sessionId })}`;
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
});
