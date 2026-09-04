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
import { BUILT_IN_ROLE_REGISTRY, type PermissionId } from "@open-inspect/shared/rbac";
import type { CacheStore } from "@open-inspect/shared/cache-store";
import type { SqlDatabase, SqlStatement } from "./db/sql-database";
import type { SessionRuntimeDispatch } from "./session/runtime-client";
import { cloudflareHost } from "./cloudflare/http-host";
import { createControlPlaneApp, type RouteModule } from "./routing/hono-app";
import { listRouteContracts, type RouteContract } from "./routing/route-contracts";
import { catalog } from "./routes/catalog";
import type { RouteParams } from "./routes/shared";
import type { Env, EnvConfig } from "./types";

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
 * Test-only adapter over explicit route modules, through the production host.
 * Hono registers routes when the app is built, so fixtures that need
 * synthetic routes build their own module instead of mutating the
 * production catalog.
 */
export function createTestRequestHandler(modules: readonly RouteModule[]): TestRequestHandler {
  const app = createControlPlaneApp(modules, cloudflareHost);
  return (request, env, backgroundTasks) =>
    Promise.resolve(app.fetch(request, env, executionContextFromBackgroundTasks(backgroundTasks)));
}

/** Test-only adapter over the production catalog. */
export const handleRequest: TestRequestHandler = createTestRequestHandler(catalog);

/** Every production route with its policy, in precedence order, as Hono registered it. */
export const routeContracts: readonly RouteContract[] = listRouteContracts(
  createControlPlaneApp(catalog, cloudflareHost)
);

/** The production contract selected for a concrete method and path. */
export function contractFor(method: string, path: string): RouteContract | undefined {
  return routeContracts.find(
    (contract) => contract.method === method && routePathPattern(contract.path).test(path)
  );
}

/** The user every authorization fixture answers for unless a test names another. */
export const TEST_USER_ID = "user-1";

/** How admission's authorization lookups are answered, and where every other statement goes. */
export interface AuthorizationDatabaseOptions {
  userId?: string;
  /** Grants of a custom role; omitted, the user is a workspace owner. */
  permissions?: readonly PermissionId[];
  /** Answers statements that are not admission's; omitted, they answer null and no rows. */
  statement?: (sql: string) => SqlStatement;
  batch?: SqlDatabase["batch"];
}

/** A statement that answers null and no rows, for data access mocked at the store. */
export function emptyStatement(): SqlStatement {
  const statement: SqlStatement = {
    bind: () => statement,
    first: async <T>() => null as T | null,
    all: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
    run: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
  };
  return statement;
}

/**
 * A database whose effective-authorization lookup answers for one active
 * user, for request-level unit tests of admitted handlers. The two
 * statements admission issues (the user's role, then a custom role's
 * grants) are recognized here so no suite has to know their shape.
 */
export function authorizationDatabase(options: AuthorizationDatabaseOptions = {}): SqlDatabase {
  const { userId = TEST_USER_ID, permissions, statement = emptyStatement, batch } = options;
  const role = permissions
    ? { role_id: "role-1", role_key: null, role_name: "Custom" }
    : { role_id: BUILT_IN_ROLE_REGISTRY.owner.id, role_key: "owner", role_name: "Owner" };
  return {
    prepare(sql: string) {
      if (sql.includes("FROM users u")) {
        const lookup: SqlStatement = {
          ...emptyStatement(),
          bind: () => lookup,
          first: async <T>() => ({ user_id: userId, suspended_at: null, ...role }) as T | null,
        };
        return lookup;
      }
      if (sql.includes("FROM role_permissions")) {
        const grants: SqlStatement = {
          ...emptyStatement(),
          bind: () => grants,
          all: async <T>() => ({
            results: (permissions ?? []).map((permission_id) => ({ permission_id })) as T[],
            meta: { changes: 0 },
          }),
        };
        return grants;
      }
      return statement(sql);
    },
    batch:
      batch ??
      (async <T>(statements: SqlStatement[]) =>
        statements.map(() => ({ results: [] as T[], meta: { changes: 0 } }))),
  };
}

/** An owner's database: every permission, data access mocked at the store. */
export function ownerAuthorizationDatabase(userId = TEST_USER_ID): SqlDatabase {
  return authorizationDatabase({ userId });
}

/**
 * A session runtime dispatch that answers with `fetch`, handed the request a
 * runtime receives on any host, so a fixture asserts on what the runtime's
 * server would see rather than on how it was addressed.
 */
export function fakeSessionRuntimeDispatch(
  fetch: (request: Request, sessionId: string) => Promise<Response>
): SessionRuntimeDispatch {
  return (sessionId, request) => fetch(request, sessionId);
}

/** A cache that lives for the test. */
function memoryCacheStore(): CacheStore {
  const entries = new Map<string, string>();
  return {
    get: (async (key: string, type?: "json") => {
      const value = entries.get(key) ?? null;
      return value !== null && type === "json" ? JSON.parse(value) : value;
    }) as CacheStore["get"],
    put: async (key, value) => {
      entries.set(key, value);
    },
    delete: async (key) => {
      entries.delete(key);
    },
  };
}

/** A port member no test wired: calling it fails naming it, so an unexpected dependency shows. */
function unwired(port: keyof Env, member: string): () => Promise<never> {
  return async () => {
    throw new Error(`${port}.${member} is not wired in this test`);
  };
}

/** The configuration every unit fixture's `Env` starts from. */
const TEST_ENV_CONFIG = {
  DEPLOYMENT_NAME: "test",
  GITHUB_BOT_USERNAME: "open-inspect[bot]",
  TOKEN_ENCRYPTION_KEY: "test-key",
  PROVIDER_ACCOUNTS_ENCRYPTION_KEY: "test-provider-accounts-key",
} as const satisfies Partial<EnvConfig>;

/**
 * An `Env` for unit fixtures: `TEST_ENV_CONFIG`, a database that answers
 * nothing, a cache, and ports that fail when reached, each replaced by
 * `overrides`.
 */
export function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...TEST_ENV_CONFIG,
    DB: { prepare: () => emptyStatement(), batch: async () => [] },
    SESSION: unwired("SESSION", "dispatch"),
    REPOS_CACHE: memoryCacheStore(),
    MEDIA_BUCKET: {
      put: unwired("MEDIA_BUCKET", "put"),
      delete: unwired("MEDIA_BUCKET", "delete"),
      head: unwired("MEDIA_BUCKET", "head"),
      get: unwired("MEDIA_BUCKET", "get"),
    },
    ...overrides,
  };
}

/** Compile a route path into a matcher over a concrete pathname, for handler-level fixtures. */
export function routePathPattern(path: string): RegExp {
  return new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`);
}

/** Select the first contract for a concrete method and path, with the raw parameters it binds. */
export function matchRoute<Entry extends { method: string; path: string }>(
  entries: readonly Entry[],
  method: string,
  path: string
): { route: Entry; params: RouteParams } | undefined {
  for (const route of entries) {
    if (route.method !== method) continue;
    const match = path.match(routePathPattern(route.path));
    if (match) return { route, params: { ...match.groups } };
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
