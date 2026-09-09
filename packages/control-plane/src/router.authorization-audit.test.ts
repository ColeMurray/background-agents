import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type * as AuthenticateModule from "./auth/authenticate";
import type { Principal } from "./auth/principal";
import type { SqlDatabase, SqlStatement } from "./db/sql-database";
import { Hono } from "hono";
import {
  json,
  GITHUB_SANDBOX_FALLBACK_ROUTE,
  permissionRequirement,
  requireAll,
  requireAutomation,
  requirePermission,
  serviceAuthorized,
} from "./routes/shared";
import { admit } from "./routing/admit";
import type { ControlPlaneHonoEnv } from "./routing/hono-env";
import {
  createTestRequestHandler,
  fakeSessionRuntimeDispatch,
  TEST_BACKGROUND_TASK_CONTEXT,
} from "./router.test-support";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("./auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const TEST_ROUTES = new Hono<ControlPlaneHonoEnv>();
TEST_ROUTES.post(
  "/audit-test/actorless-service",
  admit({
    ...{ authentication: { kind: "user-or-service" }, supportedScmProviders: "all" },
    authorization: requirePermission("sessions.lifecycle", {
      actorlessGrants: [{ service: "github-bot" }],
    }),
  }),
  () => json({ handled: true })
);
TEST_ROUTES.post(
  "/audit-test/user-only",
  admit({
    ...{ authentication: { kind: "user" }, supportedScmProviders: "all" },
    authorization: requirePermission("workspace.members.manage"),
  }),
  () => json({ handled: true })
);
TEST_ROUTES.post(
  "/audit-test/automations/:id/pause",
  admit({
    ...{ authentication: { kind: "user-or-service" }, supportedScmProviders: "all" },
    authorization: requireAutomation("manage"),
  }),
  () => json({ handled: true })
);
TEST_ROUTES.post(
  "/audit-test/managed",
  admit({
    ...{ authentication: { kind: "user-or-service" }, supportedScmProviders: "all" },
    authorization: requirePermission("workspace.members.manage"),
  }),
  () => json({ handled: true }, 201)
);
TEST_ROUTES.get(
  "/audit-test/managed",
  admit({
    ...{ authentication: { kind: "user-or-service" }, supportedScmProviders: "all" },
    authorization: requirePermission("workspace.members.manage"),
  }),
  () => json({ handled: true })
);
TEST_ROUTES.get(
  "/audit-test/profiles",
  admit({
    ...{ authentication: { kind: "user-or-service" }, supportedScmProviders: "all" },
    authorization: requirePermission("skill_profiles.manage_own"),
  }),
  () => json({ handled: true })
);
TEST_ROUTES.get(
  "/audit-test/read",
  admit({
    ...{ authentication: { kind: "user-or-service" }, supportedScmProviders: "all" },
    authorization: requirePermission("workspace.roles.read"),
  }),
  () => json({ handled: true })
);
TEST_ROUTES.post(
  "/audit-test/service-actor",
  admit({
    ...{ authentication: { kind: "user-or-service" }, supportedScmProviders: "all" },
    authorization: requirePermission("sessions.lifecycle"),
  }),
  () => json({ handled: true }, 201)
);
TEST_ROUTES.post(
  "/audit-test/service",
  admit({
    ...{ authentication: { kind: "service" }, supportedScmProviders: "all" },
    authorization: serviceAuthorized("github-bot", "required"),
  }),
  () => json({ handled: true })
);
TEST_ROUTES.post(
  "/audit-test/multi",
  admit({
    ...{ authentication: { kind: "user-or-service" }, supportedScmProviders: "all" },
    authorization: requireAll(
      permissionRequirement("analytics.read"),
      permissionRequirement("workspace.members.manage")
    ),
  }),
  () => json({ handled: true })
);
TEST_ROUTES.post(
  "/audit-test/sessions/:id/upload",
  admit({
    ...GITHUB_SANDBOX_FALLBACK_ROUTE,
    authorization: requirePermission("sessions.collaborate"),
  }),
  () => json({ handled: true }, 201)
);

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
  return {
    env: {
      DB: db,
      SCM_PROVIDER: "github",
      SESSION: fakeSessionRuntimeDispatch(async () => new Response(null, { status: 204 })),
    } as never,
    auditWrites,
  };
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

const handleRequest = createTestRequestHandler([TEST_ROUTES]);

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

  it("does not report a bypassed user permission as effective for an actorless service", async () => {
    authenticateAs({ kind: "service", service: "github-bot", actor: null });
    const allowed = createEnv();
    const response = await handleRequest(
      new Request("https://test.local/audit-test/actorless-service", { method: "POST" }),
      allowed.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    const metadata = auditRecord(allowed.auditWrites[0]).metadata;
    expect(metadata).toMatchObject({
      admission: "service",
      requirements: [
        { kind: "actorless-service-grant", service: "github-bot" },
        { kind: "permission", permission: "sessions.lifecycle" },
      ],
    });
    expect(metadata).not.toHaveProperty("effectivePermissions");
    expect(metadata).not.toHaveProperty("requiredPermission");
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

  it("preserves every evaluated permission when a later requirement is denied", async () => {
    authenticateAs({ kind: "user", userId: "user-1" });
    const denied = createEnv({ roleKey: "viewer" });
    const response = await handleRequest(
      new Request("https://test.local/audit-test/multi", { method: "POST" }),
      denied.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(403);
    expect(auditRecord(denied.auditWrites[0])).toMatchObject({
      reasonCode: "permission_required",
      metadata: {
        requirements: [
          { kind: "active-user" },
          { kind: "permission", permission: "analytics.read" },
          { kind: "permission", permission: "workspace.members.manage" },
        ],
        effectivePermissions: ["analytics.read"],
        requiredPermission: "workspace.members.manage",
      },
    });
  });

  it("records sandbox fallback admission without the bypassed route permission", async () => {
    mocks.authenticate.mockResolvedValue({
      reason: "Unauthorized",
      status: 401,
      failedScheme: "none",
    });
    const sandbox = createEnv();
    const response = await handleRequest(
      new Request("https://test.local/audit-test/sessions/session-1/upload", {
        method: "POST",
        headers: { Authorization: "Bearer sandbox-token" },
      }),
      sandbox.env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(201);
    expect(auditRecord(sandbox.auditWrites[0])).toMatchObject({
      principalKind: "sandbox",
      action: "authorization.request_allowed",
      metadata: {
        admission: "sandbox",
        requirements: [{ kind: "sandbox-admission", sessionId: "session-1" }],
        sessionId: "session-1",
      },
    });
    expect(auditRecord(sandbox.auditWrites[0]).metadata).not.toHaveProperty("effectivePermissions");
    expect(auditRecord(sandbox.auditWrites[0]).metadata).not.toHaveProperty("requiredPermission");
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
