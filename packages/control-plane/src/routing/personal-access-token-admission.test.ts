/**
 * Route admission for personal access tokens, end to end through the production host with real
 * authentication: a synthetic module stands in for routes that opt in, since no production route
 * does yet. The database answers token, role, and audit statements and records writes.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { BUILT_IN_ROLE_REGISTRY, type PermissionId } from "@open-inspect/shared/rbac";
import { PERSONAL_ACCESS_TOKEN_PREFIX } from "@open-inspect/shared/types/personal-access-tokens";
import { hashToken } from "../auth/crypto";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import type { RequestContext } from "../http/request-context";
import {
  createTestEnv,
  createTestRequestHandler,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import {
  ACTIVE_SELF,
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
} from "../routes/shared";
import { admit, dispatch } from "./admit";
import type { ControlPlaneHonoEnv } from "./hono-env";

const TOKEN = `${PERSONAL_ACCESS_TOKEN_PREFIX}${"5a".repeat(32)}`;
const NOW = Date.now();

async function describeContext(
  _request: Request,
  _env: unknown,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  return json({ principal: ctx.principal?.kind, permissions: ctx.authorization?.permissions });
}

const probeRoutes = new Hono<ControlPlaneHonoEnv>();
probeRoutes.get(
  "/probe/sessions",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.read"),
    personalAccessTokens: "accept",
  }),
  (c) => dispatch(c, describeContext)
);
probeRoutes.post(
  "/probe/automations",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("automations.create"),
    personalAccessTokens: "accept",
  }),
  (c) => dispatch(c, describeContext)
);
probeRoutes.get(
  "/probe/closed",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.read"),
  }),
  (c) => dispatch(c, describeContext)
);
const handleRequest = createTestRequestHandler([probeRoutes]);

interface Fixture {
  grant: PermissionId[];
  expiresAt?: number;
  /** The owner's custom-role grants; omitted, the owner is a workspace Owner. */
  ownerPermissions?: PermissionId[];
  suspended?: boolean;
}

async function tokenDatabase(fixture: Fixture) {
  const tokenHash = await hashToken(TOKEN);
  const audits: unknown[][] = [];
  const touches: unknown[][] = [];
  const role = fixture.ownerPermissions
    ? { role_id: "role-1", role_key: null, role_name: "Custom" }
    : { role_id: BUILT_IN_ROLE_REGISTRY.owner.id, role_key: "owner", role_name: "Owner" };
  const empty = { results: [], meta: { changes: 0 } };
  const db: SqlDatabase = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement: SqlStatement = {
        bind: (...values) => {
          bound = values;
          return statement;
        },
        first: async <T>() =>
          (sql.includes("FROM users u")
            ? { user_id: "user-1", suspended_at: fixture.suspended ? NOW : null, ...role }
            : null) as T | null,
        all: async <T>() => {
          if (sql.includes("FROM personal_access_tokens token")) {
            if (bound[0] !== tokenHash) return { results: [] as T[], meta: { changes: 0 } };
            const rows = (fixture.grant.length ? fixture.grant : [null]).map((permission_id) => ({
              id: "token-1",
              user_id: "user-1",
              display_prefix: TOKEN.slice(0, 13),
              expires_at: fixture.expiresAt ?? NOW + 60_000,
              permission_id,
            }));
            return { results: rows as T[], meta: { changes: 0 } };
          }
          if (sql.includes("FROM role_permissions")) {
            const rows = (fixture.ownerPermissions ?? []).map((permission_id) => ({
              permission_id,
            }));
            return { results: rows as T[], meta: { changes: 0 } };
          }
          return { results: [] as T[], meta: { changes: 0 } };
        },
        run: async <T>() => {
          if (sql.includes("INSERT INTO authorization_audit_events")) audits.push(bound);
          if (sql.includes("UPDATE personal_access_tokens")) touches.push(bound);
          return { results: [] as T[], meta: { changes: 1 } };
        },
      };
      return statement;
    },
    batch: async <T>(statements: SqlStatement[]) =>
      statements.map(() => ({ ...empty, results: [] as T[] })),
  };
  return { db, audits, touches };
}

async function send(db: SqlDatabase, path: string, init: { method?: string; token?: string } = {}) {
  const tasks = createTestBackgroundTasks();
  const response = await handleRequest(
    new Request(`https://cp.test${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${init.token ?? TOKEN}` },
    }),
    createTestEnv({ ...TEST_SERVICE_SECRETS, DB: db }),
    tasks
  );
  await tasks.settle();
  return { response, tasks };
}

describe("personal access token admission", () => {
  it("admits a token on an opted-in route with its owner's permissions narrowed to its grant", async () => {
    const { db, touches } = await tokenDatabase({ grant: ["sessions.read", "skills.read"] });
    const { response } = await send(db, "/probe/sessions");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      principal: "personal-access-token",
      permissions: ["sessions.read", "skills.read"],
    });
    expect(touches).toHaveLength(1);
    expect(touches[0]?.[1]).toBe("token-1");
  });

  it("admits a token's write on an opted-in human-user route", async () => {
    const { db } = await tokenDatabase({ grant: ["automations.create"] });
    const { response } = await send(db, "/probe/automations", { method: "POST" });
    expect(response.status).toBe(200);
  });

  it("refuses a route permission the token was not granted, though its owner holds it", async () => {
    const { db } = await tokenDatabase({ grant: ["skills.read"] });
    const { response } = await send(db, "/probe/sessions");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "sessions.read",
    });
  });

  it("refuses a granted permission its owner no longer holds", async () => {
    const { db } = await tokenDatabase({
      grant: ["sessions.read"],
      ownerPermissions: ["skills.read"],
    });
    const { response } = await send(db, "/probe/sessions");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "permission_required" });
  });

  it("refuses every request while the owner is suspended", async () => {
    const { db } = await tokenDatabase({ grant: ["sessions.read"], suspended: true });
    const { response } = await send(db, "/probe/sessions");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "active_user_required" });
  });

  it("refuses and audits a token on a route that does not accept tokens", async () => {
    const { db, audits } = await tokenDatabase({ grant: ["sessions.read"] });
    const { response } = await send(db, "/probe/closed");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "personal_access_token_not_accepted",
    });
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    expect(audit?.[3]).toBe("personal-access-token");
    expect(audit?.[4]).toBe("user-1");
    expect(JSON.parse(String(audit?.[10]))).toMatchObject({
      personalAccessTokenId: "token-1",
      responseCode: "personal_access_token_not_accepted",
    });
  });

  it("answers an expired token as unauthenticated", async () => {
    const { db, touches } = await tokenDatabase({ grant: ["sessions.read"], expiresAt: NOW - 1 });
    const { response } = await send(db, "/probe/sessions");
    expect(response.status).toBe(401);
    expect(touches).toHaveLength(0);
  });

  it("answers an unknown token as unauthenticated", async () => {
    const { db } = await tokenDatabase({ grant: ["sessions.read"] });
    const { response } = await send(db, "/probe/sessions", {
      token: `${PERSONAL_ACCESS_TOKEN_PREFIX}${"00".repeat(32)}`,
    });
    expect(response.status).toBe(401);
  });
});

describe("admit() with personalAccessTokens", () => {
  it("refuses at construction a token route no grant could narrow", () => {
    expect(() =>
      admit({
        ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
        authorization: ACTIVE_SELF,
        personalAccessTokens: "accept",
      })
    ).toThrow(/Route cannot accept personal access tokens/);
  });
});
