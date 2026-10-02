import {
  createMemorySchema,
  memoryContentSchema,
  MEMORY_LIMITS,
  type CreateMemoryInput,
  type MemoryContent,
  type MemoryPreferences,
  type MemoryRecord,
  type MemoryRevision,
  type MemoryScope,
  type MemoryStatus,
} from "@open-inspect/shared/types/memories";
import { generateId, hashToken } from "../auth/crypto";
import type { MemoryTarget } from "../session/memory-resolution";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";

export class MemoryConflictError extends Error {}
export class MemoryValidationError extends Error {}
/** Server-derived provenance; never populate identity or auto-save eligibility from tool arguments. */
export interface MemoryActor {
  kind: "user" | "agent";
  userId: string | null;
  sessionId?: string;
  requestId: string;
  /** Shared-session personal writes require owner review until tools have turn-bound authorship. */
  allowPersonalAutoSave?: boolean;
}
export interface MemoryRow {
  id: string;
  scope_type: MemoryScope["type"];
  owner_user_id: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  repo_id: number | null;
  environment_id: string | null;
  memory_type: MemoryRecord["memoryType"];
  status: MemoryStatus;
  current_revision_id: string;
  title: string;
  description: string;
  content: string;
  revision_number: number;
  author_kind: "user" | "agent";
  author_user_id: string | null;
  author_session_id: string | null;
  supersedes_memory_id: string | null;
  supersedes_revision_id: string | null;
  approved_at: number | null;
  archived_at: number | null;
  archive_reason: string | null;
  created_at: number;
  updated_at: number;
}
export const MEMORY_SELECT = `SELECT m.*, r.title, r.description, r.content, r.revision_number
  FROM memories m JOIN memory_revisions r ON r.id = m.current_revision_id AND r.memory_id = m.id`;
export function memoryFromRow(row: MemoryRow): MemoryRecord {
  const scope: MemoryScope =
    row.scope_type === "personal"
      ? { type: "personal" }
      : row.scope_type === "repository"
        ? { type: "repository", repoOwner: row.repo_owner!, repoName: row.repo_name! }
        : { type: "environment", environmentId: row.environment_id! };
  return {
    id: row.id,
    scope,
    repoId: row.repo_id,
    ownerUserId: row.owner_user_id,
    memoryType: row.memory_type,
    status: row.status,
    title: row.title,
    description: row.description,
    content: row.content,
    currentRevisionId: row.current_revision_id,
    revisionNumber: row.revision_number,
    authorKind: row.author_kind,
    authorUserId: row.author_user_id,
    authorSessionId: row.author_session_id,
    supersedesMemoryId: row.supersedes_memory_id,
    approvedAt: row.approved_at,
    archivedAt: row.archived_at,
    archiveReason: row.archive_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function scopePredicate(
  scope: MemoryScope,
  ownerUserId: string | null,
  repoId: number | null = null
): { sql: string; values: unknown[] } {
  if (scope.type === "personal")
    return { sql: "m.scope_type = 'personal' AND m.owner_user_id = ?", values: [ownerUserId] };
  if (scope.type === "environment")
    return {
      sql: "m.scope_type = 'environment' AND m.environment_id = ?",
      values: [scope.environmentId],
    };
  return {
    sql: "m.scope_type = 'repository' AND lower(m.repo_owner) = lower(?) AND lower(m.repo_name) = lower(?) AND m.repo_id = ?",
    values: [scope.repoOwner, scope.repoName, repoId],
  };
}
function sameScope(
  a: MemoryRecord,
  scope: MemoryScope,
  owner: string | null,
  repoId: number | null
): boolean {
  if (a.scope.type !== scope.type) return false;
  if (scope.type === "personal") return a.ownerUserId === owner;
  if (scope.type === "environment")
    return a.scope.type === "environment" && a.scope.environmentId === scope.environmentId;
  return (
    a.scope.type === "repository" &&
    repoId !== null &&
    a.repoId === repoId &&
    a.scope.repoOwner.toLowerCase() === scope.repoOwner.toLowerCase() &&
    a.scope.repoName.toLowerCase() === scope.repoName.toLowerCase()
  );
}

/**
 * Persist revisioned memories after the caller has authorized the target scope.
 * Mutations claim a unique operation ID in an atomic batch; dependent revision,
 * supersession, and audit statements check that ID so a lost race leaves no side effects.
 * This store enforces lifecycle/quota invariants, not general user or team authorization.
 */
export class MemoryStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(id: string): Promise<MemoryRecord | null> {
    const row = await this.db
      .prepare(`${MEMORY_SELECT} WHERE m.id = ?`)
      .bind(id)
      .first<MemoryRow>();
    return row ? (await this.withReplacements([memoryFromRow(row)]))[0] : null;
  }
  async list(
    scope: MemoryScope,
    ownerUserId: string | null,
    status: MemoryStatus = "active",
    repoId: number | null = null
  ): Promise<MemoryRecord[]> {
    const predicate = scopePredicate(scope, ownerUserId, repoId);
    const result = await this.db
      .prepare(
        `${MEMORY_SELECT} WHERE ${predicate.sql} AND m.status = ? ORDER BY m.updated_at DESC, m.id`
      )
      .bind(...predicate.values, status)
      .all<MemoryRow>();
    return this.withReplacements(result.results.map(memoryFromRow));
  }
  private async withReplacements(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    const replacements = new Map<string, string[]>();
    for (let offset = 0; offset < records.length; offset += MAX_D1_QUERY_PARAMETERS) {
      const ids = records
        .slice(offset, offset + MAX_D1_QUERY_PARAMETERS)
        .map((record) => record.id);
      const rows = await this.db
        .prepare(
          `SELECT id, supersedes_memory_id FROM memories WHERE supersedes_memory_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at, id`
        )
        .bind(...ids)
        .all<{ id: string; supersedes_memory_id: string }>();
      for (const row of rows.results)
        replacements.set(row.supersedes_memory_id, [
          ...(replacements.get(row.supersedes_memory_id) ?? []),
          row.id,
        ]);
    }
    return records.map((record) => ({
      ...record,
      replacementMemoryIds: replacements.get(record.id) ?? [],
    }));
  }
  /** Read active candidates across already-authorized scopes; selection budgets are applied later. */
  async listApplicable(target: MemoryTarget): Promise<MemoryRecord[]> {
    const predicates = [
      ...(target.canonicalUserId && target.includePersonalMemories
        ? [scopePredicate({ type: "personal" }, target.canonicalUserId)]
        : []),
      ...target.repositories.map((repo) =>
        scopePredicate({ type: "repository", ...repo }, null, repo.repoId)
      ),
      ...(target.environmentId
        ? [scopePredicate({ type: "environment", environmentId: target.environmentId }, null)]
        : []),
    ];
    if (!predicates.length) return [];
    // A batch gives every scope one consistent catalog snapshot and avoids D1 parameter limits.
    const results = await this.db.batch<MemoryRow>(
      predicates.map((predicate) =>
        this.db
          .prepare(`${MEMORY_SELECT} WHERE m.status = 'active' AND ${predicate.sql}`)
          .bind(...predicate.values)
      )
    );
    return [
      ...new Map(
        results.flatMap((result) => result.results).map((row) => [row.id, memoryFromRow(row)])
      ).values(),
    ];
  }
  /** Missing preferences opt into personal context; existing session manifests are unaffected. */
  async getPreferences(userId: string): Promise<MemoryPreferences> {
    const row = await this.db
      .prepare("SELECT include_personal_memories FROM memory_preferences WHERE user_id = ?")
      .bind(userId)
      .first<{ include_personal_memories: number }>();
    return { includePersonalMemories: row ? row.include_personal_memories === 1 : true };
  }
  async setPreferences(userId: string, input: MemoryPreferences): Promise<MemoryPreferences> {
    await this.db
      .prepare(
        `INSERT INTO memory_preferences (user_id, include_personal_memories, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET include_personal_memories = excluded.include_personal_memories, updated_at = excluded.updated_at`
      )
      .bind(userId, input.includePersonalMemories ? 1 : 0, Date.now())
      .run();
    return input;
  }
  async revisions(id: string): Promise<MemoryRevision[]> {
    const result = await this.db
      .prepare("SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number DESC")
      .bind(id)
      .all<{
        id: string;
        memory_id: string;
        revision_number: number;
        memory_type: MemoryRecord["memoryType"];
        title: string;
        description: string;
        content: string;
        author_kind: "user" | "agent";
        author_user_id: string | null;
        author_session_id: string | null;
        created_at: number;
      }>();
    return result.results.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      revisionNumber: row.revision_number,
      memoryType: row.memory_type,
      title: row.title,
      description: row.description,
      content: row.content,
      authorKind: row.author_kind,
      authorUserId: row.author_user_id,
      authorSessionId: row.author_session_id,
      createdAt: row.created_at,
    }));
  }

  /**
   * Atomically create a record, its first revision, and audit event.
   * Human writes are active; agent writes require approval except eligible personal facts.
   * Auto-save eligibility and agent quotas are rechecked in SQL at commit time.
   * Proposed replacements leave their predecessor active until approval.
   * @throws MemoryConflictError if a quota, eligibility, or predecessor guard loses a race.
   */
  async create(
    raw: CreateMemoryInput,
    actor: MemoryActor,
    repoId: number | null = null
  ): Promise<MemoryRecord> {
    const parsed = createMemorySchema.safeParse(raw);
    if (!parsed.success) throw new MemoryValidationError(parsed.error.issues[0]?.message);
    const input = parsed.data;
    const scope = input.scope;
    if (scope.type === "personal" && !actor.userId)
      throw new MemoryValidationError("Personal memory requires an owner");
    if (actor.kind === "agent" && !actor.sessionId)
      throw new MemoryValidationError("Agent memory requires a session");
    const previous = input.supersedesMemoryId ? await this.get(input.supersedesMemoryId) : null;
    if (
      input.supersedesMemoryId &&
      (!previous ||
        previous.status !== "active" ||
        !sameScope(previous, scope, actor.userId, repoId))
    )
      throw new MemoryConflictError(
        "Replacement must reference an active memory in the same scope"
      );
    const active =
      actor.kind === "user" ||
      (scope.type === "personal" &&
        input.memoryType === "fact" &&
        actor.allowPersonalAutoSave === true &&
        previous?.memoryType !== "directive");
    const status = active ? "active" : "proposed";
    const id = `mem_${generateId()}`;
    const revisionId = `mrev_${generateId()}`;
    const operationId = generateId();
    const now = Date.now();
    const guard =
      actor.kind === "agent"
        ? `AND (SELECT COUNT(*) FROM memories WHERE author_session_id = ?) < ?
      AND (? = 'active' OR (SELECT COUNT(*) FROM memories WHERE author_session_id = ? AND status = 'proposed') < ?)`
        : "";
    const statements = [
      this.db
        .prepare(
          `INSERT INTO memories
      (id, scope_type, owner_user_id, repo_owner, repo_name, repo_id, environment_id, memory_type, status, current_revision_id, author_kind, author_user_id, author_session_id, supersedes_memory_id, supersedes_revision_id, approved_at, last_operation_id, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE 1 = 1 ${guard}
      ${actor.kind === "agent" && active ? "AND EXISTS (SELECT 1 FROM session_memory_manifests m JOIN sessions s ON s.id = m.session_id WHERE m.session_id = ? AND personal_auto_save_eligible = 1 AND include_personal_memories = 1 AND personal_owner_user_id = ? AND s.visibility = 'private' AND s.user_id = m.personal_owner_user_id)" : ""}
      ${previous ? "AND EXISTS (SELECT 1 FROM memories WHERE id = ? AND current_revision_id = ? AND status = 'active')" : ""}`
        )
        .bind(
          id,
          scope.type,
          scope.type === "personal" ? actor.userId : null,
          scope.type === "repository" ? scope.repoOwner : null,
          scope.type === "repository" ? scope.repoName : null,
          repoId,
          scope.type === "environment" ? scope.environmentId : null,
          input.memoryType,
          status,
          actor.kind,
          actor.userId,
          actor.sessionId ?? null,
          previous?.id ?? null,
          previous?.currentRevisionId ?? null,
          active ? now : null,
          operationId,
          now,
          now,
          ...(actor.kind === "agent"
            ? [
                actor.sessionId,
                MEMORY_LIMITS.writesPerSession,
                status,
                actor.sessionId,
                MEMORY_LIMITS.pendingPerSession,
              ]
            : []),
          ...(actor.kind === "agent" && active ? [actor.sessionId, actor.userId] : []),
          ...(previous ? [previous.id, previous.currentRevisionId] : [])
        ),
      await this.revisionInsert(id, revisionId, 1, input, actor, now, operationId),
      this.db
        .prepare(
          "UPDATE memories SET current_revision_id = ? WHERE id = ? AND last_operation_id = ?"
        )
        .bind(revisionId, id, operationId),
      this.audit("created", id, operationId, actor, revisionId, status),
    ];
    if (active && previous)
      statements.push(...this.supersede(previous.id, id, operationId, actor, now));
    const result = await this.db.batch(statements);
    if (!result[0].meta.changes)
      throw new MemoryConflictError(
        "Memory write limit, session access or replacement changed; reload and retry"
      );
    return (await this.get(id))!;
  }

  /**
   * Compare-and-swap an unarchived revision, preserving the record's original provenance.
   * Identical content is a no-op; changed content records the editor on a new revision.
   * @throws MemoryConflictError if the expected revision or status is no longer current.
   */
  async revise(
    id: string,
    content: MemoryContent,
    expectedRevisionId: string,
    actor: MemoryActor
  ): Promise<MemoryRecord> {
    const parsed = memoryContentSchema.safeParse(content);
    if (!parsed.success) throw new MemoryValidationError(parsed.error.issues[0]?.message);
    const current = await this.get(id);
    if (
      !current ||
      current.currentRevisionId !== expectedRevisionId ||
      current.status === "archived"
    )
      throw new MemoryConflictError("Memory changed; reload before editing");
    if (
      ["memoryType", "title", "description", "content"].every(
        (key) => current[key as keyof MemoryContent] === parsed.data[key as keyof MemoryContent]
      )
    )
      return current;
    const revisionId = `mrev_${generateId()}`;
    const operationId = generateId();
    const now = Date.now();
    const results = await this.db.batch([
      this.db
        .prepare(
          "UPDATE memories SET last_operation_id = ?, updated_at = ? WHERE id = ? AND current_revision_id = ? AND status = ?"
        )
        .bind(operationId, now, id, expectedRevisionId, current.status),
      await this.revisionInsert(
        id,
        revisionId,
        current.revisionNumber + 1,
        parsed.data,
        actor,
        now,
        operationId
      ),
      this.db
        .prepare(
          "UPDATE memories SET current_revision_id = ?, memory_type = ? WHERE id = ? AND last_operation_id = ?"
        )
        .bind(revisionId, parsed.data.memoryType, id, operationId),
      this.audit("revised", id, operationId, actor, revisionId, current.status),
    ]);
    if (!results[0].meta.changes)
      throw new MemoryConflictError("Memory changed; reload before editing");
    return (await this.get(id))!;
  }

  /**
   * Apply a lifecycle decision against the expected revision and current status.
   * Approval atomically archives the exact predecessor revision of a replacement.
   * Restore retains approval history: rejected proposals become proposed again, while
   * previously approved records become active without superseding their predecessor again.
   * An approved restore requires the entire replacement family to have no active record.
   * @throws MemoryConflictError on stale state, a changed predecessor, or a full proposal quota.
   */
  async transition(
    id: string,
    action: "archive" | "restore" | "approve" | "reject",
    expectedRevisionId: string,
    actor: MemoryActor,
    reason?: string
  ): Promise<MemoryRecord> {
    const current = await this.get(id);
    if (!current || current.currentRevisionId !== expectedRevisionId)
      throw new MemoryConflictError("Memory changed; reload before acting");
    const allowed =
      action === "restore"
        ? current.status === "archived"
        : action === "archive"
          ? current.status !== "archived"
          : current.status === "proposed";
    if (!allowed) throw new MemoryConflictError("Memory status changed; reload before acting");
    const status: MemoryStatus =
      action === "archive" || action === "reject"
        ? "archived"
        : action === "approve" || current.approvedAt !== null
          ? "active"
          : "proposed";
    const operationId = generateId();
    const now = Date.now();
    const replacementGuard = action === "approve" && current.supersedesMemoryId !== null;
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE memories SET status = ?, approved_at = ?, decided_by = ?, archived_at = ?, archived_by = ?, archive_reason = ?, last_operation_id = ?, updated_at = ?
        WHERE id = ? AND current_revision_id = ? AND status = ?
        ${
          action === "restore" && status === "active"
            ? `AND NOT EXISTS (
          WITH RECURSIVE family(id, parent_id) AS (
            SELECT id, supersedes_memory_id FROM memories WHERE id = ?
            UNION
            SELECT m.id, m.supersedes_memory_id FROM memories m JOIN family f
              ON m.id = f.parent_id OR m.supersedes_memory_id = f.id
          ) SELECT 1 FROM memories active JOIN family f ON f.id = active.id
            WHERE active.status = 'active'
        )`
            : ""
        }
        ${replacementGuard ? "AND EXISTS (SELECT 1 FROM memories old WHERE old.id = memories.supersedes_memory_id AND old.current_revision_id = memories.supersedes_revision_id AND old.status = 'active')" : ""}
        ${status === "proposed" && current.authorSessionId ? "AND (SELECT COUNT(*) FROM memories WHERE author_session_id = ? AND status = 'proposed') < ?" : ""}`
        )
        .bind(
          status,
          action === "approve" ? now : current.approvedAt,
          actor.userId,
          status === "archived" ? now : null,
          status === "archived" ? actor.userId : null,
          status === "archived" ? (action === "reject" ? "rejected" : (reason ?? null)) : null,
          operationId,
          now,
          id,
          expectedRevisionId,
          current.status,
          ...(action === "restore" && status === "active" ? [id] : []),
          ...(status === "proposed" && current.authorSessionId
            ? [current.authorSessionId, MEMORY_LIMITS.pendingPerSession]
            : [])
        ),
      this.audit(
        (
          {
            archive: "archived",
            restore: "restored",
            approve: "approved",
            reject: "rejected",
          } as const
        )[action],
        id,
        operationId,
        actor,
        expectedRevisionId,
        status
      ),
      ...(replacementGuard
        ? this.supersede(current.supersedesMemoryId!, id, operationId, actor, now)
        : []),
    ]);
    if (!results[0].meta.changes)
      throw new MemoryConflictError(
        "Memory or replacement changed, another replacement is active, or pending proposal limit reached"
      );
    return (await this.get(id))!;
  }

  private async revisionInsert(
    id: string,
    revisionId: string,
    number: number,
    content: MemoryContent,
    actor: MemoryActor,
    now: number,
    operationId: string
  ): Promise<SqlStatement> {
    const hash = await hashToken(
      JSON.stringify([content.memoryType, content.title, content.description, content.content])
    );
    return this.db
      .prepare(
        `INSERT INTO memory_revisions (id, memory_id, revision_number, memory_type, title, description, content, content_sha256, author_kind, author_user_id, author_session_id, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memories WHERE id = ? AND last_operation_id = ?)`
      )
      .bind(
        revisionId,
        id,
        number,
        content.memoryType,
        content.title,
        content.description,
        content.content,
        hash,
        actor.kind,
        actor.userId,
        actor.sessionId ?? null,
        now,
        id,
        operationId
      );
  }
  /** Build an operation-fenced audit event containing identifiers/status only, never memory text. */
  private audit(
    verb: string,
    id: string,
    operationId: string,
    actor: MemoryActor,
    revisionId: string,
    status: MemoryStatus
  ): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO authorization_audit_events (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot, action, resource_type, resource_id, reason_code, operation_result, metadata_json)
      SELECT ?, ?, ?, ?, ?, ?, 'memory', ?, ?, 'applied', ? WHERE EXISTS (SELECT 1 FROM memories WHERE id = ? AND last_operation_id = ?)`
      )
      .bind(
        generateId(),
        Date.now(),
        actor.requestId,
        actor.kind === "agent" ? "sandbox" : "user",
        actor.userId,
        `memory.${verb}`,
        id,
        `memory.${verb}`,
        JSON.stringify({
          before: {},
          requested: {},
          after: { revisionId, status, sessionId: actor.sessionId ?? null },
        }),
        id,
        operationId
      );
  }
  private supersede(
    oldId: string,
    id: string,
    operationId: string,
    actor: MemoryActor,
    now: number
  ): SqlStatement[] {
    return [
      this.db
        .prepare(
          `UPDATE memories SET status = 'archived', archived_at = ?, archived_by = ?, archive_reason = 'superseded', last_operation_id = ?, updated_at = ?
      WHERE id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM memories replacement WHERE replacement.id = ? AND replacement.last_operation_id = ? AND replacement.status = 'active')`
        )
        .bind(now, actor.userId, operationId, now, oldId, id, operationId),
      this.audit("superseded", oldId, operationId, actor, "superseded", "archived"),
    ];
  }
}
