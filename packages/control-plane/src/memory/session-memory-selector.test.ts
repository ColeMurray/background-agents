import { describe, expect, it, vi } from "vitest";
import type { MemoryPartition } from "./partition";
import {
  SessionMemorySelector,
  type SessionMemorySelectionRequest,
  type SessionMemorySelectorDeps,
} from "./session-memory-selector";

const request: SessionMemorySelectionRequest = {
  principal: { userId: "owner", ownerTeamId: "team" },
  repositories: [{ repoOwner: "acme", repoName: "api", repoId: 1 }],
  environmentId: "dev",
};

function selector(includePersonalMemories: boolean) {
  const deps = {
    preferences: { get: vi.fn(async () => ({ includePersonalMemories })) },
    records: {
      listCandidates: vi.fn<SessionMemorySelectorDeps["records"]["listCandidates"]>(async () => ({
        candidates: [],
        omittedCount: 3,
      })),
    },
    access: {
      check: vi.fn<SessionMemorySelectorDeps["access"]["check"]>(async () => ({
        kind: "granted",
      })),
    },
  };
  return { deps, selector: new SessionMemorySelector(deps) };
}

describe("SessionMemorySelector", () => {
  it("reads candidates from readable partitions in priority order", async () => {
    const { selector: subject, deps } = selector(true);
    const manifest = await subject.select(request);
    expect(deps.records.listCandidates).toHaveBeenCalledWith([
      { type: "environment", environmentId: "dev" },
      { type: "repository", repoOwner: "acme", repoName: "api", repoId: 1 },
      { type: "personal", userId: "owner" },
    ]);
    expect(manifest).toMatchObject({
      includePersonalMemories: true,
      personalOwnerUserId: "owner",
      truncatedCount: 3,
    });
  });

  it("applies the saved default unless the session overrides it", async () => {
    const { selector: subject, deps } = selector(false);
    expect((await subject.select(request)).includePersonalMemories).toBe(false);
    expect(deps.preferences.get).toHaveBeenCalledWith("owner");
    deps.preferences.get.mockClear();
    const included = await subject.select({ ...request, includePersonalMemories: true });
    expect(included.personalOwnerUserId).toBe("owner");
    expect(deps.preferences.get).not.toHaveBeenCalled();
  });

  it("omits unreadable or unidentified partitions instead of rejecting the session", async () => {
    const { selector: subject, deps } = selector(false);
    deps.access.check.mockImplementation(async (_principal, [partition]) =>
      partition.type === "repository" && partition.repoId === 1
        ? { kind: "granted" }
        : { kind: "denied", reason: "repository_ungranted" }
    );
    await subject.select({
      ...request,
      repositories: [
        { repoOwner: "acme", repoName: "api", repoId: 1 },
        { repoOwner: "acme", repoName: "web", repoId: 2 },
        { repoOwner: "acme", repoName: "legacy", repoId: null },
      ],
    });
    const api: MemoryPartition = {
      type: "repository",
      repoOwner: "acme",
      repoName: "api",
      repoId: 1,
    };
    expect(deps.records.listCandidates).toHaveBeenCalledWith([api]);
    expect(deps.access.check).toHaveBeenCalledWith(request.principal, [api]);
  });
});
