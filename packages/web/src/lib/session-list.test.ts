import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTitleUpdate,
  buildSessionSearchValue,
  buildSessionsPageKey,
  CURRENT_USER_CREATED_BY,
  fetchSessionListPage,
  isArchivedSessionListKey,
  isSessionListKey,
  isUnarchivedSessionListKey,
  type SessionListResponse,
} from "./session-list";
import type { Session } from "@open-inspect/shared/types/sessions";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id.toUpperCase(),
    repoOwner: "open-inspect",
    repoName: "background-agents",
    baseBranch: "main",
    branchName: null,
    baseSha: null,
    currentSha: null,
    opencodeSessionId: null,
    status: "active",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe("buildSessionsPageKey", () => {
  it("adds the current-user creator filter", () => {
    expect(
      buildSessionsPageKey({
        excludeStatus: "archived",
        excludeAutomationLineage: true,
        createdBy: [CURRENT_USER_CREATED_BY],
      })
    ).toBe(
      "/api/sessions?limit=50&offset=0&excludeStatus=archived&excludeAutomationLineage=true&createdBy=me"
    );
  });

  it("adds repeated creator filters", () => {
    expect(
      buildSessionsPageKey({
        excludeStatus: "archived",
        createdBy: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      })
    ).toBe(
      "/api/sessions?limit=50&offset=0&excludeStatus=archived&createdBy=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&createdBy=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
  });
});

describe("fetchSessionListPage", () => {
  it("parses the session-list boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          sessions: [session("session-1")],
          hasMore: false,
        })
      )
    );

    await expect(fetchSessionListPage(buildSessionsPageKey())).resolves.toMatchObject({
      sessions: [{ id: "session-1", status: "active" }],
      hasMore: false,
    });
  });

  it("rejects malformed pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ sessions: [{ id: "session-1" }], hasMore: false }))
    );

    await expect(fetchSessionListPage(buildSessionsPageKey())).rejects.toThrow();
  });
});

describe("buildSessionSearchValue", () => {
  it("includes every repository attached to a multi-repository session", () => {
    const value = buildSessionSearchValue(
      session("multi", {
        title: "Update services",
        repositories: [
          {
            repoOwner: "open-inspect",
            repoName: "background-agents",
            repoId: 1,
            baseBranch: "main",
          },
          { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "main" },
        ],
      })
    );

    expect(value).toContain("Update services");
    expect(value).toContain("open-inspect/background-agents");
    expect(value).toContain("acme/api");
  });

  it("falls back to the scalar repository fields", () => {
    expect(buildSessionSearchValue(session("legacy"))).toContain("open-inspect/background-agents");
  });
});

describe("isSessionListKey", () => {
  it("matches all session list cache keys", () => {
    expect(isSessionListKey("/api/sessions")).toBe(true);
    expect(isSessionListKey("/api/sessions?limit=50&offset=0")).toBe(true);
  });

  it("ignores other cache keys", () => {
    expect(isSessionListKey("/api/sessions/session-1")).toBe(false);
    expect(isSessionListKey(["/api/sessions"])).toBe(false);
  });
});

describe("isUnarchivedSessionListKey", () => {
  it("matches active session list variants", () => {
    expect(isUnarchivedSessionListKey("/api/sessions")).toBe(true);
    expect(isUnarchivedSessionListKey("/api/sessions?excludeStatus=archived")).toBe(true);
    expect(isUnarchivedSessionListKey("/api/sessions?status=active")).toBe(true);
  });

  it("ignores archived session lists", () => {
    expect(isUnarchivedSessionListKey("/api/sessions?status=archived&limit=20")).toBe(false);
  });
});

describe("isArchivedSessionListKey", () => {
  it("matches archived session lists", () => {
    expect(isArchivedSessionListKey("/api/sessions?status=archived")).toBe(true);
    expect(isArchivedSessionListKey("/api/sessions?status=archived&limit=20")).toBe(true);
  });

  it("ignores unarchived session lists", () => {
    expect(isArchivedSessionListKey("/api/sessions")).toBe(false);
    expect(isArchivedSessionListKey("/api/sessions?excludeStatus=archived")).toBe(false);
    expect(isArchivedSessionListKey("/api/sessions?status=active")).toBe(false);
  });
});

describe("applyTitleUpdate", () => {
  it("replaces only the title of the matching session", () => {
    const before: SessionListResponse = {
      sessions: [session("a"), session("b"), session("c")],
      hasMore: false,
    };

    const after = applyTitleUpdate(before, "b", "Renamed");

    expect(after?.sessions).toEqual([
      session("a"),
      session("b", { title: "Renamed" }),
      session("c"),
    ]);
  });

  it("preserves hasMore and other top-level fields", () => {
    const before: SessionListResponse = {
      sessions: [session("a")],
      hasMore: true,
    };

    const after = applyTitleUpdate(before, "a", "New");

    expect(after?.hasMore).toBe(true);
  });

  it("returns undefined when data is undefined (cache miss)", () => {
    expect(applyTitleUpdate(undefined, "a", "New")).toBeUndefined();
  });

  it("leaves the list unchanged when sessionId does not match", () => {
    const before: SessionListResponse = {
      sessions: [session("a"), session("b")],
      hasMore: false,
    };

    const after = applyTitleUpdate(before, "missing", "New");

    expect(after?.sessions).toEqual(before.sessions);
  });

  it("does not mutate the input object", () => {
    const before: SessionListResponse = {
      sessions: [session("a")],
      hasMore: false,
    };
    const beforeSnapshot = structuredClone(before);

    applyTitleUpdate(before, "a", "Mutated");

    expect(before).toEqual(beforeSnapshot);
  });
});
