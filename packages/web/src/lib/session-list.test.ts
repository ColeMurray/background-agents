import { describe, expect, it } from "vitest";

import {
  buildSessionsPageKey,
  mergeUniqueSessions,
  SESSIONS_PAGE_SIZE,
  SIDEBAR_SESSIONS_KEY,
} from "./session-list";
import type { Session } from "@open-inspect/shared";

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Session ${id}`,
    status: "running",
    repoOwner: "acme",
    repoName: "app",
    branch: "main",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: undefined,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  } as Session;
}

describe("SESSIONS_PAGE_SIZE", () => {
  it("is 50", () => {
    expect(SESSIONS_PAGE_SIZE).toBe(50);
  });
});

describe("SIDEBAR_SESSIONS_KEY", () => {
  it("is the pre-built key excluding archived sessions", () => {
    expect(SIDEBAR_SESSIONS_KEY).toContain("excludeStatus=archived");
    expect(SIDEBAR_SESSIONS_KEY).toContain(`limit=${SESSIONS_PAGE_SIZE}`);
    expect(SIDEBAR_SESSIONS_KEY).toContain("offset=0");
  });
});

describe("buildSessionsPageKey", () => {
  it("builds a key with default limit and offset", () => {
    const key = buildSessionsPageKey({});
    expect(key).toBe(`/api/sessions?limit=${SESSIONS_PAGE_SIZE}&offset=0`);
  });

  it("builds a key with custom limit and offset", () => {
    const key = buildSessionsPageKey({ limit: 10, offset: 20 });
    expect(key).toBe("/api/sessions?limit=10&offset=20");
  });

  it("includes status when provided", () => {
    const key = buildSessionsPageKey({ status: "running" });
    expect(key).toContain("status=running");
  });

  it("includes excludeStatus when provided", () => {
    const key = buildSessionsPageKey({ excludeStatus: "archived" });
    expect(key).toContain("excludeStatus=archived");
  });

  it("omits status when not provided", () => {
    const key = buildSessionsPageKey({});
    expect(key).not.toContain("status=");
  });

  it("includes both status and excludeStatus when both are provided", () => {
    const key = buildSessionsPageKey({ status: "running", excludeStatus: "archived" });
    expect(key).toContain("status=running");
    expect(key).toContain("excludeStatus=archived");
  });
});

describe("mergeUniqueSessions", () => {
  it("returns incoming sessions appended to existing", () => {
    const existing = [makeSession("1"), makeSession("2")];
    const incoming = [makeSession("3"), makeSession("4")];
    const result = mergeUniqueSessions(existing, incoming);
    expect(result.map((s) => s.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("deduplicates sessions already in existing", () => {
    const existing = [makeSession("1"), makeSession("2")];
    const incoming = [makeSession("2"), makeSession("3")];
    const result = mergeUniqueSessions(existing, incoming);
    expect(result.map((s) => s.id)).toEqual(["1", "2", "3"]);
  });

  it("returns existing unchanged when incoming is empty", () => {
    const existing = [makeSession("1")];
    const result = mergeUniqueSessions(existing, []);
    expect(result).toEqual(existing);
  });

  it("returns incoming when existing is empty", () => {
    const incoming = [makeSession("a"), makeSession("b")];
    const result = mergeUniqueSessions([], incoming);
    expect(result.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("returns empty array when both are empty", () => {
    expect(mergeUniqueSessions([], [])).toEqual([]);
  });
});
