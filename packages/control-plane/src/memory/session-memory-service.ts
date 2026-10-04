import {
  memorySearchTerms,
  SANDBOX_MEMORY_SCHEMA_VERSION,
  type MemorySearchInput,
  type MemorySearchResponse,
  type RenderedSessionMemory,
  type SandboxMemoryReadResult,
  type SandboxMemoryWriteInput,
  type SandboxMemoryWriteResult,
} from "@open-inspect/shared/types/memories";
import type { SessionMemoryAccessPolicy } from "../authorization/memory-access";
import type { MemoryRecordStore } from "../db/memory-records";
import type { SessionMemorySelectionStore } from "../db/session-memory-selections";
import { MemoryAccessError, MemoryNotFoundError, MemoryValidationError } from "./errors";
import { factSearchResponse, type FactSearchIndex, type FactSearchPartition } from "./fact-search";
import { partitionScope, samePartition, type MemoryPartition } from "./partition";
import { renderMemorySection } from "./render";
import { canWritePersonal, personalReadAccess } from "./session-rules";
import { repositoryPartition, sourcePartitions } from "./sources";
import type { MemorySession } from "./types";

const SCOPE_UNAVAILABLE = "Memory scope is no longer available";
const OUTSIDE_SESSION = "Memory scope is outside this session";

/**
 * Dependencies injected into SessionMemoryService. Each is the narrowest slice the service uses,
 * so tests can substitute fakes and the service never constructs storage itself.
 */
export interface SessionMemoryServiceDeps {
  /**
   * What one session sees: the session itself (principal, targets, harness, auto-save
   * eligibility), its pinned selection, and whether a record is pinned in it.
   */
  selections: Pick<SessionMemorySelectionStore, "loadSession" | "load" | "isPinned">;
  /** The memory records themselves (content, revisions, lifecycle), independent of any session. */
  records: Pick<MemoryRecordStore, "get" | "create">;
  /** Ranked search over current active facts. */
  factIndex: FactSearchIndex;
  /** Whether the session principal may currently read shared partitions; rechecked per operation. */
  access: Pick<SessionMemoryAccessPolicy, "check">;
  /** Recorded as provenance on agent writes. */
  requestId: string;
}

/**
 * Agent-facing memory operations for one authenticated sandbox session. Identity and scope are
 * always derived from the session, never from request bodies; every operation rechecks the
 * session principal's current access to shared partitions. Throws `MemoryError`s.
 */
export class SessionMemoryService {
  private readonly selections: SessionMemoryServiceDeps["selections"];
  private readonly records: SessionMemoryServiceDeps["records"];
  private readonly factIndex: FactSearchIndex;
  private readonly access: SessionMemoryServiceDeps["access"];
  private readonly requestId: string;

  constructor(deps: SessionMemoryServiceDeps) {
    this.selections = deps.selections;
    this.records = deps.records;
    this.factIndex = deps.factIndex;
    this.access = deps.access;
    this.requestId = deps.requestId;
  }

  /** The pinned boot context, rendered for the session's harness. */
  async renderedContext(sessionId: string): Promise<RenderedSessionMemory> {
    const session = await this.loadSession(sessionId);
    const loaded = await this.selections.load(sessionId);
    if (!loaded) throw new MemoryNotFoundError("Session not found");
    if (
      !(await this.canRead(
        session,
        loaded.entries.map((entry) => entry.partition)
      ))
    )
      throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    return {
      schemaVersion: SANDBOX_MEMORY_SCHEMA_VERSION,
      manifestSha256: loaded.selection.manifestSha256,
      rendered: renderMemorySection(loaded.selection, loaded.entries, session.harness),
    };
  }

  /**
   * Expand an active fact in the session's target, or return a body-free notice for a pinned
   * record that was archived. Directives are never expandable. Proposals, unpinned archives,
   * opted-out personal records, and unpinned personal records in children are concealed.
   */
  async read(sessionId: string, memoryId: string): Promise<SandboxMemoryReadResult> {
    const session = await this.loadSession(sessionId);
    const [record, pinned] = await Promise.all([
      this.records.get(memoryId),
      this.selections.isPinned(sessionId, memoryId),
    ]);
    if (!record || record.status === "proposed") throw new MemoryNotFoundError();
    if (record.partition.type === "personal") {
      const access = personalReadAccess(session);
      if (access === "none" || (access === "pinned" && !pinned)) throw new MemoryNotFoundError();
    }
    if (record.status === "archived") {
      if (!pinned || !(await this.canRead(session, [record.partition])))
        throw new MemoryNotFoundError();
      return {
        id: record.id,
        status: "archived",
        // Archived rows always carry a kind (enforced by the table CHECK).
        archiveKind: record.archiveKind!,
        archivedAt: record.archivedAt,
        archiveNote: record.archiveNote,
      };
    }
    if (
      record.memoryType !== "fact" ||
      !sourcePartitions(session.sources).some((partition) =>
        samePartition(partition, record.partition)
      ) ||
      !(await this.canRead(session, [record.partition]))
    )
      throw new MemoryNotFoundError();
    return {
      id: record.id,
      status: "active",
      memoryType: "fact",
      scope: partitionScope(record.partition),
      title: record.title,
      description: record.description,
      content: record.content,
      revisionId: record.currentRevisionId,
      revisionNumber: record.revisionNumber,
      authorKind: record.authorKind,
      authorUserId: record.authorUserId,
      authorSessionId: record.authorSessionId,
    };
  }

  /**
   * Write relative to the session: the sole repository or the selected one, the session
   * environment, or the pinned personal owner. Shared-session personal writes become proposals
   * because credentials identify a session, not an immutable prompt author; the store rechecks
   * auto-save eligibility atomically.
   */
  async write(
    sessionId: string,
    input: SandboxMemoryWriteInput
  ): Promise<SandboxMemoryWriteResult> {
    const session = await this.loadSession(sessionId);
    const partition = this.writePartition(session, input);
    if (!(await this.canRead(session, [partition]))) throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    const memory = await this.records.create(
      {
        partition,
        content: {
          memoryType: input.memoryType,
          title: input.title,
          description: input.description,
          content: input.content,
        },
        supersedesMemoryId: input.supersedesMemoryId,
      },
      {
        kind: "agent",
        // Equal to the personal owner for personal writes (`canWritePersonal` holds).
        userId: session.principal.userId,
        sessionId,
        requestId: this.requestId,
      },
      { personalAutoSaveEligible: session.personalAutoSaveEligible }
    );
    return { id: memory.id, status: memory.status, revisionId: memory.currentRevisionId };
  }

  /** Search current facts in the session's partitions, checking access before and after SQL. */
  async search(sessionId: string, input: MemorySearchInput): Promise<MemorySearchResponse> {
    const session = await this.loadSession(sessionId);
    const partitions = this.searchPartitions(session, input);
    const all = partitions.map((entry) => entry.partition);
    if (!(await this.canRead(session, all))) throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    const hits = await this.factIndex.search({
      terms: memorySearchTerms(input.query),
      partitions,
      limit: input.limit,
    });
    if (!(await this.canRead(session, all))) throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    return factSearchResponse(hits, input.limit);
  }

  private async loadSession(sessionId: string): Promise<MemorySession> {
    const session = await this.selections.loadSession(sessionId);
    if (!session) throw new MemoryNotFoundError("Session not found");
    return session;
  }

  private async canRead(
    session: MemorySession,
    partitions: readonly MemoryPartition[]
  ): Promise<boolean> {
    const decision = await this.access.check(session.principal, partitions);
    return decision.kind === "granted";
  }

  /** Resolve a session-relative selector; multi-repository sessions must name the repository. */
  private selectRepositories(
    session: MemorySession,
    selector: { repoOwner?: string; repoName?: string }
  ) {
    return selector.repoOwner === undefined
      ? session.sources.repositories
      : session.sources.repositories.filter(
          (repo) =>
            repo.repoOwner.toLowerCase() === selector.repoOwner &&
            repo.repoName.toLowerCase() === selector.repoName
        );
  }

  private writePartition(session: MemorySession, input: SandboxMemoryWriteInput): MemoryPartition {
    switch (input.scopeType) {
      case "repository": {
        if (input.repoOwner === undefined && session.sources.repositories.length > 1)
          throw new MemoryValidationError(
            `This session spans multiple repositories — specify repoOwner and repoName (one of: ${session.sources.repositories.map((repo) => `${repo.repoOwner}/${repo.repoName}`).join(", ")})`
          );
        const [repo] = this.selectRepositories(session, input);
        if (!repo) throw new MemoryAccessError("Repository is outside this session");
        const partition = repositoryPartition(repo);
        if (!partition) throw new MemoryAccessError(OUTSIDE_SESSION);
        return partition;
      }
      case "environment":
        if (!session.sources.environmentId)
          throw new MemoryAccessError("This session has no associated environment");
        return { type: "environment", environmentId: session.sources.environmentId };
      case "personal":
        if (!session.sources.personalOwnerUserId) throw new MemoryAccessError(OUTSIDE_SESSION);
        // A collaborator-owned child consumes inherited context but cannot mutate the original
        // owner's personal store.
        if (!canWritePersonal(session))
          throw new MemoryAccessError("Personal memory owner differs from this session owner");
        return { type: "personal", userId: session.sources.personalOwnerUserId };
      default: {
        const exhaustive: never = input.scopeType;
        throw new Error(`Unhandled memory scope: ${String(exhaustive)}`);
      }
    }
  }

  /** Session-relative searchable partitions; an explicitly requested unavailable scope fails. */
  private searchPartitions(
    session: MemorySession,
    input: MemorySearchInput
  ): FactSearchPartition[] {
    const partitions: FactSearchPartition[] = [];
    const wants = (scopeType: NonNullable<MemorySearchInput["scopeType"]>) =>
      !input.scopeType || input.scopeType === scopeType;
    if (wants("personal")) {
      const access = personalReadAccess(session);
      if (access !== "none" && session.sources.personalOwnerUserId)
        partitions.push({
          partition: { type: "personal", userId: session.sources.personalOwnerUserId },
          ...(access === "pinned" ? { pinnedIn: session.id } : {}),
        });
      else if (input.scopeType)
        throw new MemoryAccessError("Personal memory is excluded from this session");
    }
    if (wants("repository")) {
      const repositories = this.selectRepositories(session, input);
      if (input.scopeType && !repositories.length)
        throw new MemoryAccessError("Repository is outside this session");
      for (const repo of repositories) {
        const partition = repositoryPartition(repo);
        if (!partition) throw new MemoryAccessError("Repository identity is unavailable");
        partitions.push({ partition });
      }
    }
    if (wants("environment")) {
      if (session.sources.environmentId)
        partitions.push({
          partition: { type: "environment", environmentId: session.sources.environmentId },
        });
      else if (input.scopeType)
        throw new MemoryAccessError("This session has no associated environment");
    }
    return partitions;
  }
}
