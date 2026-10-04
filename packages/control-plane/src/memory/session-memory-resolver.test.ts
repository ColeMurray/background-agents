import { describe, expect, it, vi } from "vitest";
import type { AuthorizedMemoryTarget } from "../authorization/memory-access";
import { SessionMemoryResolver, type SessionMemoryResolverDeps } from "./session-memory-resolver";

const target = {
  userId: "owner",
  repositories: [{ repoOwner: "acme", repoName: "api", repoId: 1 }],
  environmentId: "dev",
} as unknown as AuthorizedMemoryTarget;

function resolver(includePersonalMemories: boolean) {
  const deps = {
    preferences: { get: vi.fn(async () => ({ includePersonalMemories })) },
    records: {
      listCandidates: vi.fn<SessionMemoryResolverDeps["records"]["listCandidates"]>(async () => ({
        candidates: [],
        omittedCount: 3,
      })),
    },
  };
  return { deps, resolver: new SessionMemoryResolver(deps) };
}

describe("SessionMemoryResolver", () => {
  it("reads candidates from the target's partitions in priority order", async () => {
    const { resolver: subject, deps } = resolver(true);
    const manifest = await subject.resolve(target);
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
    const { resolver: subject, deps } = resolver(false);
    expect((await subject.resolve(target)).includePersonalMemories).toBe(false);
    expect(deps.preferences.get).toHaveBeenCalledWith("owner");
    deps.preferences.get.mockClear();
    expect((await subject.resolve(target, true)).personalOwnerUserId).toBe("owner");
    expect(deps.preferences.get).not.toHaveBeenCalled();
  });
});
