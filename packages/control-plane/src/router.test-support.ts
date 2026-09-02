/**
 * Test-only builders for router requests.
 *
 * sig1 binds method, URL, and body, so every request is signed individually
 * — there is no reusable Authorization header. Env fixtures must bind the
 * matching `SERVICE_AUTH_SECRET_<SERVICE>` (see TEST_SERVICE_SECRETS).
 */

import { buildServiceAuthHeaders, type ServiceName } from "@open-inspect/shared/service-auth";
import type { BackgroundTasks } from "./platform-ports";
import { createTestBackgroundTasks } from "./background-tasks.test-support";
import { Hono } from "hono";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type { SqlDatabase, SqlStatement } from "./db/sql-database";
import { cloudflareHost, createControlPlaneApp, type RouteCatalogEntry } from "./routing/hono-app";
import { listRouteContracts, type RouteContract } from "./routing/route-contracts";
import { catalog } from "./routes/catalog";
import type { Route, RouteParams } from "./routes/shared";
import type { Env } from "./types";

// The single contract-faithful double lives in background-tasks.test-support;
// this shared instance's recordings are unused by the router suites.
export const TEST_BACKGROUND_TASK_CONTEXT: BackgroundTasks = createTestBackgroundTasks();

/** Request handler signature used by unit fixtures that provide the platform-neutral port. */
export type TestRequestHandler = (
  request: Request,
  env: Env,
  backgroundTasks: BackgroundTasks
) => Promise<Response>;

/** Present the fixture's port as the execution context the Cloudflare host expects. */
function executionContextFromBackgroundTasks(tasks: BackgroundTasks): ExecutionContext {
  return {
    waitUntil(promise): void {
      tasks.submit(() => promise, { name: "test.http.request" });
    },
    passThroughOnException(): void {},
  } as ExecutionContext;
}

/**
 * Test-only adapter over an explicit catalog, through the production host.
 * Hono registers routes when the app is built, so fixtures that need
 * synthetic routes construct their own handler instead of mutating the
 * production catalog.
 */
export function createTestRequestHandler(
  entries: readonly RouteCatalogEntry[]
): TestRequestHandler {
  const app = createControlPlaneApp(entries, cloudflareHost);
  return (request, env, backgroundTasks) =>
    Promise.resolve(app.fetch(request, env, executionContextFromBackgroundTasks(backgroundTasks)));
}

/** Test-only adapter over the production catalog. */
export const handleRequest: TestRequestHandler = createTestRequestHandler(catalog);

/** Every production route with its policy, in precedence order, as Hono registered it. */
export const routeContracts: readonly RouteContract[] = listRouteContracts(
  createControlPlaneApp(catalog, cloudflareHost)
);

/** The catalog entries still registered through the legacy adapter. */
export function legacyRoutes(entries: readonly RouteCatalogEntry[] = catalog): Route[] {
  return entries.filter((entry): entry is Route => !(entry instanceof Hono));
}

/** The production contract selected for a concrete method and path. */
export function contractFor(method: string, path: string): RouteContract | undefined {
  return routeContracts.find(
    (contract) => contract.method === method && routePathPattern(contract.path).test(path)
  );
}

/**
 * A database whose effective-authorization lookup answers with an active
 * workspace owner, for request-level unit tests of admitted handlers whose
 * data access is mocked at the store.
 */
export function ownerAuthorizationDatabase(userId = "user-1"): SqlDatabase {
  return {
    prepare(sql: string) {
      const statement: SqlStatement = {
        bind: () => statement,
        first: async <T>() =>
          (sql.includes("FROM users u")
            ? {
                user_id: userId,
                suspended_at: null,
                role_id: BUILT_IN_ROLE_REGISTRY.owner.id,
                role_key: "owner",
                role_name: "Owner",
              }
            : null) as T | null,
        all: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
        run: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
      };
      return statement;
    },
    batch: async () => [],
  };
}

/** Compile a catalog path into the legacy raw-path matcher, for handler-level fixtures. */
export function routePathPattern(path: string): RegExp {
  return new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`);
}

/** Select the catalog route for a concrete path and rebuild what the adapter hands its handler. */
export function matchRoute<Entry extends { method: string; path: string }>(
  entries: readonly Entry[],
  method: string,
  path: string
): { route: Entry; match: RegExpMatchArray; params: RouteParams } | undefined {
  for (const route of entries) {
    if (route.method !== method) continue;
    const match = path.match(routePathPattern(route.path));
    if (match) return { route, match, params: { ...match.groups } };
  }
  return undefined;
}

/** Per-service secrets for unit-test env fixtures, mirrored by signedServiceRequest. */
export const TEST_SERVICE_SECRETS = {
  SERVICE_AUTH_SECRET_WEB: "test-service-secret-web",
  SERVICE_AUTH_SECRET_SLACK_BOT: "test-service-secret-slack-bot",
  SERVICE_AUTH_SECRET_GITHUB_BOT: "test-service-secret-github-bot",
  SERVICE_AUTH_SECRET_LINEAR_BOT: "test-service-secret-linear-bot",
} as const;

export async function signedServiceRequest(
  url: string,
  init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    service?: ServiceName;
    actor?: string;
  }
): Promise<Request> {
  const method = init?.method ?? "GET";
  const service = init?.service ?? "web";
  const auth = await buildServiceAuthHeaders({
    service,
    secret: `test-service-secret-${service}`,
    method,
    url,
    body: init?.body,
    actor: init?.actor,
  });
  return new Request(url, {
    method,
    headers: {
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
      ...auth,
    },
    body: init?.body,
  });
}
