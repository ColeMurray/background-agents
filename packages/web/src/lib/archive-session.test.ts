import { beforeEach, describe, expect, it, vi } from "vitest";
import { mutate } from "swr";
import type { Session } from "@open-inspect/shared";
import { archiveSession } from "./archive-session";
import { SIDEBAR_SESSIONS_KEY, type SessionListResponse } from "./session-list";

vi.mock("swr", () => ({
  mutate: vi.fn(),
}));

function createSession(id: string): Session {
  return {
    id,
    title: `Session ${id}`,
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
  };
}

describe("archiveSession", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(mutate).mockReset();
  });

  it("archives a session and removes it from the sidebar cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 }))
    );

    const didArchive = await archiveSession("session-1");

    expect(didArchive).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/sessions/session-1/archive", { method: "POST" });
    expect(mutate).toHaveBeenCalledTimes(1);

    const [key, updateCachedSessions, options] = vi.mocked(mutate).mock.calls[0]!;
    expect(key).toBe(SIDEBAR_SESSIONS_KEY);
    expect(options).toEqual({
      revalidate: false,
      populateCache: true,
    });

    const currentData: SessionListResponse = {
      sessions: [createSession("session-1"), createSession("session-2")],
      hasMore: false,
    };

    expect(
      (updateCachedSessions as (data?: SessionListResponse) => SessionListResponse | undefined)(
        currentData
      )
    ).toEqual({
      ...currentData,
      sessions: [createSession("session-2")],
    });
  });

  it("does not mutate sidebar cache when the archive request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 }))
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const didArchive = await archiveSession("session-1");

    expect(didArchive).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to archive session");
  });
});
