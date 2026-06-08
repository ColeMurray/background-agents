import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionIndexRoutes } from "./session-index";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const mockSessionIndexStore = {
  list: vi.fn(),
  delete: vi.fn(),
};

vi.mock("../db/session-index", () => ({
  SessionIndexStore: vi.fn().mockImplementation(function () {
    return mockSessionIndexStore;
  }),
}));

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function createEnv(): Env {
  return {
    DB: {} as D1Database,
  } as Env;
}

function getHandler(method: string, path: string) {
  for (const route of sessionIndexRoutes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) return { handler: route.handler, match };
  }
  throw new Error(`No route found for ${method} ${path}`);
}

async function listSessions(query = ""): Promise<Response> {
  const { handler, match } = getHandler("GET", "/sessions");
  return handler(
    new Request(`https://test.local/sessions${query}`),
    createEnv(),
    match,
    createCtx()
  );
}

describe("session index routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionIndexStore.list.mockResolvedValue({
      sessions: [],
      total: 0,
      hasMore: false,
    });
  });

  it("defaults invalid pagination values before querying the store", async () => {
    const response = await listSessions("?limit=abc&offset=nope");

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith({
      status: undefined,
      excludeStatus: undefined,
      createdByUserIds: [],
      limit: 50,
      offset: 0,
    });
  });

  it("clamps pagination values before querying the store", async () => {
    const response = await listSessions("?limit=500&offset=-10");

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith({
      status: undefined,
      excludeStatus: undefined,
      createdByUserIds: [],
      limit: 100,
      offset: 0,
    });
  });

  it("passes validated creator filters through to the store", async () => {
    const response = await listSessions(
      "?createdBy=0123456789abcdef0123456789abcdef&createdBy=0123456789abcdef0123456789abcdef"
    );

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith({
      status: undefined,
      excludeStatus: undefined,
      createdByUserIds: ["0123456789abcdef0123456789abcdef"],
      limit: 50,
      offset: 0,
    });
  });

  it("rejects invalid creator filters before querying the store", async () => {
    const response = await listSessions("?createdBy=me");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid createdBy" });
    expect(mockSessionIndexStore.list).not.toHaveBeenCalled();
  });
});
