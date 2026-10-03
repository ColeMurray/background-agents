import {
  SANDBOX_MEMORY_SCHEMA_VERSION,
  type MemorySearchInput,
  type MemorySearchResponse,
  type SandboxMemoryInstallation,
  type SandboxMemoryReadResult,
  type SandboxMemoryWriteInput,
  type SandboxMemoryWriteResult,
} from "@open-inspect/shared/types/memories";
import { SharedMemoryAccess } from "../authorization/memory-access";
import { MemoryStore } from "../db/memories";
import { searchMemories, type SearchPartition } from "../db/memory-search";
import { SessionMemoryStore } from "../db/session-memories";
import type { RequestContext } from "../http/request-context";
import { MemoryAccessError, MemoryNotFoundError, MemoryValidationError } from "./errors";
import { partitionScope, samePartition, type MemoryPartition } from "./partition";
import { renderMemorySection } from "./render";
import {
  canWritePersonal,
  personalReadAccess,
  repositoryPartition,
  targetPartitions,
} from "./target";
import type { SessionMemoryContext } from "./types";

const SCOPE_UNAVAILABLE = "Memory scope is no longer available";
const OUTSIDE_SESSION = "Memory scope is outside this session";

/**
 * Agent-facing memory operations for one authenticated sandbox session. Identity and scope are
 * always derived from the session, never from request bodies; every operation rechecks the
 * session principal's current access to shared partitions. Throws `MemoryError`s.
 */
export class SessionMemoryService {
  private readonly sessions: SessionMemoryStore;
  private readonly memories: MemoryStore;

  constructor(private readonly ctx: RequestContext) {
    this.sessions = new SessionMemoryStore(ctx.db);
    this.memories = new MemoryStore(ctx.db);
  }

  /** The pinned boot context, rendered for the session's harness. */
  async installation(sessionId: string): Promise<SandboxMemoryInstallation> {
    const context = await this.context(sessionId);
    const loaded = await this.sessions.load(sessionId);
    if (!loaded) throw new MemoryNotFoundError("Session not found");
    if (
      !(await this.canRead(
        context,
        loaded.entries.map((entry) => entry.partition)
      ))
    )
      throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    return {
      schemaVersion: SANDBOX_MEMORY_SCHEMA_VERSION,
      manifestSha256: loaded.manifest.manifestSha256,
      rendered: renderMemorySection(loaded.manifest, loaded.entries, context.harness),
    };
  }

  /**
   * Expand an active fact in the session's target, or return a body-free notice for a pinned
   * record that was archived. Directives are never expandable. Proposals, unpinned archives,
   * opted-out personal records, and unpinned personal records in children are concealed.
   */
  async read(sessionId: string, memoryId: string): Promise<SandboxMemoryReadResult> {
    const context = await this.context(sessionId);
    const [record, pinned] = await Promise.all([
      this.memories.get(memoryId),
      this.sessions.isPinned(sessionId, memoryId),
    ]);
    if (!record || record.status === "proposed") throw new MemoryNotFoundError();
    if (record.partition.type === "personal") {
      const access = personalReadAccess(context);
      if (access === "none" || (access === "pinned" && !pinned)) throw new MemoryNotFoundError();
    }
    if (record.status === "archived") {
      if (!pinned || !(await this.canRead(context, [record.partition])))
        throw new MemoryNotFoundError();
      return {
        id: record.id,
        status: "archived",
        archivedAt: record.archivedAt,
        reason: record.archiveNote,
      };
    }
    if (
      record.memoryType !== "fact" ||
      !targetPartitions(context).some((partition) => samePartition(partition, record.partition)) ||
      !(await this.canRead(context, [record.partition]))
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
    const context = await this.context(sessionId);
    const partition = this.writePartition(context, input);
    if (!(await this.canRead(context, [partition]))) throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    const memory = await this.memories.create(
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
        userId: partition.type === "personal" ? partition.userId : context.sessionUserId,
        sessionId,
        requestId: this.ctx.request_id,
        personalAutoSave: context.personalAutoSave,
      }
    );
    return { id: memory.id, status: memory.status, revisionId: memory.currentRevisionId };
  }

  /** Search current facts in the session's partitions, checking access before and after SQL. */
  async search(sessionId: string, input: MemorySearchInput): Promise<MemorySearchResponse> {
    const context = await this.context(sessionId);
    const partitions = this.searchPartitions(context, input);
    const all = partitions.map((entry) => entry.partition);
    if (!(await this.canRead(context, all))) throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    const result = await searchMemories(this.ctx.db, input, partitions);
    if (!(await this.canRead(context, all))) throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    return result;
  }

  private async context(sessionId: string): Promise<SessionMemoryContext> {
    const context = await this.sessions.context(sessionId);
    if (!context) throw new MemoryNotFoundError("Session not found");
    return context;
  }

  private async canRead(
    context: SessionMemoryContext,
    partitions: readonly MemoryPartition[]
  ): Promise<boolean> {
    const access = await SharedMemoryAccess.load(this.ctx, {
      userId: context.sessionUserId,
      ownerTeamId: context.ownerTeamId,
    });
    return access.canRead(partitions);
  }

  /** Resolve a session-relative selector; multi-repository sessions must name the repository. */
  private selectRepositories(
    context: SessionMemoryContext,
    selector: { repoOwner?: string; repoName?: string }
  ) {
    return selector.repoOwner === undefined
      ? context.repositories
      : context.repositories.filter(
          (repo) =>
            repo.repoOwner.toLowerCase() === selector.repoOwner &&
            repo.repoName.toLowerCase() === selector.repoName
        );
  }

  private writePartition(
    context: SessionMemoryContext,
    input: SandboxMemoryWriteInput
  ): MemoryPartition {
    switch (input.scope) {
      case "repository": {
        if (input.repoOwner === undefined && context.repositories.length > 1)
          throw new MemoryValidationError(
            `This session spans multiple repositories — specify repoOwner and repoName (one of: ${context.repositories.map((repo) => `${repo.repoOwner}/${repo.repoName}`).join(", ")})`
          );
        const [repo] = this.selectRepositories(context, input);
        if (!repo) throw new MemoryAccessError("Repository is outside this session");
        const partition = repositoryPartition(repo);
        if (!partition) throw new MemoryAccessError(OUTSIDE_SESSION);
        return partition;
      }
      case "environment":
        if (!context.environmentId)
          throw new MemoryAccessError("This session has no associated environment");
        return { type: "environment", environmentId: context.environmentId };
      case "personal":
        if (!context.personalOwnerUserId) throw new MemoryAccessError(OUTSIDE_SESSION);
        // A collaborator-owned child consumes inherited context but cannot mutate the original
        // owner's personal store.
        if (!canWritePersonal(context))
          throw new MemoryAccessError("Personal memory owner differs from this session owner");
        return { type: "personal", userId: context.personalOwnerUserId };
      default: {
        const exhaustive: never = input.scope;
        throw new Error(`Unhandled memory scope: ${String(exhaustive)}`);
      }
    }
  }

  /** Session-relative searchable partitions; an explicitly requested unavailable scope fails. */
  private searchPartitions(
    context: SessionMemoryContext,
    input: MemorySearchInput
  ): SearchPartition[] {
    const partitions: SearchPartition[] = [];
    const wants = (scope: NonNullable<MemorySearchInput["scope"]>) =>
      !input.scope || input.scope === scope;
    if (wants("personal")) {
      const access = personalReadAccess(context);
      if (access !== "none" && context.personalOwnerUserId)
        partitions.push({
          partition: { type: "personal", userId: context.personalOwnerUserId },
          ...(access === "pinned" ? { pinnedSessionId: context.sessionId } : {}),
        });
      else if (input.scope)
        throw new MemoryAccessError("Personal memory is excluded from this session");
    }
    if (wants("repository")) {
      const repositories = this.selectRepositories(context, input);
      if (input.scope && !repositories.length)
        throw new MemoryAccessError("Repository is outside this session");
      for (const repo of repositories) {
        const partition = repositoryPartition(repo);
        if (!partition) throw new MemoryAccessError("Repository identity is unavailable");
        partitions.push({ partition });
      }
    }
    if (wants("environment")) {
      if (context.environmentId)
        partitions.push({
          partition: { type: "environment", environmentId: context.environmentId },
        });
      else if (input.scope)
        throw new MemoryAccessError("This session has no associated environment");
    }
    return partitions;
  }
}
