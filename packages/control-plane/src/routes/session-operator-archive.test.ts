import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import { listRouteContracts } from "../routing/route-contracts";
import { fakeSessionRuntimeDispatch, TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import type { Env } from "../types";
import {
  handleOperatorSessionArchive,
  sessionOperatorArchiveRoutes,
} from "./session-operator-archive";
import { withSessionRuntime } from "./session-route";
import type { UserRouteContext } from "./shared";

const OPERATOR_USER_ID = "0123456789abcdef0123456789abcdef";
const OTHER_USER_ID = "fedcba9876543210fedcba9876543210";

function createDb(): SqlDatabase {
  const statement = {
    bind: vi.fn(),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  statement.bind.mockReturnValue(statement);
  return { prepare: vi.fn(() => statement) } as unknown as SqlDatabase;
}

function createCtx(userId: string): UserRouteContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
    db: createDb(),
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    principal: { kind: "user", userId },
    metrics: {
      sqlQueries: [],
      spans: {},
      time: async <T>(_name: string, operation: () => Promise<T>) => operation(),
      summarize: () => ({}),
    },
  } as unknown as UserRouteContext;
}

const env = {
  SESSION: fakeSessionRuntimeDispatch(() => {
    throw new Error("No candidate should reach a session runtime in these cases");
  }),
} as unknown as Env;

function post(body: unknown, ctx: UserRouteContext): Promise<Response> {
  return handleOperatorSessionArchive(
    new Request("https://control-plane.test/operator/sessions/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    {},
    withSessionRuntime(env, ctx)
  );
}

describe("operator session archive route", () => {
  it("is restricted to authenticated human users on every SCM provider", () => {
    const contract = listRouteContracts(sessionOperatorArchiveRoutes).find(
      (candidate) => candidate.method === "POST" && candidate.path === "/operator/sessions/archive"
    );
    if (!contract) throw new Error("Operator archive route did not match");
    expect(contract.authentication).toEqual({ kind: "user" });
    expect(contract.supportedScmProviders).toBe("all");
  });

  it("declares the workspace-wide archive permission so the router decides access", () => {
    const contract = listRouteContracts(sessionOperatorArchiveRoutes).find(
      (candidate) => candidate.method === "POST" && candidate.path === "/operator/sessions/archive"
    );
    if (!contract) throw new Error("Operator archive route did not match");
    expect(contract.authorization).toEqual({
      kind: "active-user",
      allOf: [{ kind: "permission", permission: "sessions.archive_any" }],
      service: { kind: "deny" },
      auditAllowed: true,
    });
  });

  it("rejects caller-selected identity fields", async () => {
    const response = await post({ operatorUserId: OTHER_USER_ID }, createCtx(OPERATOR_USER_ID));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request body" });
  });

  it("rejects a malformed cursor before touching the index", async () => {
    const ctx = createCtx(OPERATOR_USER_ID);
    const response = await post({ cursor: "not-a-cursor" }, ctx);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid cursor" });
    expect(ctx.db.prepare).not.toHaveBeenCalled();
  });

  it("uses the authenticated operator and returns an empty stable page", async () => {
    const response = await post({}, createCtx(OPERATOR_USER_ID));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      archivedIds: [],
      alreadyArchivedIds: [],
      missingArchivedIds: [],
      orphanedIds: [],
      skippedCancelledIds: [],
      skippedQueuedWorkIds: [],
      failed: [],
      hasMore: false,
      nextCursor: null,
    });
  });
});
