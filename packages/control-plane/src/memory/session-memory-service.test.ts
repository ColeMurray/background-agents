import { describe, expect, it, vi } from "vitest";
import type { SessionMemoryManifest } from "@open-inspect/shared/types/memories";
import type { LoadedSessionMemory } from "../db/session-memory-selections";
import { MemoryAccessError, MemoryNotFoundError, MemoryValidationError } from "./errors";
import type { MemoryPartition } from "./partition";
import { SessionMemoryService, type SessionMemoryServiceDeps } from "./session-memory-service";
import type {
  MemoryRecord,
  MemorySession,
  MemoryTarget,
  PinnedMemoryEntry,
  SessionPrincipal,
} from "./types";

const api = { repoOwner: "acme", repoName: "api", repoId: 1 };
const web = { repoOwner: "acme", repoName: "web", repoId: 2 };

function memorySession(
  overrides: Partial<Omit<MemorySession, "principal" | "target">> & {
    principal?: Partial<SessionPrincipal>;
    target?: Partial<MemoryTarget>;
  } = {}
): MemorySession {
  const { principal, target, ...rest } = overrides;
  return {
    id: "session",
    harness: "opencode",
    inherited: false,
    personalAutoSave: true,
    ...rest,
    principal: { userId: "owner", ownerTeamId: null, ...principal },
    target: { personalOwnerUserId: "owner", repositories: [api], environmentId: null, ...target },
  };
}

function record(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    partition: { type: "personal", userId: "owner" },
    memoryType: "fact",
    title: "Test setup",
    description: "How to run the tests",
    content: "Start the database",
    status: "active",
    archiveKind: null,
    archiveNote: null,
    currentRevisionId: `rev_${id}`,
    revisionNumber: 1,
    authorKind: "user",
    authorUserId: "owner",
    authorSessionId: null,
    supersedesMemoryId: null,
    approvedAt: 1,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** A service wired to in-memory fakes; `readable` toggles shared-partition access per check. */
function setup(
  options: {
    session?: MemorySession;
    records?: MemoryRecord[];
    pinned?: string[];
    loaded?: LoadedSessionMemory;
    readable?: boolean[];
  } = {}
) {
  const records = new Map((options.records ?? []).map((memory) => [memory.id, memory]));
  const readable = [...(options.readable ?? [])];
  const deps = {
    selections: {
      loadSession: vi.fn(async () => options.session ?? memorySession()),
      load: vi.fn(async () => options.loaded ?? null),
      isPinned: vi.fn(async (_session: string, id: string) => !!options.pinned?.includes(id)),
    },
    records: {
      get: vi.fn(async (id: string) => records.get(id) ?? null),
      create: vi.fn<SessionMemoryServiceDeps["records"]["create"]>(async (input) =>
        record("created", { partition: input.partition, status: "proposed" })
      ),
    },
    factIndex: {
      search: vi.fn<SessionMemoryServiceDeps["factIndex"]["search"]>(async () => []),
    },
    access: {
      check: vi.fn(async () =>
        (readable.shift() ?? true)
          ? ({ kind: "granted" } as const)
          : ({ kind: "denied", reason: "repository_ungranted" } as const)
      ),
    },
    requestId: "request",
  } satisfies SessionMemoryServiceDeps;
  return { deps, service: new SessionMemoryService(deps) };
}

const fact = {
  memoryType: "fact" as const,
  title: "Test setup",
  description: "How to run the tests",
  content: "Start the database",
};

describe("SessionMemoryService.write", () => {
  it("infers the sole repository and derives provenance from the session", async () => {
    const { service, deps } = setup();
    await expect(service.write("session", { ...fact, scope: "repository" })).resolves.toEqual({
      id: "created",
      status: "proposed",
      revisionId: "rev_created",
    });
    expect(deps.records.create).toHaveBeenCalledWith(
      {
        partition: { type: "repository", ...api },
        content: fact,
        supersedesMemoryId: undefined,
      },
      {
        kind: "agent",
        userId: "owner",
        sessionId: "session",
        requestId: "request",
        personalAutoSave: true,
      }
    );
    expect(deps.access.check).toHaveBeenCalledWith({ userId: "owner", ownerTeamId: null }, [
      { type: "repository", ...api },
    ]);
  });

  it("requires a selector in multi-repository sessions and never writes on rejection", async () => {
    const { service, deps } = setup({
      session: memorySession({ target: { repositories: [api, web] } }),
    });
    await expect(service.write("session", { ...fact, scope: "repository" })).rejects.toThrow(
      MemoryValidationError
    );
    await expect(
      service.write("session", { ...fact, scope: "repository", repoOwner: "acme", repoName: "web" })
    ).resolves.toMatchObject({ id: "created" });
    expect(deps.records.create).toHaveBeenCalledTimes(1);
    expect(deps.records.create.mock.calls[0][0].partition).toEqual({ type: "repository", ...web });
  });

  it("keeps a collaborator-owned child out of the original owner's personal store", async () => {
    const { service, deps } = setup({
      session: memorySession({ inherited: true, principal: { userId: "collaborator" } }),
    });
    await expect(service.write("session", { ...fact, scope: "personal" })).rejects.toThrow(
      MemoryAccessError
    );
    expect(deps.records.create).not.toHaveBeenCalled();
  });

  it("denies a write when the principal can no longer read the partition", async () => {
    const { service, deps } = setup({ readable: [false] });
    await expect(service.write("session", { ...fact, scope: "repository" })).rejects.toThrow(
      MemoryAccessError
    );
    expect(deps.records.create).not.toHaveBeenCalled();
  });
});

describe("SessionMemoryService.read", () => {
  it("conceals personal records from opted-out sessions and unpinned ones from children", async () => {
    const records = [record("mine")];
    const optedOut = setup({
      records,
      session: memorySession({ target: { personalOwnerUserId: null } }),
    });
    await expect(optedOut.service.read("session", "mine")).rejects.toThrow(MemoryNotFoundError);
    const child = setup({ records, session: memorySession({ inherited: true }) });
    await expect(child.service.read("session", "mine")).rejects.toThrow(MemoryNotFoundError);
    const pinnedChild = setup({
      records,
      pinned: ["mine"],
      session: memorySession({ inherited: true }),
    });
    await expect(pinnedChild.service.read("session", "mine")).resolves.toMatchObject({
      status: "active",
      content: "Start the database",
    });
  });

  it("returns a body-free notice only for pinned archived records", async () => {
    const archived = record("old", { status: "archived", archivedAt: 5, archiveNote: "Outdated" });
    await expect(setup({ records: [archived] }).service.read("session", "old")).rejects.toThrow(
      MemoryNotFoundError
    );
    await expect(
      setup({ records: [archived], pinned: ["old"] }).service.read("session", "old")
    ).resolves.toEqual({ id: "old", status: "archived", archivedAt: 5, reason: "Outdated" });
  });

  it("never expands directives or records outside the session's partitions", async () => {
    const other: MemoryPartition = { type: "repository", ...web };
    const { service } = setup({
      records: [
        record("directive", { memoryType: "directive" }),
        record("web", { partition: other }),
      ],
    });
    await expect(service.read("session", "directive")).rejects.toThrow(MemoryNotFoundError);
    await expect(service.read("session", "web")).rejects.toThrow(MemoryNotFoundError);
  });
});

describe("SessionMemoryService.search", () => {
  it("restricts a child's personal search to pinned records", async () => {
    const { service, deps } = setup({ session: memorySession({ inherited: true }) });
    await service.search("session", { query: "needle", limit: 10 });
    expect(deps.factIndex.search).toHaveBeenCalledWith({
      terms: ["needle"],
      limit: 10,
      partitions: [
        { partition: { type: "personal", userId: "owner" }, pinnedIn: "session" },
        { partition: { type: "repository", ...api } },
      ],
    });
  });

  it("discards results when access is revoked while the query runs", async () => {
    const { service, deps } = setup({ readable: [true, false] });
    await expect(service.search("session", { query: "needle", limit: 10 })).rejects.toThrow(
      MemoryAccessError
    );
    expect(deps.factIndex.search).toHaveBeenCalledTimes(1);
  });
});

describe("SessionMemoryService.installation", () => {
  const manifest: SessionMemoryManifest = {
    selectionVersion: 1,
    manifestSha256: "hash",
    resolvedAt: 1,
    includePersonalMemories: true,
    personalOwnerUserId: "owner",
    directiveChars: 0,
    catalogChars: 10,
    estimatedTokens: 1,
    truncatedCount: 0,
    items: [
      {
        memoryId: "mine",
        revisionId: "rev_mine",
        revisionNumber: 1,
        scope: { type: "personal" },
        memoryType: "fact",
        title: "Test setup",
        inclusion: "summary",
        estimatedTokens: 1,
      },
    ],
  };
  const entry: PinnedMemoryEntry = {
    memoryId: "mine",
    revisionId: "rev_mine",
    scope: { type: "personal" },
    partition: { type: "personal", userId: "owner" },
    title: "Test setup",
    inclusion: "summary",
    description: "How to run the tests",
  };
  const loaded = { manifest, diagnostics: { ...manifest, items: [] }, entries: [entry] };

  it("renders the pinned selection for the session's harness", async () => {
    const { service } = setup({ loaded, session: memorySession({ harness: "claude" }) });
    const installation = await service.installation("session");
    expect(installation).toMatchObject({ schemaVersion: 1, manifestSha256: "hash" });
    expect(installation.rendered).toContain("mcp__oi__memory_read");
  });

  it("refuses to install when the principal lost access to a pinned partition", async () => {
    const { service } = setup({ loaded, readable: [false] });
    await expect(service.installation("session")).rejects.toThrow(MemoryAccessError);
  });
});
