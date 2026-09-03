import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { encodeAuditEventCursor } from "../db/audit-event-cursor";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { auditEventRoutes, DEFAULT_AUDIT_EVENT_LIMIT } from "./audit-events";

const mockStore = { list: vi.fn() };
const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../db/audit-event-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AuditEventStore: vi.fn().mockImplementation(function () {
      return mockStore;
    }),
  };
});

const handleRequest = createTestRequestHandler([auditEventRoutes]);
const env = { ...TEST_SERVICE_SECRETS, DB: ownerAuthorizationDatabase() } as unknown as Env;

function list(query = ""): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local/audit-events${query}`),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("audit events route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    mockStore.list.mockResolvedValue({ rows: [], hasMore: false, nextCursor: null });
  });

  it("defaults the limit with no cursor", async () => {
    const response = await list();

    expect(response.status).toBe(200);
    expect(mockStore.list).toHaveBeenCalledWith({ limit: DEFAULT_AUDIT_EVENT_LIMIT, cursor: null });
    await expect(response.json()).resolves.toEqual({
      events: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("accepts the maximum limit", async () => {
    expect((await list("?limit=100")).status).toBe(200);
    expect(mockStore.list).toHaveBeenCalledWith({ limit: 100, cursor: null });
  });

  it("round-trips a cursor through the store and the next page", async () => {
    const cursor = { occurredAt: 1_700_000_000_000, id: "event-1" };
    const next = { occurredAt: 1_699_999_999_000, id: "event-2" };
    mockStore.list.mockResolvedValue({ rows: [], hasMore: true, nextCursor: next });

    const response = await list(`?limit=1&cursor=${encodeAuditEventCursor(cursor)}`);

    expect(response.status).toBe(200);
    expect(mockStore.list).toHaveBeenCalledWith({ limit: 1, cursor });
    await expect(response.json()).resolves.toMatchObject({
      hasMore: true,
      nextCursor: encodeAuditEventCursor(next),
    });
  });

  it.each(["0", "101", "1.5", "1e2", "+5", "-5", "abc", "", "01"])(
    "rejects limit=%s before reading the store",
    async (limit) => {
      const response = await list(`?limit=${limit}`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid limit" });
      expect(mockStore.list).not.toHaveBeenCalled();
    }
  );

  it.each(["", "not-a-cursor", "100:", ":event-1"])(
    "rejects cursor=%s before reading the store",
    async (cursor) => {
      const response = await list(`?cursor=${cursor}`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid cursor" });
      expect(mockStore.list).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["limit=1&limit=2", "Invalid limit"],
    ["cursor=one&cursor=two", "Invalid cursor"],
  ])("rejects a repeated key (%s)", async (query, message) => {
    const response = await list(`?${query}`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(mockStore.list).not.toHaveBeenCalled();
  });

  it("reports the limit before the cursor when both are invalid", async () => {
    const response = await list("?limit=0&cursor=bad");

    await expect(response.json()).resolves.toEqual({ error: "Invalid limit" });
  });
});
