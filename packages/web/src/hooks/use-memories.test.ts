// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { MemoryDto } from "@open-inspect/shared/types/memories";
import {
  applyBulkMemoryAction,
  applyMemoryAction,
  createMemory,
  reviseMemory,
  setMemoryPreferences,
  useMemories,
} from "./use-memories";

const { fetchMock, swrMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), swrMock: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: fetchMock }));
vi.mock("swr", () => ({ default: swrMock }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "owner" } }, status: "authenticated" }),
}));

const record: MemoryDto = {
  id: "mem/a",
  scope: { type: "personal" },
  memoryType: "fact",
  status: "active",
  title: "Tests need Docker",
  description: "Start Docker before tests",
  content: "Run docker compose up",
  currentRevisionId: "rev_a",
  revisionNumber: 1,
  authorKind: "user",
  authorUserId: "owner",
  authorSessionId: null,
  supersedesMemoryId: null,
  supersededByMemoryIds: [],
  approvedAt: 1,
  archivedAt: null,
  archiveKind: null,
  archiveNote: null,
  createdAt: 1,
  updatedAt: 1,
  capabilities: { canEdit: true, actions: ["archive"] },
};

function lastRequest(): { path: string; init: RequestInit; body: unknown } {
  const [path, init] = fetchMock.mock.lastCall as [string, RequestInit];
  return { path, init, body: JSON.parse(String(init.body)) };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ memory: record }));
  swrMock.mockReset();
  swrMock.mockReturnValue({});
});

it("requests and caches all shared memories with status, search, and pagination", () => {
  renderHook(() => useMemories("shared", "proposed", 50, "docker tests"));
  expect(swrMock).toHaveBeenLastCalledWith(
    "/api/memories?scope=shared&status=proposed&offset=50&limit=50&search=docker+tests",
    expect.any(Function)
  );
});

describe("memory mutations", () => {
  it("creates a record from content, scope, and an optional predecessor only", async () => {
    await createMemory({
      scope: { type: "personal" },
      memoryType: "fact",
      title: "Tests need Docker",
      description: "Start Docker before tests",
      content: "Run docker compose up",
      supersedesMemoryId: undefined,
    });
    const { path, init, body } = lastRequest();
    expect(path).toBe("/api/memories");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(body).toEqual({
      scope: { type: "personal" },
      memoryType: "fact",
      title: "Tests need Docker",
      description: "Start Docker before tests",
      content: "Run docker compose up",
    });
  });

  it("fences revisions on the reviewed revision and sends content fields only", async () => {
    await expect(reviseMemory(record, record)).resolves.toEqual(record);
    const { path, init, body } = lastRequest();
    expect(path).toBe("/api/memories/mem%2Fa");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "If-Match": "rev_a" });
    expect(body).toEqual({
      memoryType: "fact",
      title: "Tests need Docker",
      description: "Start Docker before tests",
      content: "Run docker compose up",
    });
  });

  it.each([
    [undefined, {}],
    ["   ", {}],
    [" Outdated ", { archiveNote: "Outdated" }],
  ])("fences lifecycle actions and sends note %j as %j", async (note, expected) => {
    await applyMemoryAction(record, "archive", note);
    const { path, init, body } = lastRequest();
    expect(path).toBe("/api/memories/mem%2Fa/archive");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "If-Match": "rev_a" });
    expect(body).toEqual(expected);
  });

  it("sends each reviewed revision in one bulk request and returns per-record results", async () => {
    const results = [
      { id: "mem/a", ok: true, memory: record },
      { id: "mem_b", ok: false, error: "Memory changed; reload before acting" },
    ];
    fetchMock.mockImplementation(async () => Response.json({ results }));
    const other = { id: "mem_b", currentRevisionId: "rev_b" };
    await expect(applyBulkMemoryAction([record, other], "reject", " Duplicate ")).resolves.toEqual(
      results
    );
    expect(lastRequest()).toMatchObject({
      path: "/api/memories/bulk",
      init: { method: "POST", headers: { "Content-Type": "application/json" } },
      body: {
        action: "reject",
        memories: [
          { id: "mem/a", revisionId: "rev_a" },
          { id: "mem_b", revisionId: "rev_b" },
        ],
        archiveNote: "Duplicate",
      },
    });
    await applyBulkMemoryAction([record], "approve", "Ignored");
    expect(lastRequest().body).toEqual({
      action: "approve",
      memories: [{ id: "mem/a", revisionId: "rev_a" }],
    });
  });

  it("saves preferences", async () => {
    fetchMock.mockResolvedValue(Response.json({ includePersonalMemories: true }));
    await expect(setMemoryPreferences({ includePersonalMemories: true })).resolves.toEqual({
      includePersonalMemories: true,
    });
    expect(lastRequest()).toMatchObject({
      path: "/api/memory-preferences",
      init: { method: "PUT" },
      body: { includePersonalMemories: true },
    });
  });

  it.each([
    [Response.json({ error: "Revision mismatch" }, { status: 409 }), "Revision mismatch"],
    [new Response("<html>Bad gateway</html>", { status: 502 }), "Memory request failed"],
  ])("surfaces the server error message, or a generic fallback", async (response, message) => {
    fetchMock.mockResolvedValue(response);
    await expect(applyMemoryAction(record, "approve")).rejects.toThrow(message);
  });
});
