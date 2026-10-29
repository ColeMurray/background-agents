import {
  memorySearchTerms,
  SANDBOX_MEMORY_SCHEMA_VERSION,
  type MemoryScope,
  type MemorySearchInput,
  type MemorySearchResponse,
  type RenderedSessionMemory,
  type SandboxMemoryReadResult,
  type SandboxMemoryWriteInput,
  type SandboxMemoryWriteResult,
} from "@open-inspect/shared/types/memories";
import type { SessionMemoryAccessPolicy } from "../authorization/memory-access";
import type { PersonalMemoryAuditStore } from "../db/personal-memory-audit";
import type { MemoryRecordStore } from "../db/memory-records";
import type { SessionMemorySelectionStore } from "../db/session-memory-selections";
import { MemoryAccessError, MemoryNotFoundError, MemoryValidationError, unhandled } from "./errors";
import { factSearchResponse, type FactSearchIndex, type FactSearchPartition } from "./fact-search";
import { samePartition, type MemoryPartition } from "./partition";
import { renderMemorySection } from "./render";
import {
  personalReadAccess,
  personalReadDenial,
  personalWriteDenial,
  UNATTRIBUTED_PROMPT,
} from "./session-rules";
import { repositoryPartition, sourcePartitions } from "./sources";
import type { MemoryPromptContext, MemorySession } from "./types";

const SCOPE_UNAVAILABLE = "Memory scope is no longer available";
const OUTSIDE_SESSION = "Memory scope is outside this session";
const REPOSITORY_OUTSIDE_SESSION = "Repository is outside this session";
const NO_ENVIRONMENT = "This session has no associated environment";
const SESSION_NOT_FOUND = "Session not found";

/** Whether the active prompt may read a personal record, pinned in the session or not. */
function personalReadable(
  session: MemorySession,
  prompt: MemoryPromptContext,
  pinned: boolean
): boolean {
  const access = personalReadAccess(session, prompt);
  return access === "all" || (access === "pinned" && pinned);
}

/**
 * Dependencies injected into SessionMemoryService. Each is the narrowest slice the service uses,
 * so tests can substitute fakes and the service never constructs storage itself.
 */
export interface SessionMemoryServiceDeps {
  /**
   * What one session sees: the session itself (principal, memory sources, harness, auto-save
   * eligibility), its pinned selection, and whether a record is pinned in it.
   */
  selections: Pick<SessionMemorySelectionStore, "loadSession" | "loadSelection" | "isPinned">;
  /** The memory records themselves (content, revisions, lifecycle), independent of any session. */
  records: Pick<MemoryRecordStore, "get" | "create">;
  /** Ranked search over current active facts. */
  factIndex: FactSearchIndex;
  /** Whether the session principal may currently use a partition; rechecked per operation. */
  access: Pick<SessionMemoryAccessPolicy, "check">;
  /**
   * Who the session's agent is serving, from the session runtime. Asked only when personal memory
   * is involved, and again, with the session, before personal records are returned. It answers
   * `UNATTRIBUTED_PROMPT` rather than failing.
   */
  prompts: { current(sessionId: string): Promise<MemoryPromptContext> };
  /** Records each read that returns personal memory, with the prompt it served. */
  audit: Pick<PersonalMemoryAuditStore, "recordRead">;
  /** Recorded as provenance on agent writes and personal-read audits. */
  requestId: string;
}

/**
 * Agent-facing memory operations for one authenticated sandbox session. Identity and scope are
 * always derived from the session, never from request bodies; every operation rechecks the
 * session principal's current access to the partitions involved. Personal memory additionally
 * depends on the prompt being processed, rechecked before personal records leave. Throws
 * `MemoryError`s.
 */
export class SessionMemoryService {
  constructor(private readonly deps: SessionMemoryServiceDeps) {}

  /**
   * The pinned boot context, rendered for the session's harness. Pinned personal records are left
   * out while their owner may not use personal memory; an opt-out leaves them in.
   */
  async renderedContext(sessionId: string): Promise<RenderedSessionMemory> {
    const session = await this.loadSession(sessionId);
    const loaded = await this.deps.selections.loadSelection(sessionId);
    if (!loaded) throw new MemoryNotFoundError(SESSION_NOT_FOUND);
    const personal = loaded.entries.find((entry) => entry.partition.type === "personal");
    const includePersonal =
      !personal || (await this.mayAccessPartitions(session, [personal.partition]));
    const entries = includePersonal
      ? loaded.entries
      : loaded.entries.filter((entry) => entry.partition.type !== "personal");
    if (
      !(await this.mayAccessPartitions(
        session,
        entries.map((entry) => entry.partition)
      ))
    )
      throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    const selection = includePersonal
      ? loaded.selection
      : {
          ...loaded.selection,
          items: loaded.selection.items.filter((item) => item.scope.type !== "personal"),
        };
    return {
      schemaVersion: SANDBOX_MEMORY_SCHEMA_VERSION,
      manifestSha256: loaded.selection.manifestSha256,
      rendered: renderMemorySection(selection, entries, session.harness),
    };
  }

  /**
   * Expand an active fact in the session's sources, or return a body-free notice for a pinned
   * record that was archived. Directives are never expandable. Proposals, unpinned archives,
   * personal records the active prompt may not read, and unpinned personal records in children are
   * concealed.
   */
  async read(sessionId: string, memoryId: string): Promise<SandboxMemoryReadResult> {
    const [session, record, pinned] = await Promise.all([
      this.loadSession(sessionId),
      this.deps.records.get(memoryId),
      this.deps.selections.isPinned(sessionId, memoryId),
    ]);
    if (!record || record.status === "proposed") throw new MemoryNotFoundError();
    const personal = record.partition.type === "personal";
    if (personal && !personalReadable(session, await this.promptFor(session), pinned))
      throw new MemoryNotFoundError();
    if (record.status === "archived") {
      if (!pinned || !(await this.mayAccessPartitions(session, [record.partition])))
        throw new MemoryNotFoundError();
      if (personal) await this.releasePersonal(sessionId, pinned, record.id);
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
      !(await this.mayAccessPartitions(session, [record.partition]))
    )
      throw new MemoryNotFoundError();
    if (personal) await this.releasePersonal(sessionId, pinned, record.id);
    return {
      id: record.id,
      status: "active",
      memoryType: "fact",
      scope: record.scope,
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
   * environment, or the pinned personal owner. Personal writes need the owner's own prompt, and
   * become proposals once anyone else has prompted the session.
   */
  async write(
    sessionId: string,
    input: SandboxMemoryWriteInput
  ): Promise<SandboxMemoryWriteResult> {
    const session = await this.loadSession(sessionId);
    const prompt =
      input.scopeType === "personal" ? await this.promptFor(session) : UNATTRIBUTED_PROMPT;
    const { partition, scope } = this.writeTarget(session, input, prompt);
    if (!(await this.mayAccessPartitions(session, [partition])))
      throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    const memory = await this.deps.records.create(
      {
        partition,
        scope,
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
        // Equal to the personal owner for personal writes (`personalWriteDenial` holds).
        userId: session.principal.userId,
        sessionId,
        requestId: this.deps.requestId,
      },
      { personalAutoSaveEligible: session.personalAutoSaveEligible && !prompt.othersPrompted }
    );
    if (memory.status === "archived") throw new Error("A newly created memory cannot be archived");
    return { id: memory.id, status: memory.status, revisionId: memory.currentRevisionId };
  }

  /**
   * Search current facts in the session's partitions, checking access before and after SQL. A
   * personal store the owner may not use is skipped, or refused when explicitly requested. Personal
   * hits are dropped if the prompt or the owner's preference no longer allows them once the query
   * returns; a permission revoked meanwhile fails the search.
   */
  async search(sessionId: string, input: MemorySearchInput): Promise<MemorySearchResponse> {
    const session = await this.loadSession(sessionId);
    const prompt =
      !input.scopeType || input.scopeType === "personal"
        ? await this.promptFor(session)
        : UNATTRIBUTED_PROMPT;
    let partitions = this.searchPartitions(session, input, prompt);
    const personalStore = partitions.find((entry) => entry.partition.type === "personal");
    if (personalStore && !(await this.mayAccessPartitions(session, [personalStore.partition]))) {
      if (input.scopeType) throw new MemoryAccessError(SCOPE_UNAVAILABLE);
      partitions = partitions.filter((entry) => entry !== personalStore);
    }
    const all = partitions.map((entry) => entry.partition);
    if (!(await this.mayAccessPartitions(session, all)))
      throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    let hits = await this.deps.factIndex.search({
      terms: memorySearchTerms(input.query),
      partitions,
      limit: input.limit,
    });
    if (!(await this.mayAccessPartitions(session, all)))
      throw new MemoryAccessError(SCOPE_UNAVAILABLE);
    // The query already kept a child to its pinned records.
    const current = hits.some((hit) => hit.partition.type === "personal")
      ? await this.personalStillReadable(sessionId, true)
      : null;
    if (!current) hits = hits.filter((hit) => hit.partition.type !== "personal");
    const response = factSearchResponse(hits, input.limit);
    const personal = response.results.filter((result) => result.scope.type === "personal");
    if (current && personal.length)
      await this.auditPersonalRead(
        current,
        personal.map((result) => result.id)
      );
    return response;
  }

  private async loadSession(sessionId: string): Promise<MemorySession> {
    const session = await this.deps.selections.loadSession(sessionId);
    if (!session) throw new MemoryNotFoundError(SESSION_NOT_FOUND);
    return session;
  }

  /**
   * Reread the session, its owner's preference and the prompt just before personal records leave
   * the service, since an opt-out, a suspension or another prompt may have landed while the query
   * ran. Returns that current view while personal records may still be read.
   */
  private async personalStillReadable(
    sessionId: string,
    pinned: boolean
  ): Promise<{ session: MemorySession; prompt: MemoryPromptContext } | null> {
    const session = await this.loadSession(sessionId);
    const prompt = await this.promptFor(session);
    return personalReadable(session, prompt, pinned) ? { session, prompt } : null;
  }

  /** The prompt the agent is serving; the session runtime is asked only when personal memory applies. */
  private promptFor(session: MemorySession): Promise<MemoryPromptContext> {
    return session.sources.personalOwnerUserId
      ? this.deps.prompts.current(session.id)
      : Promise.resolve(UNATTRIBUTED_PROMPT);
  }

  /** Conceal a personal record that may no longer be read; otherwise audit returning it. */
  private async releasePersonal(sessionId: string, pinned: boolean, memoryId: string) {
    const current = await this.personalStillReadable(sessionId, pinned);
    if (!current) throw new MemoryNotFoundError();
    await this.auditPersonalRead(current, [memoryId]);
  }

  /** Record personal records returned to the agent, with the prompt they served. */
  private async auditPersonalRead(
    { session, prompt }: { session: MemorySession; prompt: MemoryPromptContext },
    memoryIds: string[]
  ): Promise<void> {
    await this.deps.audit.recordRead({
      requestId: this.deps.requestId,
      sessionId: session.id,
      // Personal records are returned only for the owner's own prompts.
      promptAuthorUserId: prompt.authorUserId,
      ownerUserId: session.sources.personalOwnerUserId,
      memoryIds,
    });
  }

  /** Whether the session principal may currently access these partitions. */
  private async mayAccessPartitions(
    session: MemorySession,
    partitions: readonly MemoryPartition[]
  ): Promise<boolean> {
    const decision = await this.deps.access.check(session.principal, partitions);
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

  /** The partition a session-relative write targets, with its display scope. */
  private writeTarget(
    session: MemorySession,
    input: SandboxMemoryWriteInput,
    prompt: MemoryPromptContext
  ): { partition: MemoryPartition; scope: MemoryScope } {
    switch (input.scopeType) {
      case "repository": {
        if (input.repoOwner === undefined && session.sources.repositories.length > 1)
          throw new MemoryValidationError(
            `This session spans multiple repositories — specify repoOwner and repoName (one of: ${session.sources.repositories.map((repo) => `${repo.repoOwner}/${repo.repoName}`).join(", ")})`
          );
        const [repo] = this.selectRepositories(session, input);
        if (!repo) throw new MemoryAccessError(REPOSITORY_OUTSIDE_SESSION);
        const partition = repositoryPartition(repo);
        if (!partition) throw new MemoryAccessError(OUTSIDE_SESSION);
        return {
          partition,
          scope: { type: "repository", repoOwner: repo.repoOwner, repoName: repo.repoName },
        };
      }
      case "environment": {
        const environmentId = session.sources.environmentId;
        if (!environmentId) throw new MemoryAccessError(NO_ENVIRONMENT);
        return {
          partition: { type: "environment", environmentId },
          scope: { type: "environment", environmentId },
        };
      }
      case "personal": {
        if (!session.sources.personalOwnerUserId) throw new MemoryAccessError(OUTSIDE_SESSION);
        const denial = personalWriteDenial(session, prompt);
        if (denial) throw new MemoryAccessError(denial);
        return {
          partition: { type: "personal", userId: session.sources.personalOwnerUserId },
          scope: { type: "personal" },
        };
      }
      default:
        return unhandled("memory scope", input.scopeType);
    }
  }

  /** Session-relative searchable partitions; an explicitly requested unavailable scope fails. */
  private searchPartitions(
    session: MemorySession,
    input: MemorySearchInput,
    prompt: MemoryPromptContext
  ): FactSearchPartition[] {
    const partitions: FactSearchPartition[] = [];
    const wants = (scopeType: NonNullable<MemorySearchInput["scopeType"]>) =>
      !input.scopeType || input.scopeType === scopeType;
    if (wants("personal")) {
      const access = personalReadAccess(session, prompt);
      if (access !== "none" && session.sources.personalOwnerUserId)
        partitions.push({
          partition: { type: "personal", userId: session.sources.personalOwnerUserId },
          ...(access === "pinned" ? { pinnedIn: session.id } : {}),
        });
      else if (input.scopeType) throw new MemoryAccessError(personalReadDenial(session, prompt));
    }
    if (wants("repository")) {
      const repositories = this.selectRepositories(session, input);
      if (input.scopeType && !repositories.length)
        throw new MemoryAccessError(REPOSITORY_OUTSIDE_SESSION);
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
      else if (input.scopeType) throw new MemoryAccessError(NO_ENVIRONMENT);
    }
    return partitions;
  }
}
