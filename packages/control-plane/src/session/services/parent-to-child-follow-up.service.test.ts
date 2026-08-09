import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildAdmissionLease } from "../../db/session-index";
import {
  ParentToChildFollowUpService,
  type ParentToChildFollowUpError,
  type ParentToChildFollowUpServiceDeps,
} from "./parent-to-child-follow-up.service";

const admissionLease: ChildAdmissionLease = {
  token: "lease-1",
  childSessionId: "child",
  expiresAt: Date.now() + 60_000,
};

function createService() {
  const sessionIndex = {
    get: vi.fn(),
    acquireChildAdmissionLease: vi.fn(),
    releaseChildAdmissionLease: vi.fn(),
    touchUpdatedAt: vi.fn(async () => true),
  } as unknown as ParentToChildFollowUpServiceDeps["sessionIndex"];
  const sessionRuntime = {
    fetch: vi.fn(),
  } as unknown as ParentToChildFollowUpServiceDeps["sessionRuntime"];
  const loadParentSandboxSettings = vi.fn(async () => ({
    maxConcurrentChildSessions: 1,
  }));
  const defer = vi.fn();
  const service = new ParentToChildFollowUpService({
    sessionIndex,
    sessionRuntime,
    loadParentSandboxSettings,
    defer,
    correlation: { request_id: "request-id", trace_id: "trace-id" },
  });
  return { service, sessionIndex, sessionRuntime, loadParentSandboxSettings, defer };
}

function mockTerminalChild(
  sessionIndex: ParentToChildFollowUpServiceDeps["sessionIndex"],
  options?: { status?: "completed" | "failed"; lease?: ChildAdmissionLease | null }
) {
  vi.mocked(sessionIndex.get)
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
  vi.mocked(sessionIndex.acquireChildAdmissionLease).mockResolvedValue(
    options?.lease === undefined ? admissionLease : options.lease
  );
}

const followUp = {
  parentSessionId: "parent",
  childSessionId: "child",
  content: "Continue",
};

describe("ParentToChildFollowUpService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reserves terminal-child capacity until the child accepts the follow-up", async () => {
    const { service, sessionIndex, sessionRuntime, loadParentSandboxSettings } = createService();
    mockTerminalChild(sessionIndex);
    vi.mocked(sessionRuntime.fetch).mockResolvedValue(
      Response.json({ messageId: "message-1", status: "queued" })
    );

    await expect(service.enqueue(followUp)).resolves.toEqual({
      messageId: "message-1",
      status: "queued",
    });
    expect(loadParentSandboxSettings).toHaveBeenCalledWith(
      expect.objectContaining({ id: "parent" })
    );
    expect(sessionIndex.acquireChildAdmissionLease).toHaveBeenCalledWith("parent", "child", 1);
    expect(sessionIndex.releaseChildAdmissionLease).not.toHaveBeenCalled();
  });

  it("rejects a terminal-child resume when the parent has no capacity", async () => {
    const { service, sessionIndex, sessionRuntime } = createService();
    mockTerminalChild(sessionIndex, { status: "failed", lease: null });

    await expect(service.enqueue(followUp)).rejects.toMatchObject({
      reason: "capacity_exhausted",
      message: "Maximum concurrent children (1) reached",
    } satisfies Partial<ParentToChildFollowUpError>);
    expect(sessionRuntime.fetch).not.toHaveBeenCalled();
  });

  it("releases terminal-child capacity when the child rejects the follow-up", async () => {
    const { service, sessionIndex, sessionRuntime } = createService();
    mockTerminalChild(sessionIndex);
    vi.mocked(sessionRuntime.fetch).mockResolvedValue(
      Response.json({ error: "Cannot prompt child" }, { status: 409 })
    );

    await expect(service.enqueue(followUp)).rejects.toMatchObject({
      reason: "session_not_promptable",
      message: "Cannot prompt child",
    } satisfies Partial<ParentToChildFollowUpError>);
    expect(sessionIndex.releaseChildAdmissionLease).toHaveBeenCalledWith(admissionLease);
  });

  it("releases terminal-child capacity when delivery fails", async () => {
    const { service, sessionIndex, sessionRuntime } = createService();
    mockTerminalChild(sessionIndex);
    vi.mocked(sessionRuntime.fetch).mockRejectedValue(new Error("child unavailable"));

    await expect(service.enqueue(followUp)).rejects.toThrow("child unavailable");
    expect(sessionIndex.releaseChildAdmissionLease).toHaveBeenCalledWith(admissionLease);
  });
});
