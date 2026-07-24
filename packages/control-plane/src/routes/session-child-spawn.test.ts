import { describe, expect, it, vi, beforeEach } from "vitest";
import { SessionInternalPaths } from "../session/contracts";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";

const { log, sessionStore } = vi.hoisted(() => {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  const sessionStore = {
    get: vi.fn(async () => ({
      userId: "user-1",
      environmentId: null,
      repoOwner: "acme",
      repoName: "app",
    })),
    getSpawnDepth: vi.fn(async () => 0),
    countActiveChildren: vi.fn(async () => 0),
    countTotalChildren: vi.fn(async () => 0),
    updateStatus: vi.fn(async () => {}),
  };
  return { log, sessionStore };
});

vi.mock("../logger", () => ({ createLogger: () => log }));
vi.mock("../session/initialize", () => ({ initializeSession: vi.fn(async () => {}) }));
vi.mock("../session/integration-settings-resolution", () => ({
  resolveCodeServerEnabled: vi.fn(async () => false),
  resolveSandboxSettings: vi.fn(async () => ({})),
}));
vi.mock("../db/session-index", () => ({
  SessionIndexStore: vi.fn(function () {
    return sessionStore;
  }),
}));

import { sessionChildSpawnRoutes } from "./session-child-spawn";

const SPAWN_CONTEXT = {
  repoOwner: "acme",
  repoName: "app",
  repoId: 1,
  model: "anthropic/claude-sonnet-5",
  reasoningEffort: null,
  baseBranch: "main",
  owner: {
    userId: "user-1",
    scmUserId: null,
    scmLogin: null,
    scmName: null,
    scmEmail: null,
    scmAccessTokenEncrypted: null,
    scmRefreshTokenEncrypted: null,
    scmTokenExpiresAt: null,
  },
};

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    db: {} as SqlDatabase,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function createEnv(onNotifyParent: () => Promise<Response>): Env {
  const fetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === SessionInternalPaths.spawnContext) return Response.json(SPAWN_CONTEXT);
    if (path === SessionInternalPaths.prompt) return Response.json({ ok: true });
    if (path === SessionInternalPaths.childSessionUpdate) return onNotifyParent();
    throw new Error(`Unexpected internal fetch: ${path}`);
  });
  return {
    SESSION: {
      idFromName: vi.fn((name: string) => `do-${name}`),
      get: vi.fn(() => ({ fetch })),
    },
  } as unknown as Env;
}

function getHandler(path: string) {
  for (const route of sessionChildSpawnRoutes) {
    const match = path.match(route.pattern);
    if (route.method === "POST" && match) return { handler: route.handler, match };
  }
  throw new Error(`No route found for POST ${path}`);
}

function spawnRequest(): Request {
  return new Request("https://test.local/sessions/parent-1/children", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Child task", prompt: "do the thing" }),
  });
}

describe("session child spawn route", () => {
  beforeEach(() => {
    log.error.mockClear();
  });

  it("completes the parent notification before responding", async () => {
    const order: string[] = [];
    const env = createEnv(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push("parent_notified");
      return Response.json({ ok: true });
    });
    const { handler, match } = getHandler("/sessions/parent-1/children");

    const response = await handler(spawnRequest(), env, match, createCtx());
    order.push("responded");

    expect(response.status).toBe(201);
    expect(order).toEqual(["parent_notified", "responded"]);
  });

  it("returns 201 and logs when the parent notification fails", async () => {
    const env = createEnv(async () => {
      throw new Error("parent DO unreachable");
    });
    const { handler, match } = getHandler("/sessions/parent-1/children");

    const response = await handler(spawnRequest(), env, match, createCtx());

    expect(response.status).toBe(201);
    expect(log.error).toHaveBeenCalledWith(
      "session.notify_parent_spawn.failed",
      expect.objectContaining({ parent_id: "parent-1" })
    );
  });

  it("returns 201 and logs when the parent notification returns non-ok", async () => {
    const env = createEnv(async () => new Response("nope", { status: 500 }));
    const { handler, match } = getHandler("/sessions/parent-1/children");

    const response = await handler(spawnRequest(), env, match, createCtx());

    expect(response.status).toBe(201);
    expect(log.error).toHaveBeenCalledWith(
      "session.notify_parent_spawn.failed",
      expect.objectContaining({ parent_id: "parent-1", http_status: 500 })
    );
  });
});
