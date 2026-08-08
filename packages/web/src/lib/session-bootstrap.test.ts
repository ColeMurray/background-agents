import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ controlPlaneUserFetch: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("./control-plane", () => ({ controlPlaneUserFetch: mocks.controlPlaneUserFetch }));

import { getSessionBootstrap, SessionBootstrapError } from "./session-bootstrap";

const bootstrap = {
  sessionId: "session/one",
  state: {
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
  replay: { events: [], hasMore: false, cursor: null },
};

describe("getSessionBootstrap", () => {
  beforeEach(() => vi.resetAllMocks());

  it("fetches an uncached bootstrap and validates the shared contract", async () => {
    mocks.controlPlaneUserFetch.mockResolvedValue(Response.json(bootstrap));

    await expect(getSessionBootstrap("session/one")).resolves.toEqual(bootstrap);
    expect(mocks.controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session%2Fone/bootstrap",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("preserves the upstream status for route-level handling", async () => {
    mocks.controlPlaneUserFetch.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(getSessionBootstrap("missing")).rejects.toEqual(new SessionBootstrapError(404));
  });

  it("rejects a snapshot for a different session", async () => {
    mocks.controlPlaneUserFetch.mockResolvedValue(
      Response.json({ ...bootstrap, sessionId: "session/two" })
    );
    await expect(getSessionBootstrap("session/one")).rejects.toThrow();
  });
});
