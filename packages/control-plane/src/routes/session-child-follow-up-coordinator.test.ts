import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore, type ChildAdmissionLease } from "../db/session-index";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { SessionRouteContext } from "./session-route";
import { coordinateChildFollowUp } from "./session-child-follow-up-coordinator";

vi.mock("../session/integration-settings-resolution", () => ({
  resolveSandboxSettings: vi.fn(),
}));

function routeContext(fetch: SessionRuntimeClient["fetch"]): SessionRouteContext {
  return {
    db: {} as SessionRouteContext["db"],
    metrics: {} as SessionRouteContext["metrics"],
    request_id: "request-id",
    trace_id: "trace-id",
    sessionRuntime: { fetch },
  };
}

const admissionLease: ChildAdmissionLease = {
  token: "lease-1",
  childSessionId: "child",
  expiresAt: Date.now() + 60_000,
};

function mockTerminalChildAdmission(options?: {
  status?: "completed" | "failed";
  maxConcurrentChildren?: number;
  lease?: ChildAdmissionLease | null;
}) {
  vi.spyOn(SessionIndexStore.prototype, "get")
    .mockResolvedValueOnce({
      id: "child",
      parentSessionId: "parent",
      status: options?.status ?? "completed",
    } as never)
    .mockResolvedValueOnce({
      id: "parent",
      repoOwner: "acme",
      repoName: "repo",
      environmentId: "env-1",
    } as never);
  const maxConcurrentChildren = options?.maxConcurrentChildren ?? 1;
  vi.mocked(resolveSandboxSettings).mockResolvedValue({
    maxConcurrentChildSessions: maxConcurrentChildren,
  });
  const reserve = vi
    .spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease")
    .mockResolvedValue(options?.lease === undefined ? admissionLease : options.lease);
  const release = vi
    .spyOn(SessionIndexStore.prototype, "releaseChildAdmissionLease")
    .mockResolvedValue();
  vi.spyOn(SessionIndexStore.prototype, "touchUpdatedAt").mockResolvedValue(true);
  return { reserve, release };
}

describe("coordinateChildFollowUp", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reserves terminal-child capacity until the child accepts the follow-up", async () => {
    const { reserve, release } = mockTerminalChildAdmission({ maxConcurrentChildren: 2 });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
      Response.json({ messageId: "message-1", status: "queued" })
    );

    const response = await coordinateChildFollowUp(
      { parentId: "parent", childId: "child", content: "Continue" },
      routeContext(fetch)
    );

    expect(response.status).toBe(200);
    expect(resolveSandboxSettings).toHaveBeenCalledWith(expect.anything(), "acme", "repo", "env-1");
    expect(reserve).toHaveBeenCalledWith("parent", "child", 2);
    expect(release).not.toHaveBeenCalled();
  });

  it("rejects a terminal-child resume when the parent has no capacity", async () => {
    mockTerminalChildAdmission({ status: "failed", lease: null });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>();

    const response = await coordinateChildFollowUp(
      { parentId: "parent", childId: "child", content: "Continue" },
      routeContext(fetch)
    );

    expect(response.status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("releases terminal-child capacity when the child rejects the follow-up", async () => {
    const { release } = mockTerminalChildAdmission();
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
      Response.json({ error: "Cannot prompt child" }, { status: 409 })
    );

    const response = await coordinateChildFollowUp(
      { parentId: "parent", childId: "child", content: "Continue" },
      routeContext(fetch)
    );

    expect(response.status).toBe(409);
    expect(release).toHaveBeenCalledWith(admissionLease);
  });

  it("releases terminal-child capacity when delivery fails", async () => {
    const { release } = mockTerminalChildAdmission();
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => {
      throw new Error("child unavailable");
    });

    await expect(
      coordinateChildFollowUp(
        { parentId: "parent", childId: "child", content: "Continue" },
        routeContext(fetch)
      )
    ).rejects.toThrow("child unavailable");
    expect(release).toHaveBeenCalledWith(admissionLease);
  });
});
