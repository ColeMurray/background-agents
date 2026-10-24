// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { MemoryDto } from "@open-inspect/shared/types/memories";
import {
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
