/**
 * Fixtures shared by the automation route suites: the store doubles the
 * suites' `vi.mock` factories hand out, the request builder, and the sample
 * automation row. Each suite declares its own `vi.mock` calls (they are
 * per-file) and points them at the doubles exported here.
 */

import { vi } from "vitest";
import { PERMISSION_IDS, type PermissionId } from "@open-inspect/shared/rbac";
import type { Principal } from "../auth/principal";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import {
  authorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
  type TestRequestHandler,
} from "../router.test-support";
import type { Env } from "../types";

export const mocks = { authenticate: vi.fn() };

export const mockProviderAdapterGet = vi.fn();
export const mockResolveGitHubCredentialAuthority = vi.fn();
export const mockResolveGitHubEnrichmentForRequest = vi.fn();
export const mockSchedulerTrigger = vi.fn();

export const mockStore = {
  list: vi.fn(),
  getById: vi.fn(),
  resolveCanonicalOwner: vi.fn(async (automation: unknown) => automation),
  update: vi.fn(),
  softDelete: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  getActiveRunForAutomation: vi.fn(),
  getRunById: vi.fn(),
  getRepositoriesForAutomation: vi.fn(),
  getRepositoriesForAutomationIds: vi.fn(),
  getEnvironmentsForAutomation: vi.fn(),
  getEnvironmentsForAutomationIds: vi.fn(),
  bindAutomationInsert: vi.fn(),
  bindAutomationUpdate: vi.fn(),
  bindSoftDelete: vi.fn(),
  bindPause: vi.fn(),
  bindResume: vi.fn(),
  bindRepositoryInserts: vi.fn(),
  bindReplaceRepositories: vi.fn(),
  bindEnvironmentInserts: vi.fn(),
  bindReplaceEnvironments: vi.fn(),
  listInvocations: vi.fn(),
  listRecentExecutionsForAutomationIds: vi.fn(),
};

export const mockProviderAuthStore = {
  list: vi.fn(),
  listForAutomationIds: vi.fn(),
  bindInserts: vi.fn(),
  bindReplace: vi.fn(),
};

export const mockProviderAccountStore = {
  getById: vi.fn(),
};

export const mockUserStore = {
  resolveOrCreateUser: vi.fn().mockResolvedValue({ id: "resolved-user-1", isNew: false }),
};

export const mockEnvironmentStore = {
  getById: vi.fn(),
};

/** Shared D1 batch spy — createEnv wires it as env.DB.batch. */
export const mockBatch = vi.fn();

/**
 * The workspace database as admission and the handlers see it: admission's
 * lookups are answered by test support, every other statement goes to a
 * statement spy, and `batch` is the shared spy.
 */
function createDatabase(permissions: readonly PermissionId[]): SqlDatabase {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => ({ satisfied: 1 })),
    all: vi.fn(async () => ({ results: [] })),
  };
  return authorizationDatabase({
    permissions: permissions.length === PERMISSION_IDS.length ? undefined : permissions,
    statement: () => statement as unknown as SqlStatement,
    batch: mockBatch,
  });
}

export function createEnv(permissions: readonly PermissionId[] = PERMISSION_IDS): Env {
  return {
    ...TEST_SERVICE_SECRETS,
    SCM_PROVIDER: "github",
    DB: createDatabase(permissions),
    SESSION: {} as DurableObjectNamespace,
    DEPLOYMENT_NAME: "test",
    TOKEN_ENCRYPTION_KEY: "test-key",
  } as unknown as Env;
}

export const USER_PRINCIPAL: Principal = {
  kind: "user",
  userId: "user-1",
};

export const SLACK_BOT_PRINCIPAL: Principal = {
  kind: "service",
  service: "slack-bot",
  actor: {
    provider: "slack",
    providerUserId: "U0123",
    canonicalUserId: null,
    participantUserId: "slack:U0123",
  },
};

export interface AutomationRequestOptions {
  body?: unknown;
  query?: Record<string, string | string[]>;
  principal?: Principal;
  permissions?: readonly PermissionId[];
}

/** A request builder over one module's handler, authenticating as the requested principal. */
export function automationRequest(handleRequest: TestRequestHandler) {
  return async (
    method: string,
    path: string,
    options?: AutomationRequestOptions
  ): Promise<Response> => {
    const url = new URL(`https://test.local${path}`);
    if (options?.query) {
      for (const [k, v] of Object.entries(options.query)) {
        for (const value of Array.isArray(v) ? v : [v]) {
          url.searchParams.append(k, value);
        }
      }
    }
    const init: RequestInit = { method };
    if (options?.body) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(options.body);
    }
    const principal = options?.principal ?? USER_PRINCIPAL;
    mocks.authenticate.mockImplementation(async (request: Request) => ({ principal, request }));
    return handleRequest(
      new Request(url, init),
      createEnv(options?.permissions),
      TEST_BACKGROUND_TASK_CONTEXT
    );
  };
}

export const now = Date.now();

export const sampleRow = {
  id: "auto-1",
  name: "Daily sync",
  instructions: "Run tests",
  trigger_type: "schedule",
  schedule_cron: "0 9 * * *",
  schedule_tz: "UTC",
  model: "anthropic/claude-sonnet-4-6",
  reasoning_effort: null,
  enabled: 1,
  next_run_at: now,
  consecutive_failures: 0,
  created_by: "user-1",
  created_at: now,
  updated_at: now,
  deleted_at: null,
};

/**
 * Defaults every test can override; re-set per test so per-test overrides
 * (mockClear keeps implementations) cannot leak across tests. Admission
 * resolves the automation for every manage route, so the lookup must not
 * depend on what an earlier test left behind.
 */
export function applyMockDefaults(): void {
  mockStore.getById.mockResolvedValue(sampleRow);
  mockStore.getRepositoriesForAutomation.mockResolvedValue([]);
  mockStore.getRepositoriesForAutomationIds.mockResolvedValue(new Map());
  mockStore.getEnvironmentsForAutomation.mockResolvedValue([]);
  mockStore.getEnvironmentsForAutomationIds.mockResolvedValue(new Map());
  mockStore.listRecentExecutionsForAutomationIds.mockResolvedValue(new Map());
  mockProviderAuthStore.list.mockResolvedValue([]);
  mockProviderAuthStore.listForAutomationIds.mockResolvedValue(new Map());
  mockStore.bindAutomationInsert.mockReturnValue({ sql: "insert-automation" });
  mockStore.bindAutomationUpdate.mockReturnValue({ sql: "update-automation" });
  mockStore.bindSoftDelete.mockReturnValue({ sql: "delete-automation" });
  mockStore.bindPause.mockReturnValue({ sql: "pause-automation" });
  mockStore.bindResume.mockReturnValue({ sql: "resume-automation" });
  mockStore.bindRepositoryInserts.mockReturnValue([{ sql: "insert-repositories" }]);
  mockStore.bindReplaceRepositories.mockReturnValue([{ sql: "replace-repositories" }]);
  mockStore.bindEnvironmentInserts.mockReturnValue([{ sql: "insert-environments" }]);
  mockStore.bindReplaceEnvironments.mockReturnValue([{ sql: "replace-environments" }]);
  mockProviderAuthStore.bindInserts.mockReturnValue([{ sql: "insert-provider-auth" }]);
  mockProviderAuthStore.bindReplace.mockReturnValue([{ sql: "replace-provider-auth" }]);
  mockBatch.mockResolvedValue([{ meta: { changes: 1 }, results: [] }]);
  mockSchedulerTrigger.mockResolvedValue({
    invocationId: "inv-1",
    runs: [{ id: "run-1" }],
  });
  mockEnvironmentStore.getById.mockResolvedValue({ id: "env_1", name: "Fullstack" });
  mockProviderAccountStore.getById.mockResolvedValue({
    id: "0123456789abcdef0123456789abcdef",
    provider: "openai",
    status: "active",
    archivedAt: null,
  });
  mockProviderAdapterGet.mockReturnValue({});
  mockResolveGitHubCredentialAuthority.mockResolvedValue({ kind: "legacy" });
  mockResolveGitHubEnrichmentForRequest.mockResolvedValue(null);
}
