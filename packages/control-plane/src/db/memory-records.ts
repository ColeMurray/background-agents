import {
  MEMORY_CONTENT_KEYS,
  MEMORY_LIMITS,
  MEMORY_TRANSITIONS,
  memoryContentSchema,
  type MemoryAction,
  type MemoryArchiveKind,
  type MemoryAuthorKind,
  type MemoryContent,
  type MemoryRevision,
  type MemoryStatus,
  type MemoryType,
} from "@open-inspect/shared/types/memories";
import { generateId, hashToken } from "../auth/crypto";
import { MemoryConflictError, MemoryValidationError } from "../memory/errors";
import { initialStatus } from "../memory/lifecycle";
import {
  partitionColumns,
  partitionFromColumns,
  partitionPredicate,
  samePartition,
  type MemoryPartition,
  type PartitionColumns,
} from "../memory/partition";
import type { MemoryActor, MemoryCandidate, MemoryRecord } from "../memory/types";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { CURRENT_MEMORY, inPartitions } from "./memory-queries";
import { prepareSql, sql, type SqlFragment } from "./sql-fragment";
import {
  agentWriteGuard,
  agentWriteQuota,
  pendingProposalQuota,
  personalAutoSaveGuard,
} from "./session-memory-write-guard";

export interface MemoryRow extends PartitionColumns {
  id: string;
  memory_type: MemoryType;
  status: MemoryStatus;
  archive_kind: MemoryArchiveKind | null;
  archive_note: string | null;
  current_revision_id: string;
  title: string;
  description: string;
  content: string | null;
  revision_number: number;
  author_kind: MemoryAuthorKind;
  author_user_id: string | null;
  author_session_id: string | null;
  supersedes_memory_id: string | null;
  approved_at: number | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A live record with its full current revision. */
const CURRENT_MEMORY_SELECT = sql`SELECT m.*, r.title, r.description, r.content, r.revision_number
  ${CURRENT_MEMORY}`;

function recordFields(row: MemoryRow) {
  return {
    id: row.id,
    partition: partitionFromColumns(row),
    status: row.status,
    archiveKind: row.archive_kind,
    archiveNote: row.archive_note,
    title: row.title,
    description: row.description,
    currentRevisionId: row.current_revision_id,
    revisionNumber: row.revision_number,
    authorKind: row.author_kind,
    authorUserId: row.author_user_id,
    authorSessionId: row.author_session_id,
    supersedesMemoryId: row.supersedes_memory_id,
    approvedAt: row.approved_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function memoryFromRow(row: MemoryRow): MemoryRecord {
  return { ...recordFields(row), memoryType: row.memory_type, content: row.content ?? "" };
}

function candidateFromRow(row: MemoryRow): MemoryCandidate {
  return row.memory_type === "directive"
    ? { ...recordFields(row), memoryType: "directive", content: row.content ?? "" }
    : { ...recordFields(row), memoryType: "fact", content: null };
}

export interface MemoryListOptions {
  status: MemoryStatus;
  offset: number;
  limit: number;
}

/** Content for a new record; the partition is resolved and authorized by the caller. */
export interface NewMemory {
  partition: MemoryPartition;
  content: MemoryContent;
  supersedesMemoryId?: string;
}

/**
 * The memory records themselves: current content, immutable revisions, and lifecycle status,
 * keyed by partition. It knows nothing about which sessions use a record — that is
 * `SessionMemorySelectionStore`. Callers authorize the target partition first.
 *
 * Every mutation claims a fresh operation ID on the record in the first statement of an atomic
 * batch; the dependent revision, supersession, and audit statements apply only if that claim
 * won, so a lost race leaves no side effects. Agent inserts also enforce the writing session's
 * commit-time preconditions (see `agentWriteGuard`).
 */
export class MemoryRecordStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Load one live record; callers authorize its partition. */
  async get(id: string): Promise<MemoryRecord | null> {
    const row = await prepareSql(
      this.db,
      sql`${CURRENT_MEMORY_SELECT} WHERE m.id = ${id}`
    ).first<MemoryRow>();
    return row ? memoryFromRow(row) : null;
  }

  /** Read one management page in stable updated-time/ID order. */
  async list(partition: MemoryPartition, options: MemoryListOptions): Promise<MemoryRecord[]> {
    const result = await prepareSql(
      this.db,
      sql`${CURRENT_MEMORY_SELECT} WHERE ${partitionPredicate(partition)} AND m.status = ${options.status}
        ORDER BY m.updated_at DESC, m.id LIMIT ${options.limit} OFFSET ${options.offset}`
    ).all<MemoryRow>();
    return result.results.map(memoryFromRow);
  }

  /** Reverse replacement links (newest-created last), batched within the parameter limit. */
  async replacementIds(ids: readonly string[]): Promise<Map<string, string[]>> {
    const replacements = new Map<string, string[]>();
    for (let offset = 0; offset < ids.length; offset += MAX_D1_QUERY_PARAMETERS) {
      const batch = ids.slice(offset, offset + MAX_D1_QUERY_PARAMETERS);
      const rows = await prepareSql(
        this.db,
        sql`SELECT id, supersedes_memory_id FROM memories
          WHERE supersedes_memory_id IN (${sql.join(
            batch.map((id) => sql`${id}`),
            ", "
          )}) ORDER BY created_at, id`
      ).all<{ id: string; supersedes_memory_id: string }>();
      for (const row of rows.results)
        replacements.set(row.supersedes_memory_id, [
          ...(replacements.get(row.supersedes_memory_id) ?? []),
          row.id,
        ]);
    }
    return replacements;
  }

  /**
   * Read bounded selection candidates and the active total in one consistent snapshot. Each
   * partition contributes at most the global record budget per type, in selection order (oldest
   * directives, most recently updated facts); facts project their summary only. Rows beyond those
   * caps are reported as `omittedCount`.
   */
  async listCandidates(
    partitions: readonly MemoryPartition[]
  ): Promise<{ candidates: MemoryCandidate[]; omittedCount: number }> {
    if (!partitions.length) return { candidates: [], omittedCount: 0 };
    const active = sql`m.status = 'active' AND ${inPartitions(partitions)}`;
    const [totals, ranked] = await this.db.batch<{ total: number } | MemoryRow>([
      prepareSql(this.db, sql`SELECT COUNT(*) AS total FROM memories m WHERE ${active}`),
      prepareSql(
        this.db,
        sql`SELECT * FROM (
            SELECT m.*, r.title, r.description, r.revision_number,
              CASE WHEN m.memory_type = 'directive' THEN r.content ELSE NULL END AS content,
              ROW_NUMBER() OVER (
                PARTITION BY m.scope_type, m.scope_key, m.memory_type
                ORDER BY CASE WHEN m.memory_type = 'directive' THEN m.created_at ELSE -m.updated_at END,
                  m.id
              ) AS rank_in_partition
            ${CURRENT_MEMORY} WHERE ${active}
          ) ranked
          WHERE (memory_type = 'directive' AND rank_in_partition <= ${MEMORY_LIMITS.directiveRecords})
            OR (memory_type = 'fact' AND rank_in_partition <= ${MEMORY_LIMITS.catalogRecords})`
      ),
    ]);
    const candidates = (ranked.results as MemoryRow[]).map(candidateFromRow);
    const total = (totals.results[0] as { total: number }).total;
    return { candidates, omittedCount: total - candidates.length };
  }

  /** Immutable content history, newest first; callers authorize the record. */
  async revisions(id: string): Promise<MemoryRevision[]> {
    const result = await prepareSql(
      this.db,
      sql`SELECT * FROM memory_revisions WHERE memory_id = ${id} ORDER BY revision_number DESC`
    ).all<{
      id: string;
      memory_id: string;
      revision_number: number;
      memory_type: MemoryType;
      title: string;
      description: string;
      content: string;
      author_kind: MemoryAuthorKind;
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
   * Atomically create a record, its first revision, and an audit event. A replacement that is
   * active immediately archives its predecessor in the same batch; a proposed replacement leaves
   * the predecessor active until approval.
   * @throws MemoryConflictError if a quota, eligibility, session, or predecessor guard loses.
   */
  async create(input: NewMemory, actor: MemoryActor): Promise<MemoryRecord> {
    const content = parseContent(input.content);
    const predecessor = input.supersedesMemoryId ? await this.get(input.supersedesMemoryId) : null;
    if (
      input.supersedesMemoryId &&
      (!predecessor ||
        predecessor.status !== "active" ||
        !samePartition(predecessor.partition, input.partition))
    )
      throw new MemoryConflictError(
        "Replacement must reference an active memory in the same scope"
      );
    const status = initialStatus(content.memoryType, input.partition, actor, predecessor);
    const id = `mem_${generateId()}`;
    const revisionId = `mrev_${generateId()}`;
    const operationId = generateId();
    const now = Date.now();

    const guards: SqlFragment[] = [];
    if (actor.kind === "agent") {
      guards.push(
        agentWriteGuard(actor, input.partition),
        agentWriteQuota(actor.sessionId, MEMORY_LIMITS.writesPerSession)
      );
      if (status === "proposed")
        guards.push(pendingProposalQuota(actor.sessionId, MEMORY_LIMITS.pendingPerSession));
      else guards.push(personalAutoSaveGuard(actor.sessionId, actor.userId));
    }
    if (predecessor)
      guards.push(sql`EXISTS (SELECT 1 FROM memories WHERE id = ${predecessor.id}
        AND current_revision_id = ${predecessor.currentRevisionId} AND status = 'active')`);

    const columns = partitionColumns(input.partition);
    const statements = [
      prepareSql(
        this.db,
        sql`INSERT INTO memories
          (id, scope_type, scope_key, repo_owner, repo_name, memory_type, status, current_revision_id,
           author_kind, author_user_id, author_session_id, supersedes_memory_id, supersedes_revision_id,
           approved_at, last_operation_id, created_at, updated_at)
          SELECT ${id}, ${columns.scope_type}, ${columns.scope_key}, ${columns.repo_owner},
            ${columns.repo_name}, ${content.memoryType}, ${status}, NULL, ${actor.kind},
            ${actor.userId}, ${actorSessionId(actor)}, ${predecessor?.id ?? null},
            ${predecessor?.currentRevisionId ?? null}, ${status === "active" ? now : null},
            ${operationId}, ${now}, ${now}
          ${guards.length ? sql`WHERE ${sql.join(guards, " AND ")}` : sql.empty}`
      ),
      await this.revisionInsert(id, revisionId, 1, content, actor, now, operationId),
      prepareSql(
        this.db,
        sql`UPDATE memories SET current_revision_id = ${revisionId}
          WHERE id = ${id} AND last_operation_id = ${operationId}`
      ),
      this.audit("memory.created", id, operationId, actor, revisionId, status),
      ...(status === "active" && predecessor
        ? this.supersede(predecessor, id, operationId, actor, now)
        : []),
    ];
    const [claim] = await this.db.batch(statements);
    if (!claim.meta.changes)
      throw new MemoryConflictError(
        "Memory write limit, session access or replacement changed; reload and retry"
      );
    return (await this.get(id))!;
  }

  /**
   * Compare-and-swap an unarchived record's content, preserving its original provenance.
   * Identical content is a no-op; changed content records the editor on a new revision.
   * @throws MemoryConflictError if the expected revision or status is no longer current.
   */
  async revise(
    id: string,
    rawContent: MemoryContent,
    expectedRevisionId: string,
    actor: MemoryActor
  ): Promise<MemoryRecord> {
    const content = parseContent(rawContent);
    const current = await this.get(id);
    if (
      !current ||
      current.currentRevisionId !== expectedRevisionId ||
      current.status === "archived"
    )
      throw new MemoryConflictError("Memory changed; reload before editing");
    if (MEMORY_CONTENT_KEYS.every((key) => current[key] === content[key])) return current;
    const revisionId = `mrev_${generateId()}`;
    const operationId = generateId();
    const now = Date.now();
    const [claim] = await this.db.batch([
      prepareSql(
        this.db,
        sql`UPDATE memories SET last_operation_id = ${operationId}, updated_at = ${now}
          WHERE id = ${id} AND current_revision_id = ${expectedRevisionId} AND status = ${current.status}`
      ),
      await this.revisionInsert(
        id,
        revisionId,
        current.revisionNumber + 1,
        content,
        actor,
        now,
        operationId
      ),
      prepareSql(
        this.db,
        sql`UPDATE memories SET current_revision_id = ${revisionId}, memory_type = ${content.memoryType}
          WHERE id = ${id} AND last_operation_id = ${operationId}`
      ),
      this.audit("memory.revised", id, operationId, actor, revisionId, current.status),
    ]);
    if (!claim.meta.changes) throw new MemoryConflictError("Memory changed; reload before editing");
    return (await this.get(id))!;
  }

  /**
   * Apply a lifecycle action from `MEMORY_TRANSITIONS` against the expected revision.
   * Approving a replacement atomically archives the exact predecessor revision it was based on.
   * Restoring to active requires the whole replacement family to have no active record, and
   * restoring to review respects the author session's pending-proposal quota.
   * @throws MemoryConflictError on stale state, a changed predecessor, or a full proposal quota.
   */
  async transition(
    id: string,
    action: MemoryAction,
    expectedRevisionId: string,
    actor: MemoryActor,
    note?: string
  ): Promise<MemoryRecord> {
    const current = await this.get(id);
    if (!current || current.currentRevisionId !== expectedRevisionId)
      throw new MemoryConflictError("Memory changed; reload before acting");
    const rule = MEMORY_TRANSITIONS[action];
    if (!(rule.from as readonly MemoryStatus[]).includes(current.status))
      throw new MemoryConflictError("Memory status changed; reload before acting");
    const next = rule.to(current);
    const archived = next.status === "archived";
    const predecessor =
      action === "approve" && current.supersedesMemoryId
        ? await this.get(current.supersedesMemoryId)
        : null;
    if (action === "approve" && current.supersedesMemoryId && !predecessor)
      throw new MemoryConflictError("Replacement predecessor is unavailable");

    const guards: SqlFragment[] = [];
    if (action === "restore" && next.status === "active") guards.push(replacementFamilyIdle(id));
    if (predecessor)
      guards.push(sql`EXISTS (SELECT 1 FROM memories old WHERE old.id = memories.supersedes_memory_id
        AND old.current_revision_id = memories.supersedes_revision_id AND old.status = 'active')`);
    if (next.status === "proposed" && current.authorSessionId)
      guards.push(pendingProposalQuota(current.authorSessionId, MEMORY_LIMITS.pendingPerSession));

    const operationId = generateId();
    const now = Date.now();
    const [claim] = await this.db.batch([
      prepareSql(
        this.db,
        sql`UPDATE memories SET status = ${next.status}, archive_kind = ${next.archiveKind},
            archive_note = ${archived ? (note ?? null) : null},
            approved_at = ${action === "approve" ? now : current.approvedAt},
            decided_by = ${actor.userId}, archived_at = ${archived ? now : null},
            archived_by = ${archived ? actor.userId : null},
            last_operation_id = ${operationId}, updated_at = ${now}
          WHERE id = ${id} AND current_revision_id = ${expectedRevisionId} AND status = ${current.status}
          ${guards.length ? sql`AND ${sql.join(guards, " AND ")}` : sql.empty}`
      ),
      this.audit(rule.auditAction, id, operationId, actor, expectedRevisionId, next.status),
      ...(predecessor ? this.supersede(predecessor, id, operationId, actor, now) : []),
    ]);
    if (!claim.meta.changes)
      throw new MemoryConflictError(
        "Memory or replacement changed, another replacement is active, or pending proposal limit reached"
      );
    return (await this.get(id))!;
  }

  /** A hashed immutable revision that applies only if this operation claimed the record. */
  private async revisionInsert(
    id: string,
    revisionId: string,
    revisionNumber: number,
    content: MemoryContent,
    actor: MemoryActor,
    now: number,
    operationId: string
  ): Promise<SqlStatement> {
    const hash = await hashToken(JSON.stringify(MEMORY_CONTENT_KEYS.map((key) => content[key])));
    return prepareSql(
      this.db,
      sql`INSERT INTO memory_revisions (id, memory_id, revision_number, memory_type, title, description,
          content, content_sha256, author_kind, author_user_id, author_session_id, created_at)
        SELECT ${revisionId}, ${id}, ${revisionNumber}, ${content.memoryType}, ${content.title},
          ${content.description}, ${content.content}, ${hash}, ${actor.kind}, ${actor.userId},
          ${actorSessionId(actor)}, ${now}
        WHERE ${claimed(id, operationId)}`
    );
  }

  /** An operation-fenced audit event with identifiers and status only, never memory text. */
  private audit(
    action: `memory.${string}`,
    id: string,
    operationId: string,
    actor: MemoryActor,
    revisionId: string,
    status: MemoryStatus
  ): SqlStatement {
    return prepareSql(
      this.db,
      sql`INSERT INTO authorization_audit_events (id, occurred_at, request_id, principal_kind,
          actor_user_id_snapshot, action, resource_type, resource_id, reason_code, operation_result,
          metadata_json)
        SELECT ${generateId()}, ${Date.now()}, ${actor.requestId},
          ${actor.kind === "agent" ? "sandbox" : "user"}, ${actor.userId}, ${action}, 'memory', ${id},
          ${action}, 'applied',
          ${JSON.stringify({
            before: {},
            requested: {},
            after: { revisionId, status, sessionId: actorSessionId(actor) },
          })}
        WHERE ${claimed(id, operationId)}`
    );
  }

  /** Archive/audit the exact predecessor only after the replacement wins its activation guard. */
  private supersede(
    predecessor: MemoryRecord,
    replacementId: string,
    operationId: string,
    actor: MemoryActor,
    now: number
  ): SqlStatement[] {
    return [
      prepareSql(
        this.db,
        sql`UPDATE memories SET status = 'archived', archive_kind = 'superseded', archive_note = NULL,
            archived_at = ${now}, archived_by = ${actor.userId}, last_operation_id = ${operationId},
            updated_at = ${now}
          WHERE id = ${predecessor.id} AND status = 'active' AND EXISTS (SELECT 1 FROM memories replacement
            WHERE replacement.id = ${replacementId} AND replacement.last_operation_id = ${operationId}
              AND replacement.status = 'active')`
      ),
      this.audit(
        "memory.superseded",
        predecessor.id,
        operationId,
        actor,
        predecessor.currentRevisionId,
        "archived"
      ),
    ];
  }
}

function parseContent(content: MemoryContent): MemoryContent {
  const parsed = memoryContentSchema.safeParse(content);
  if (!parsed.success)
    throw new MemoryValidationError(parsed.error.issues[0]?.message ?? "Invalid memory");
  return parsed.data;
}

function actorSessionId(actor: MemoryActor): string | null {
  return actor.kind === "agent" ? actor.sessionId : null;
}

/** True only for statements in the batch whose first statement claimed the record. */
function claimed(id: string, operationId: string): SqlFragment {
  return sql`EXISTS (SELECT 1 FROM memories WHERE id = ${id} AND last_operation_id = ${operationId})`;
}

/** No record in the replacement family (ancestors and descendants) is active. */
function replacementFamilyIdle(id: string): SqlFragment {
  return sql`NOT EXISTS (
    WITH RECURSIVE family(id, parent_id) AS (
      SELECT id, supersedes_memory_id FROM memories WHERE id = ${id}
      UNION
      SELECT m.id, m.supersedes_memory_id FROM memories m JOIN family f
        ON m.id = f.parent_id OR m.supersedes_memory_id = f.id
    ) SELECT 1 FROM memories active JOIN family f ON f.id = active.id WHERE active.status = 'active'
  )`;
}
