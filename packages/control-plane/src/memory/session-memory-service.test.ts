import { describe, expect, it, vi } from "vitest";
import { HARNESS_IDS } from "@open-inspect/shared/harnesses";
import { harnessMemoryToolName } from "@open-inspect/shared/memory-tools";
import type { SessionMemorySelection } from "./types";
import type { PinnedSelection } from "../db/session-memory-selections";
import { MemoryAccessError, MemoryNotFoundError, MemoryValidationError } from "./errors";
import type { MemoryPartition } from "./partition";
import { emptySelection } from "./selection";
import { SessionMemoryService, type SessionMemoryServiceDeps } from "./session-memory-service";
import type {
  MemoryPromptContext,
  MemoryRecord,
  MemorySession,
  MemorySources,
  PinnedMemoryEntry,
  SessionPrincipal,
} from "./types";

const api = { repoOwner: "acme", repoName: "api", repoId: 1 };
const web = { repoOwner: "acme", repoName: "web", repoId: 2 };
const apiPartition: MemoryPartition = { type: "repository", repoId: api.repoId };
const ownerPrompt: MemoryPromptContext = { authorUserId: "owner", othersPrompted: false };
const teammatePrompt: MemoryPromptContext = { authorUserId: "teammate", othersPrompted: true };
const afterTeammate: MemoryPromptContext = { authorUserId: "owner", othersPrompted: true };
const personalHit = {
  id: "mine",
  revisionId: "rev_mine",
  partition: { type: "personal", userId: "owner" },
  scope: { type: "personal" },
  title: "Test setup",
  description: "How to run the tests",
} as const;
const repositoryHit = {
  id: "api",
  revisionId: "rev_api",
  partition: apiPartition,
  scope: { type: "repository", repoOwner: "acme", repoName: "api" },
  title: "Deploys",
  description: "How to deploy",
} as const;

function memorySession(
  overrides: Partial<Omit<MemorySession, "principal" | "sources">> & {
    principal?: Partial<SessionPrincipal>;
    sources?: Partial<MemorySources>;
  } = {}
): MemorySession {
  const { principal, sources, ...rest } = overrides;
  return {
    id: "session",
    harness: "opencode",
    isChildSession: false,
    personalAutoSaveEligible: true,
    ...rest,
    principal: { userId: "owner", ownerTeamId: null, ...principal },
    sources: { personalOwnerUserId: "owner", repositories: [api], environmentId: null, ...sources },
  };
}

function record(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    partition: { type: "personal", userId: "owner" },
    scope: { type: "personal" },
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
    loaded?: PinnedSelection;
    readable?: boolean[];
    /** Successive prompt lookups; the last answer repeats. */
    prompts?: MemoryPromptContext[];
  } = {}
) {
  const records = new Map((options.records ?? []).map((memory) => [memory.id, memory]));
  const readable = [...(options.readable ?? [])];
  const prompts = [...(options.prompts ?? [ownerPrompt])];
  const deps = {
    selections: {
      loadSession: vi.fn(async () => options.session ?? memorySession()),
      loadSelection: vi.fn(async () => options.loaded ?? null),
      isPinned: vi.fn(async (_session: string, id: string) => !!options.pinned?.includes(id)),
    },
    records: {
      get: vi.fn(async (id: string) => records.get(id) ?? null),
      create: vi.fn<SessionMemoryServiceDeps["records"]["create"]>(async (input) =>
        record("created", { partition: input.partition, scope: input.scope, status: "proposed" })
      ),
    },
    factIndex: {
      search: vi.fn<SessionMemoryServiceDeps["factIndex"]["search"]>(async () => []),
    },
    access: {
      check: vi.fn<SessionMemoryServiceDeps["access"]["check"]>(async () =>
        (readable.shift() ?? true)
          ? ({ kind: "granted" } as const)
          : ({ kind: "denied", reason: "repository_ungranted" } as const)
      ),
    },
    prompts: {
      current: vi.fn(async () => (prompts.length > 1 ? prompts.shift()! : prompts[0])),
    },
    audit: {
      recordRead: vi.fn<SessionMemoryServiceDeps["audit"]["recordRead"]>(async () => {}),
    },
    requestId: "request",
  } satisfies SessionMemoryServiceDeps;
  return {
    deps,
    service: new SessionMemoryService(deps),
    /** Answer every later prompt lookup with `next`. */
    promptBy: (next: MemoryPromptContext) => prompts.splice(0, prompts.length, next),
  };
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
    await expect(service.write("session", { ...fact, scopeType: "repository" })).resolves.toEqual({
      id: "created",
      status: "proposed",
      revisionId: "rev_created",
    });
    expect(deps.records.create).toHaveBeenCalledWith(
      {
        partition: apiPartition,
        scope: { type: "repository", repoOwner: "acme", repoName: "api" },
        content: fact,
        supersedesMemoryId: undefined,
      },
      {
        kind: "agent",
        userId: "owner",
        sessionId: "session",
        requestId: "request",
      },
      // Only personal facts can skip review; a shared write never asks who is prompting.
      { personalAutoSaveEligible: false }
    );
    expect(deps.prompts.current).not.toHaveBeenCalled();
    expect(deps.access.check).toHaveBeenCalledWith({ userId: "owner", ownerTeamId: null }, [
      apiPartition,
    ]);
  });

  it("requires a selector in multi-repository sessions and never writes on rejection", async () => {
    const { service, deps } = setup({
      session: memorySession({ sources: { repositories: [api, web] } }),
    });
    await expect(service.write("session", { ...fact, scopeType: "repository" })).rejects.toThrow(
      MemoryValidationError
    );
    await expect(
      service.write("session", {
        ...fact,
        scopeType: "repository",
        repoOwner: "acme",
        repoName: "web",
      })
    ).resolves.toMatchObject({ id: "created" });
    expect(deps.records.create).toHaveBeenCalledTimes(1);
    expect(deps.records.create.mock.calls[0][0].partition).toEqual({
      type: "repository",
      repoId: web.repoId,
    });
  });

  it("keeps a collaborator-owned child out of the original owner's personal store", async () => {
    const { service, deps } = setup({
      session: memorySession({ isChildSession: true, principal: { userId: "collaborator" } }),
    });
    await expect(service.write("session", { ...fact, scopeType: "personal" })).rejects.toThrow(
      MemoryAccessError
    );
    expect(deps.records.create).not.toHaveBeenCalled();
  });

  it("writes personal memory only on the owner's own prompt", async () => {
    const { service, deps, promptBy } = setup();
    const personal = { ...fact, scopeType: "personal" as const };
    promptBy(teammatePrompt);
    await expect(service.write("session", personal)).rejects.toThrow(
      "Personal memory is available only on the session owner's own prompts"
    );
    promptBy({ authorUserId: null, othersPrompted: true });
    await expect(service.write("session", personal)).rejects.toThrow(MemoryAccessError);
    expect(deps.records.create).not.toHaveBeenCalled();

    promptBy(ownerPrompt);
    await service.write("session", personal);
    expect(deps.records.create).toHaveBeenCalledWith(
      expect.objectContaining({ partition: { type: "personal", userId: "owner" } }),
      expect.objectContaining({ kind: "agent", userId: "owner" }),
      { personalAutoSaveEligible: true }
    );
  });

  it("stops auto-saving the owner's personal facts once anyone else has prompted", async () => {
    const { service, deps } = setup({ prompts: [{ authorUserId: "owner", othersPrompted: true }] });
    await service.write("session", { ...fact, scopeType: "personal" });
    expect(deps.records.create.mock.calls[0][2]).toEqual({ personalAutoSaveEligible: false });
  });

  it("denies a write when the principal can no longer read the partition", async () => {
    const { service, deps } = setup({ readable: [false] });
    await expect(service.write("session", { ...fact, scopeType: "repository" })).rejects.toThrow(
      MemoryAccessError
    );
    expect(deps.records.create).not.toHaveBeenCalled();
  });

  it("checks the personal store before writing to it", async () => {
    const { service, deps } = setup({ readable: [false] });
    await expect(service.write("session", { ...fact, scopeType: "personal" })).rejects.toThrow(
      MemoryAccessError
    );
    expect(deps.access.check).toHaveBeenCalledWith({ userId: "owner", ownerTeamId: null }, [
      { type: "personal", userId: "owner" },
    ]);
    expect(deps.records.create).not.toHaveBeenCalled();
  });
});

describe("SessionMemoryService.read", () => {
  it("conceals personal records from opted-out sessions and unpinned ones from children", async () => {
    const records = [record("mine")];
    const optedOut = setup({
      records,
      session: memorySession({ sources: { personalOwnerUserId: null } }),
    });
    await expect(optedOut.service.read("session", "mine")).rejects.toThrow(MemoryNotFoundError);
    const child = setup({ records, session: memorySession({ isChildSession: true }) });
    await expect(child.service.read("session", "mine")).rejects.toThrow(MemoryNotFoundError);
    const pinnedChild = setup({
      records,
      pinned: ["mine"],
      session: memorySession({ isChildSession: true }),
    });
    await expect(pinnedChild.service.read("session", "mine")).resolves.toMatchObject({
      status: "active",
      content: "Start the database",
    });
  });

  it("reads personal memory only on the owner's prompt and audits what it returns", async () => {
    const repository = record("api", {
      partition: apiPartition,
      scope: { type: "repository", repoOwner: "acme", repoName: "api" },
    });
    const records = [record("mine"), repository];
    const teammate = setup({ records, prompts: [teammatePrompt] });
    await expect(teammate.service.read("session", "mine")).rejects.toThrow(MemoryNotFoundError);
    await expect(teammate.service.read("session", "api")).resolves.toMatchObject({
      id: "api",
    });
    expect(teammate.deps.audit.recordRead).not.toHaveBeenCalled();

    const owner = setup({ records });
    await expect(owner.service.read("session", "mine")).resolves.toMatchObject({
      content: "Start the database",
    });
    expect(owner.deps.audit.recordRead).toHaveBeenCalledWith({
      requestId: "request",
      sessionId: "session",
      promptAuthorUserId: "owner",
      ownerUserId: "owner",
      memoryIds: ["mine"],
    });
  });

  it("conceals a personal record when the owner opts out while it is being read", async () => {
    const { service, deps } = setup({ records: [record("mine")] });
    // Once the preference is off, loading the session drops its personal owner.
    deps.selections.loadSession
      .mockResolvedValueOnce(memorySession())
      .mockResolvedValueOnce(memorySession({ sources: { personalOwnerUserId: null } }));
    await expect(service.read("session", "mine")).rejects.toThrow(MemoryNotFoundError);
    expect(deps.selections.loadSession).toHaveBeenCalledTimes(2);
    expect(deps.audit.recordRead).not.toHaveBeenCalled();
  });

  it("never asks the session runtime when personal memory is not involved", async () => {
    const repository = record("api", {
      partition: apiPartition,
      scope: { type: "repository", repoOwner: "acme", repoName: "api" },
    });
    const { service, deps } = setup({ records: [repository] });
    deps.prompts.current.mockRejectedValue(new Error("Session runtime unavailable"));
    await expect(service.read("session", "api")).resolves.toMatchObject({ id: "api" });
    await expect(
      service.search("session", { query: "needle", limit: 10, scopeType: "repository" })
    ).resolves.toEqual({ results: [], hasMore: false });
    await expect(
      service.write("session", { ...fact, scopeType: "repository" })
    ).resolves.toMatchObject({ id: "created" });

    const excluded = setup({ session: memorySession({ sources: { personalOwnerUserId: null } }) });
    await excluded.service.search("session", { query: "needle", limit: 10 });
    expect(deps.prompts.current).not.toHaveBeenCalled();
    expect(excluded.deps.prompts.current).not.toHaveBeenCalled();
  });

  it("conceals a personal record when someone else prompts while it is being read", async () => {
    const { service, deps } = setup({
      records: [record("mine")],
      prompts: [ownerPrompt, afterTeammate],
    });
    await expect(service.read("session", "mine")).rejects.toThrow(MemoryNotFoundError);
    expect(deps.audit.recordRead).not.toHaveBeenCalled();
  });

  it("audits an archived personal record's notice like any personal read", async () => {
    const archived = record("old", {
      status: "archived",
      archiveKind: "manual",
      archivedAt: 5,
      archiveNote: "No longer true",
    });
    const { service, deps } = setup({ records: [archived], pinned: ["old"] });
    await expect(service.read("session", "old")).resolves.toMatchObject({ status: "archived" });
    expect(deps.audit.recordRead).toHaveBeenCalledWith(
      expect.objectContaining({ memoryIds: ["old"] })
    );
  });

  it("returns a body-free notice only for pinned archived records", async () => {
    const archived = record("old", {
      status: "archived",
      archiveKind: "manual",
      archivedAt: 5,
      archiveNote: "Outdated",
    });
    await expect(setup({ records: [archived] }).service.read("session", "old")).rejects.toThrow(
      MemoryNotFoundError
    );
    await expect(
      setup({ records: [archived], pinned: ["old"] }).service.read("session", "old")
    ).resolves.toEqual({
      id: "old",
      status: "archived",
      archiveKind: "manual",
      archivedAt: 5,
      archiveNote: "Outdated",
    });
  });

  it("never expands directives or records outside the session's partitions", async () => {
    const other: MemoryPartition = { type: "repository", repoId: web.repoId };
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
    const { service, deps } = setup({ session: memorySession({ isChildSession: true }) });
    await service.search("session", { query: "needle", limit: 10 });
    expect(deps.factIndex.search).toHaveBeenCalledWith({
      terms: ["needle"],
      limit: 10,
      partitions: [
        { partition: { type: "personal", userId: "owner" }, pinnedIn: "session" },
        { partition: apiPartition },
      ],
    });
  });

  it("searches personal memory only on the owner's prompt", async () => {
    const { service, deps } = setup({ prompts: [teammatePrompt] });
    await service.search("session", { query: "needle", limit: 10 });
    expect(deps.factIndex.search).toHaveBeenCalledWith(
      expect.objectContaining({ partitions: [{ partition: apiPartition }] })
    );
    await expect(
      service.search("session", { query: "needle", limit: 10, scopeType: "personal" })
    ).rejects.toThrow("Personal memory is available only on the session owner's own prompts");
  });

  it("stops reading personal memory on the owner's prompts once anyone else has prompted", async () => {
    const records = [record("mine")];
    const { service, deps } = setup({ records, prompts: [afterTeammate] });
    await expect(service.read("session", "mine")).rejects.toThrow(MemoryNotFoundError);
    await expect(
      service.search("session", { query: "needle", limit: 10, scopeType: "personal" })
    ).rejects.toThrow("someone else has prompted it");
    expect(deps.audit.recordRead).not.toHaveBeenCalled();
  });

  it("audits the personal records a search returns", async () => {
    const { service, deps } = setup();
    deps.factIndex.search.mockResolvedValue([personalHit, repositoryHit]);
    await service.search("session", { query: "needle", limit: 10 });
    expect(deps.audit.recordRead).toHaveBeenCalledWith(
      expect.objectContaining({ promptAuthorUserId: "owner", memoryIds: ["mine"] })
    );
  });

  it("withholds personal hits when the owner opts out while the query runs", async () => {
    const { service, deps } = setup();
    // Once the preference is off, loading the session drops its personal owner.
    deps.selections.loadSession
      .mockResolvedValueOnce(memorySession())
      .mockResolvedValueOnce(memorySession({ sources: { personalOwnerUserId: null } }));
    deps.factIndex.search.mockResolvedValue([personalHit, repositoryHit]);
    const response = await service.search("session", { query: "needle", limit: 10 });
    expect(response.results.map((result) => result.id)).toEqual(["api"]);
    expect(deps.selections.loadSession).toHaveBeenCalledTimes(2);
    expect(deps.audit.recordRead).not.toHaveBeenCalled();
  });

  it("drops personal hits when someone else prompts while the query runs", async () => {
    const { service, deps } = setup({ prompts: [ownerPrompt, afterTeammate] });
    deps.factIndex.search.mockResolvedValue([personalHit, repositoryHit]);
    const response = await service.search("session", { query: "needle", limit: 10 });
    expect(response.results.map((result) => result.id)).toEqual(["api"]);
    expect(deps.audit.recordRead).not.toHaveBeenCalled();
  });

  it("discards results when access is revoked while the query runs", async () => {
    // Personal store check, then access before and after the query.
    const { service, deps } = setup({ readable: [true, true, false] });
    await expect(service.search("session", { query: "needle", limit: 10 })).rejects.toThrow(
      MemoryAccessError
    );
    expect(deps.factIndex.search).toHaveBeenCalledTimes(1);
  });

  it("skips a personal store its owner may not use, and refuses it when requested", async () => {
    const { service, deps } = setup();
    deps.access.check.mockImplementation(async (_principal, partitions) =>
      partitions.some((partition) => partition.type === "personal")
        ? { kind: "denied", reason: "personal_unavailable" }
        : { kind: "granted" }
    );
    await service.search("session", { query: "needle", limit: 10 });
    expect(deps.factIndex.search).toHaveBeenCalledWith({
      terms: ["needle"],
      limit: 10,
      partitions: [{ partition: apiPartition }],
    });
    await expect(
      service.search("session", { query: "needle", limit: 10, scopeType: "personal" })
    ).rejects.toThrow("Memory scope is no longer available");
  });
});

describe("SessionMemoryService.renderedContext", () => {
  const manifest: SessionMemorySelection = {
    selectionVersion: 1,
    manifestSha256: "hash",
    resolvedAt: 1,
    personalOwnerUserId: "owner",
    directiveChars: 0,
    catalogChars: 10,
    estimatedTokens: 1,
    omittedCount: 0,
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
  const loaded = { selection: manifest, drift: [], entries: [entry] };

  it("renders the pinned selection for the session's harness", async () => {
    const { service } = setup({ loaded, session: memorySession({ harness: "claude" }) });
    const rendered = await service.renderedContext("session");
    expect(rendered).toMatchObject({ schemaVersion: 1, manifestSha256: "hash" });
    expect(rendered.rendered).toContain("mcp__oi__memory_read");
  });

  it.each(HARNESS_IDS)("supplies %s boot guidance without pinned memories", async (harness) => {
    const selection = await emptySelection(1);
    const { service } = setup({
      loaded: { selection, drift: [], entries: [] },
      session: memorySession({ harness }),
    });
    const rendered = await service.renderedContext("session");
    expect(rendered).toMatchObject({ schemaVersion: 1, manifestSha256: selection.manifestSha256 });
    expect(rendered.rendered).toContain(harnessMemoryToolName(harness, "memory_write"));
  });

  it("keeps pinned personal records after the owner opts out", async () => {
    const { service, deps } = setup({
      loaded,
      session: memorySession({ sources: { personalOwnerUserId: null } }),
    });
    expect((await service.renderedContext("session")).rendered).toContain("Test setup");
    expect(deps.access.check).toHaveBeenCalledWith({ userId: "owner", ownerTeamId: null }, [
      { type: "personal", userId: "owner" },
    ]);
  });

  it("refuses to install when the principal lost access to a pinned partition", async () => {
    // The personal store is still usable; the full check fails.
    const { service } = setup({ loaded, readable: [true, false] });
    await expect(service.renderedContext("session")).rejects.toThrow(MemoryAccessError);
  });

  it("leaves personal records out while their owner may not use personal memory", async () => {
    const deploy: PinnedMemoryEntry = {
      memoryId: "deploy",
      revisionId: "rev_deploy",
      scope: { type: "repository", repoOwner: "acme", repoName: "api" },
      partition: apiPartition,
      title: "Deploy runbook",
      inclusion: "summary",
      description: "How to deploy",
    };
    const { service, deps } = setup({
      loaded: {
        selection: {
          ...manifest,
          items: [
            ...manifest.items,
            {
              ...manifest.items[0],
              memoryId: "deploy",
              revisionId: "rev_deploy",
              scope: deploy.scope,
              title: deploy.title,
            },
          ],
        },
        drift: [],
        entries: [entry, deploy],
      },
    });
    deps.access.check.mockImplementation(async (_principal, partitions) =>
      partitions.some((partition) => partition.type === "personal")
        ? { kind: "denied", reason: "personal_unavailable" }
        : { kind: "granted" }
    );
    const { rendered } = await service.renderedContext("session");
    expect(rendered).toContain("Deploy runbook");
    expect(rendered).not.toContain("Test setup");
  });
});
