import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ controlPlaneUserFetch: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("./control-plane", () => ({ controlPlaneUserFetch: mocks.controlPlaneUserFetch }));

import { getSessionSnapshot, SessionSnapshotError } from "./session-snapshot";

const snapshot = {
  session: {
    id: "session/one",
    title: "Session",
    repoOwner: "group/subgroup",
    repoName: "repo",
    baseBranch: "main",
    branchName: "feature",
    status: "active",
    sandboxStatus: "ready",
    messageCount: 1,
    createdAt: 1,
  },
  artifacts: [],
  timeline: { events: [], hasMore: false, cursor: null },
  promptQueue: [],
};

describe("getSessionSnapshot", () => {
  beforeEach(() => vi.resetAllMocks());

  it("fetches the uncached canonical session resource and validates it", async () => {
    mocks.controlPlaneUserFetch.mockResolvedValue(Response.json(snapshot));

    await expect(getSessionSnapshot("session/one")).resolves.toEqual(snapshot);
    expect(mocks.controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session%2Fone",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("preserves the upstream status for route-level handling", async () => {
    mocks.controlPlaneUserFetch.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(getSessionSnapshot("missing")).rejects.toEqual(new SessionSnapshotError(404));
  });

  it("rejects a malformed snapshot", async () => {
    mocks.controlPlaneUserFetch.mockResolvedValue(Response.json({ artifacts: [] }));
    await expect(getSessionSnapshot("session/one")).rejects.toThrow();
  });
});
