import { vi } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type * as AuthenticateModule from "../auth/authenticate";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import { createControlPlaneApp, type RouteModule } from "../routing/hono-app";
import type { Env } from "../types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

/** Only admission queries have rows; domain stores are spied on by their suites. */
export function authorizationDatabase({
  permissions,
}: {
  permissions: readonly PermissionId[];
}): SqlDatabase {
  return {
    prepare(sql) {
      const statement: SqlStatement = {
        bind: () => statement,
        first: async <T>() =>
          (sql.includes("FROM users u")
            ? {
                user_id: "user-1",
                suspended_at: null,
                role_id: "role-1",
                role_key: null,
                role_name: "Custom",
              }
            : null) as T | null,
        all: async <T>() => ({
          results: (sql.includes("FROM role_permissions")
            ? permissions.map((permission_id) => ({ permission_id }))
            : []) as T[],
          meta: { changes: 0 },
        }),
        run: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
      };
      return statement;
    },
    batch: async () => [],
  };
}

export function createRepositoryGrantEnv(permissions: readonly PermissionId[]): Env {
  return {
    DB: authorizationDatabase({ permissions }),
    SCM_PROVIDER: "github",
    SANDBOX_PROVIDER: "modal",
    TEAMS_ENFORCEMENT: "on",
    REPO_SECRETS_ENCRYPTION_KEY: "test-key",
  } as Env;
}

/** Mount only the domain under test, without importing the production route catalog. */
export function createRepositoryGrantRequest(module: RouteModule, env: () => Env) {
  const app = createControlPlaneApp([module], {
    backgroundTasks: () => createTestBackgroundTasks(),
  });
  return (path: string, method: string, body?: unknown, environment = env()): Promise<Response> =>
    Promise.resolve(
      app.fetch(
        new Request(`https://test.local${path}`, {
          method,
          headers: { "Content-Type": "application/json", "If-Match": "revision-1" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        environment
      )
    );
}

export function setupRepositoryGrantSpies(): void {
  mocks.authenticate.mockImplementation(async (request: Request) => ({
    principal: { kind: "user", userId: "user-1" },
    request,
  }));
  vi.spyOn(TeamMembershipStore.prototype, "listForUser").mockResolvedValue(
    new Map([
      ["team-1", "member"],
      ["owner-team", "member"],
    ])
  );
  vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
  vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);
  vi.spyOn(TeamRepositoryGrantStore.prototype, "listTeamsForRepository").mockResolvedValue([
    "other-team",
  ]);
}
