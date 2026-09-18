import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionSearchValue,
  buildSessionsPageKey,
  CURRENT_USER_CREATED_BY,
  fetchSessionListPage,
  isArchivedSessionListKey,
  isSessionListKey,
  isUnarchivedSessionListKey,
} from "./session-list";
import type { SessionListSummary } from "@open-inspect/shared/types/sessions";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function session(id: string, overrides: Partial<SessionListSummary> = {}): SessionListSummary {
  return {
    id,
    title: id.toUpperCase(),
    repoOwner: "open-inspect",
    repoName: "background-agents",
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: "main",
    status: "active",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    automationId: null,
    automationRunId: null,
    scmLogin: null,
    userId: null,
    totalCost: 0,
    activeDurationMs: 0,
    messageCount: 0,
    prCount: 0,
    environmentId: null,
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
          sessions: [
            {
              ...session("session-1"),
              readState: { latestMessageId: "message-1", unread: true },
            },
          ],
          hasMore: false,
        })
      )
    );

    const page = await fetchSessionListPage(buildSessionsPageKey());

    expect(page).toMatchObject({
      sessions: [{ id: "session-1", status: "active" }],
      hasMore: false,
    });
    expect(page).toMatchObject({
      sessions: [{ readState: { version: 0 } }],
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
