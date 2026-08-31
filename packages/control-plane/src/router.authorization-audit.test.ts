import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type * as AuthenticateModule from "./auth/authenticate";
import type { Principal } from "./auth/principal";
import type { SqlDatabase, SqlStatement } from "./db/sql-database";
import { handleRequest, routes } from "./router";
import {
  json,
  requireAutomation,
  requirePermission,
  serviceAuthorized,
  type Route,
} from "./routes/shared";
import { TEST_BACKGROUND_TASK_CONTEXT } from "./router.test-support";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("./auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const TEST_ROUTES: Route[] = [
  {
    authentication: { kind: "user" },
    supportedScmProviders: "all",
    method: "POST",
    pattern: /^\/audit-test\/user-only$/,
    authorization: requirePermission("workspace.members.manage"),
    handler: async () => json({ handled: true }),
  },
  {
    authentication: { kind: "user-or-service" },
    supportedScmProviders: "all",
    method: "POST",
    pattern: /^\/audit-test\/automations\/(?<id>[^/]+)\/pause$/,
    authorization: requireAutomation("manage"),
    handler: async () => json({ handled: true }),
  },
  {
    authentication: { kind: "user-or-service" },
    supportedScmProviders: "all",
    method: "POST",
    pattern: /^\/audit-test\/managed$/,
    authorization: requirePermission("workspace.members.manage"),
    handler: async () => json({ handled: true }, 201),
  },
  {
    authentication: { kind: "user-or-service" },
    supportedScmProviders: "all",
    method: "GET",
    pattern: /^\/audit-test\/managed$/,
    authorization: requirePermission("workspace.members.manage"),
    handler: async () => json({ handled: true }),
  },
  {
    authentication: { kind: "user-or-service" },
    supportedScmProviders: "all",
    method: "GET",
    pattern: /^\/audit-test\/profiles$/,
    authorization: requirePermission("skill_profiles.manage_own"),
    handler: async () => json({ handled: true }),
  },
  {
    authentication: { kind: "user-or-service" },
    supportedScmProviders: "all",
    method: "GET",
    pattern: /^\/audit-test\/read$/,
    authorization: requirePermission("workspace.roles.read"),
    handler: async () => json({ handled: true }),
  },
  {
    authentication: { kind: "user-or-service" },
    supportedScmProviders: "all",
    method: "POST",
    pattern: /^\/audit-test\/service-actor$/,
    authorization: requirePermission("sessions.lifecycle"),
    handler: async () => json({ handled: true }, 201),
  },
  {
    authentication: { kind: "service" },
    supportedScmProviders: "all",
    method: "POST",
    pattern: /^\/audit-test\/service$/,
    authorization: serviceAuthorized("github-bot", "required"),
    handler: async () => json({ handled: true }),
  },
];

interface AuditWrite {
  values: unknown[];
}

function createEnv(options?: {
  roleKey?: "owner" | "administrator" | "viewer";
  suspendedAt?: number | null;
  auditError?: Error;
  authorizationError?: Error;
  automationOwnerId?: string;
}) {
  const auditWrites: AuditWrite[] = [];
  const db: SqlDatabase = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement: SqlStatement = {
        bind: (...bound: unknown[]) => {
          values = bound;
          return statement;
        },
        first: async <T>() => {
          if (sql.includes("FROM users u") && options?.authorizationError) {
            throw options.authorizationError;
          }
          return (
            sql.includes("SELECT * FROM automations")
              ? {
                  id: "automation-1",
                  user_id: options?.automationOwnerId ?? "user-1",
                  created_by: "owner",
                }
              : sql.includes("FROM users u")
                ? {
                    user_id: "user-1",
                    suspended_at: options?.suspendedAt ?? null,
                    role_id:
                      options?.roleKey === "viewer"
                        ? BUILT_IN_ROLE_REGISTRY.viewer.id
                        : options?.roleKey === "administrator"
                          ? BUILT_IN_ROLE_REGISTRY.administrator.id
                          : BUILT_IN_ROLE_REGISTRY.owner.id,
                    role_key: options?.roleKey ?? "owner",
                    role_name:
                      options?.roleKey === "viewer"
                        ? "Viewer"
                        : options?.roleKey === "administrator"
                          ? "Administrator"
                          : "Owner",
                  }
                : null
          ) as T | null;
        },
        all: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
        run: async <T>() => {
          if (sql.includes("INSERT INTO authorization_audit_events")) {
            if (options?.auditError) throw options.auditError;
            auditWrites.push({ values });
          }
          return { results: [] as T[], meta: { changes: 1 } };
        },
      };
      return statement;
    },
    batch: async () => [],
  };
  return { env: { DB: db, SCM_PROVIDER: "github" } as never, auditWrites };
}

function authenticateAs(principal: Principal): void {
  mocks.authenticate.mockImplementation(async (request: Request) => ({ principal, request }));
}

function auditRecord(write: AuditWrite) {
  return {
    requestId: write.values[2],
    principalKind: write.values[3],
    actorUserId: write.values[4],
    actorService: write.values[5],
    action: write.values[6],
    path: write.values[7],
    reasonCode: write.values[8],
    operationResult: write.values[9],
    metadata: JSON.parse(String(write.values[10])),
  };
}

beforeAll(() => routes.push(...TEST_ROUTES));

afterAll(() => {
  routes.splice(routes.length - TEST_ROUTES.length, TEST_ROUTES.length);
});

beforeEach(() => {
  mocks.authenticate.mockReset();
});

describe("router authorization decision auditing", () => {
  it("audits allowed and denied user decisions", async () => {
    authenticateAs({ kind: "user", userId: "user-1" });
    const allowed = createEnv();
    const allowedResponse = await handleRequest(
      new Request("https://test.local/audit-test/managed", { method: "POST" }),
      allowed.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(allowedResponse.status).toBe(201);
    expect(auditRecord(allowed.auditWrites[0])).toMatchObject({
      principalKind: "user",
      actorUserId: "user-1",
      action: "authorization.request_allowed",
      path: "/audit-test/managed",
      reasonCode: "authorization_allowed",
      operationResult: "applied",
      metadata: {
        httpMethod: "POST",
        httpStatus: 201,
        requiredPermission: "workspace.members.manage",
      },
    });

    const denied = createEnv({ roleKey: "viewer" });
    const deniedResponse = await handleRequest(
      new Request("https://test.local/audit-test/managed", { method: "POST" }),
      denied.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(deniedResponse.status).toBe(403);
    expect(auditRecord(denied.auditWrites[0])).toMatchObject({
      action: "authorization.request_denied",
      reasonCode: "permission_required",
      operationResult: "denied",
      metadata: { responseCode: "permission_required", responseReason: "Forbidden" },
    });
  });

  it("audits allowed actor-backed, allowed service, and denied service decisions", async () => {
    authenticateAs({
      kind: "service",
      service: "github-bot",
      actor: {
        provider: "github",
        providerUserId: "42",
        canonicalUserId: "user-1",
        participantUserId: "github:42",
      },
    });
    const allowed = createEnv();
    expect(
      await handleRequest(
        new Request("https://test.local/audit-test/service-actor", { method: "POST" }),
        allowed.env,
        TEST_BACKGROUND_TASK_CONTEXT
      )
    ).toHaveProperty("status", 201);
    expect(auditRecord(allowed.auditWrites[0])).toMatchObject({
      principalKind: "service",
      actorUserId: "user-1",
      actorService: "github-bot",
      action: "authorization.request_allowed",
      metadata: { actor: { participantUserId: "github:42" } },
    });

    const serviceAllowed = createEnv();
    expect(
      await handleRequest(
        new Request("https://test.local/audit-test/service", { method: "POST" }),
        serviceAllowed.env,
        TEST_BACKGROUND_TASK_CONTEXT
      )
    ).toHaveProperty("status", 200);
    expect(auditRecord(serviceAllowed.auditWrites[0])).toMatchObject({
      actorService: "github-bot",
      action: "authorization.request_allowed",
      metadata: { requirements: [{ kind: "service-capability" }] },
    });

    authenticateAs({ kind: "service", service: "linear-bot", actor: null });
    const denied = createEnv();
    const response = await handleRequest(
      new Request("https://test.local/audit-test/service", { method: "POST" }),
      denied.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
    expect(response.status).toBe(403);
    expect(auditRecord(denied.auditWrites[0])).toMatchObject({
      actorService: "linear-bot",
      action: "authorization.request_denied",
      reasonCode: "service_capability_required",
      metadata: { requirements: [{ kind: "service-capability" }] },
    });
  });

  it("audits a verified service principal rejected by a user-only route", async () => {
    authenticateAs({ kind: "service", service: "github-bot", actor: null });
    const denied = createEnv();
    const response = await handleRequest(
      new Request("https://test.local/audit-test/user-only", { method: "POST" }),
      denied.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(403);
    expect(auditRecord(denied.auditWrites[0])).toMatchObject({
      principalKind: "service",
      actorService: "github-bot",
      action: "authorization.request_denied",
      metadata: {
        requirements: [{ kind: "principal-type" }],
        responseReason: "Human user authentication required",
      },
    });
  });

  it("audits sensitive protected GETs but not ordinary reads", async () => {
    authenticateAs({ kind: "user", userId: "user-1" });
    const sensitive = createEnv();
    await handleRequest(
      new Request("https://test.local/audit-test/managed"),
      sensitive.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
    await handleRequest(
      new Request("https://test.local/audit-test/profiles"),
      sensitive.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
    expect(sensitive.auditWrites).toHaveLength(2);
    expect(auditRecord(sensitive.auditWrites[1])).toMatchObject({
      metadata: { requiredPermission: "skill_profiles.manage_own" },
    });

    const ordinary = createEnv();
    await handleRequest(
      new Request("https://test.local/audit-test/read"),
      ordinary.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
    expect(ordinary.auditWrites).toHaveLength(0);
  });

  it("audits the any grant selected for a non-owned automation", async () => {
    authenticateAs({ kind: "user", userId: "user-1" });
    const access = createEnv({ roleKey: "administrator", automationOwnerId: "user-2" });
    const response = await handleRequest(
      new Request("https://test.local/audit-test/automations/automation-1/pause", {
        method: "POST",
      }),
      access.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(auditRecord(access.auditWrites[0])).toMatchObject({
      action: "authorization.request_allowed",
      metadata: {
        requiredPermission: "automations.manage.any",
        effectivePermissions: ["automations.manage.any"],
      },
    });
  });

  it("preserves allowed and denied responses when audit persistence fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    authenticateAs({ kind: "user", userId: "user-1" });
    const allowed = createEnv({ auditError: new Error("audit unavailable") });
    expect(
      await handleRequest(
        new Request("https://test.local/audit-test/managed", { method: "POST" }),
        allowed.env,
        TEST_BACKGROUND_TASK_CONTEXT
      )
    ).toHaveProperty("status", 201);

    const denied = createEnv({ roleKey: "viewer", auditError: new Error("audit unavailable") });
    expect(
      await handleRequest(
        new Request("https://test.local/audit-test/managed", { method: "POST" }),
        denied.env,
        TEST_BACKGROUND_TASK_CONTEXT
      )
    ).toHaveProperty("status", 403);
  });

  it("does not misclassify authorization infrastructure failures as denials", async () => {
    authenticateAs({ kind: "user", userId: "user-1" });
    const unavailable = createEnv({ authorizationError: new Error("authorization unavailable") });
    const response = await handleRequest(
      new Request("https://test.local/audit-test/managed", { method: "POST" }),
      unavailable.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(503);
    expect(unavailable.auditWrites).toHaveLength(0);
  });
});
