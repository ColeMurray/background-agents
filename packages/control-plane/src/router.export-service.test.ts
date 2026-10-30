import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import { Hono } from "hono";
import type * as AuthenticateModule from "./auth/authenticate";
import type { Principal } from "./auth/principal";
import type { SqlDatabase, SqlStatement } from "./db/sql-database";
import { serviceAllowsPermission } from "./authorization/service-permissions";
import { GITHUB_SERVICE_ROUTE, json, requirePermission, serviceAuthorized } from "./routes/shared";
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

const USER_OR_SERVICE = {
  authentication: { kind: "user-or-service" },
  supportedScmProviders: "all",
} as const;

const TEST_ROUTES = new Hono<ControlPlaneHonoEnv>();
TEST_ROUTES.get(
  "/export-test/export",
  admit({
    ...USER_OR_SERVICE,
    authorization: requirePermission("sessions.export"),
    allowExportService: true,
  }),
  () => json({ handled: true })
);
TEST_ROUTES.get(
  "/export-test/not-opted-in",
  admit({ ...USER_OR_SERVICE, authorization: requirePermission("sessions.read") }),
  () => json({ handled: true })
);
TEST_ROUTES.post(
  "/export-test/opted-in-but-outside-ceiling",
  admit({
    ...USER_OR_SERVICE,
    authorization: requirePermission("workspace.members.manage"),
    allowExportService: true,
  }),
  () => json({ handled: true })
);
TEST_ROUTES.get(
  "/export-test/service-route-not-opted-in",
  admit({ ...GITHUB_SERVICE_ROUTE, authorization: serviceAuthorized("export") }),
  () => json({ handled: true })
);

const handleRequest = createTestRequestHandler([TEST_ROUTES]);

/** A database that answers the RBAC lookup for user-1 with `roleKey`. */
function createEnv(roleKey: "owner" | "viewer" = "owner") {
  const role = roleKey === "viewer" ? BUILT_IN_ROLE_REGISTRY.viewer : BUILT_IN_ROLE_REGISTRY.owner;
  const db: SqlDatabase = {
    prepare(sql: string) {
      const statement: SqlStatement = {
        bind: () => statement,
        first: async <T>() =>
          (sql.includes("FROM users u")
            ? {
                user_id: "user-1",
                suspended_at: null,
                role_id: role.id,
                role_key: roleKey,
                role_name: roleKey === "viewer" ? "Viewer" : "Owner",
              }
            : null) as T | null,
        all: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
        run: async <T>() => ({ results: [] as T[], meta: { changes: 1 } }),
      };
      return statement;
    },
    batch: async () => [],
  };
  return {
    DB: db,
    SCM_PROVIDER: "github",
    SESSION: fakeSessionRuntimeDispatch(async () => new Response(null, { status: 204 })),
  } as never;
}

const ACTOR = {
  provider: "github",
  providerUserId: "42",
  canonicalUserId: "user-1",
  participantUserId: "github:42",
} as const;

function authenticateAs(principal: Principal): void {
  mocks.authenticate.mockImplementation(async (request: Request) => ({ principal, request }));
}

function get(path: string, method = "GET") {
  return handleRequest(
    new Request(`https://test.local${path}`, { method }),
    createEnv(),
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

beforeEach(() => {
  mocks.authenticate.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("export service", () => {
  it("caps its permissions at reading and exporting sessions", () => {
    expect(serviceAllowsPermission("export", "sessions.read")).toBe(true);
    expect(serviceAllowsPermission("export", "sessions.export")).toBe(true);
    expect(serviceAllowsPermission("export", "sessions.create")).toBe(false);
    expect(serviceAllowsPermission("export", "workspace.members.manage")).toBe(false);
  });

  it("exports as an owner actor on a route that opts in", async () => {
    authenticateAs({ kind: "service", service: "export", actor: ACTOR });
    const response = await get("/export-test/export");
    expect(response.status).toBe(200);
  });

  it("is refused on routes that do not opt in, even within its ceiling", async () => {
    authenticateAs({ kind: "service", service: "export", actor: ACTOR });
    const response = await get("/export-test/not-opted-in");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_capability_required" });
  });

  it("is refused on a service route that names it but does not opt in", async () => {
    authenticateAs({ kind: "service", service: "export", actor: ACTOR });
    const response = await get("/export-test/service-route-not-opted-in");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_capability_required" });
  });

  it("is refused outside its ceiling on a route that opts in", async () => {
    authenticateAs({ kind: "service", service: "export", actor: ACTOR });
    const response = await get("/export-test/opted-in-but-outside-ceiling", "POST");
    expect(response.status).toBe(403);
  });

  it("needs an actor", async () => {
    authenticateAs({ kind: "service", service: "export", actor: null });
    const response = await get("/export-test/export");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_actor_required" });
  });

  it("gets no more than its actor: a viewer cannot export", async () => {
    authenticateAs({ kind: "service", service: "export", actor: ACTOR });
    const response = await handleRequest(
      new Request("https://test.local/export-test/export"),
      createEnv("viewer"),
      TEST_BACKGROUND_TASK_CONTEXT
    );
    expect(response.status).toBe(403);
  });

  it("does not let other services export", async () => {
    authenticateAs({ kind: "service", service: "github-bot", actor: ACTOR });
    const response = await get("/export-test/export");
    expect(response.status).toBe(403);
  });
});
