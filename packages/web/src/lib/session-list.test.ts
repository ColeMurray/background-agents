import { describe, expect, it } from "vitest";
import {
  applyTitleUpdate,
  buildSessionsPageKey,
  isArchivedSessionListKey,
  isSessionListKey,
  isUnarchivedSessionListKey,
  type SessionListResponse,
} from "./session-list";
import type { Session } from "@open-inspect/shared";

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
  it("adds a Mine scope", () => {
    expect(buildSessionsPageKey({ excludeStatus: "archived", scope: "mine" })).toBe(
      "/api/sessions?limit=50&offset=0&excludeStatus=archived&scope=mine"
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
  it("replaces the title and updatedAt of the matching session", () => {
    const before: SessionListResponse = {
      sessions: [session("a"), session("b"), session("c")],
      hasMore: false,
    };

    const after = applyTitleUpdate(before, "b", "Renamed", 9999);

    expect(after?.sessions).toEqual([
      session("a"),
      session("b", { title: "Renamed", updatedAt: 9999 }),
      session("c"),
    ]);
  });

  it("preserves hasMore and other top-level fields", () => {
    const before: SessionListResponse = {
      sessions: [session("a")],
      hasMore: true,
    };

    const after = applyTitleUpdate(before, "a", "New", 1);

    expect(after?.hasMore).toBe(true);
  });

  it("returns undefined when data is undefined (cache miss)", () => {
    expect(applyTitleUpdate(undefined, "a", "New", 1)).toBeUndefined();
  });

  it("leaves the list unchanged when sessionId does not match", () => {
    const before: SessionListResponse = {
      sessions: [session("a"), session("b")],
      hasMore: false,
    };

    const after = applyTitleUpdate(before, "missing", "New", 9999);

    expect(after?.sessions).toEqual(before.sessions);
  });

  it("does not mutate the input object", () => {
    const before: SessionListResponse = {
      sessions: [session("a")],
      hasMore: false,
    };
    const beforeSnapshot = JSON.parse(JSON.stringify(before));

    applyTitleUpdate(before, "a", "Mutated", 9999);

    expect(before).toEqual(beforeSnapshot);
  });
});
