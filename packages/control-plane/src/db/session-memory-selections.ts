import { DEFAULT_HARNESS, type HarnessId } from "@open-inspect/shared/harnesses";
import {
  memoryScopeSchema,
  type MemoryInclusion,
  type MemoryStatus,
  type MemoryType,
} from "@open-inspect/shared/types/memories";
import { partitionFromColumns, type PartitionColumns } from "../memory/partition";
import { emptySelection } from "../memory/selection";
import type {
  MemorySession,
  PinnedItemDrift,
  PinnedMemoryEntry,
  SessionMemoryPin,
  SessionMemorySelection,
} from "../memory/types";
import { bulkInsertStatements } from "./bulk-insert";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/**
 * A manifest whose personal memory is still on and belongs to someone other than the user bound to
 * the one placeholder: handing that user the sandbox credentials would switch it off.
 */
const PERSONAL_ON_FOR_SOMEONE_ELSE = `personal_owner_user_id IS NOT NULL
  AND personal_owner_user_id <> ?
  AND (personal_reads_eligible = 1 OR personal_auto_save_eligible = 1)`;

interface ManifestRow {
  selection_version: number;
  manifest_sha256: string;
  resolved_at: number;
  personal_owner_user_id: string | null;
  directive_chars: number;
  catalog_chars: number;
  estimated_tokens: number;
  omitted_count: number;
}
interface PinnedItemRow extends PartitionColumns {
  memory_id: string;
  revision_id: string;
  revision_number: number;
  memory_type: MemoryType;
  title: string;
  description: string;
  content: string | null;
  scope_json: string;
  inclusion: MemoryInclusion;
  estimated_tokens: number;
  current_revision_id: string;
  status: MemoryStatus;
}

/** A session's pinned selection, the live drift of its items, and its renderable revisions. */
export interface PinnedSelection {
  selection: SessionMemorySelection;
  /** Live drift for each manifest item, in the same order; for inspection only. */
  drift: PinnedItemDrift[];
  /** Pinned revisions to render; fact bodies are never loaded. */
  entries: PinnedMemoryEntry[];
}

/**
 * What each session sees of memory: the selection pinned when it was created (manifest header and
 * ordered revision references), its memory context (personal owner, repositories, environment,
 * personal read and auto-save eligibility), and pin membership. It never creates or changes memory
 * records — that is `MemoryRecordStore` — and pinned selections stay fixed while the records they
 * reference evolve.
 */
export class SessionMemorySelectionStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Statements that pin a session's selection, run in the session insert's atomic batch.
   * Resolved root sessions start eligible for personal auto-save, whatever their visibility.
   * Children copy the parent's selection; eligibility is never inherited, and a legacy parent
   * without a manifest leaves the child with empty context.
   */
  bindPinned(sessionId: string, pinned: SessionMemoryPin): SqlStatement[] {
    return pinned.kind === "resolved"
      ? this.bindInsert(sessionId, pinned.value)
      : this.bindCopy(sessionId, pinned.parentSessionId, pinned.promptAuthorUserId);
  }

  private bindInsert(sessionId: string, manifest: SessionMemorySelection): SqlStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO session_memory_manifests
      (session_id, selection_version, manifest_sha256, resolved_at, personal_owner_user_id, directive_chars, catalog_chars, estimated_tokens, omitted_count, personal_auto_save_eligible)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN parent_session_id IS NULL THEN 1 ELSE 0 END
      FROM sessions WHERE id = ?`
        )
        .bind(
          sessionId,
          manifest.selectionVersion,
          manifest.manifestSha256,
          manifest.resolvedAt,
          manifest.personalOwnerUserId,
          manifest.directiveChars,
          manifest.catalogChars,
          manifest.estimatedTokens,
          manifest.omittedCount,
          sessionId
        ),
      ...bulkInsertStatements(
        this.db,
        "session_memory_items",
        manifest.items.map((item, position) => ({
          session_id: sessionId,
          position,
          memory_id: item.memoryId,
          revision_id: item.revisionId,
          scope_json: JSON.stringify(item.scope),
          inclusion: item.inclusion,
          estimated_tokens: item.estimatedTokens,
        }))
      ),
    ];
  }

  /**
   * Copy the parent's selection into a child spawned on `promptAuthorUserId`'s prompt. The parent
   * owner's personal records and ownership carry over only when that prompt was theirs; any other
   * author's child gets the shared records alone, and its token estimate drops their share. The
   * hash and character counts stay the parent's, describing the selection that was made. Personal
   * reads switched off in the parent stay off in the child.
   */
  private bindCopy(
    childId: string,
    parentId: string,
    promptAuthorUserId: string | null
  ): SqlStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO session_memory_manifests
      (session_id, selection_version, manifest_sha256, resolved_at, personal_owner_user_id, personal_reads_eligible, directive_chars, catalog_chars, estimated_tokens, omitted_count)
      SELECT ?, selection_version, manifest_sha256, resolved_at,
        CASE WHEN personal_owner_user_id = ? THEN personal_owner_user_id END,
        personal_reads_eligible, directive_chars, catalog_chars,
        CASE WHEN personal_owner_user_id = ? THEN estimated_tokens
          ELSE estimated_tokens - COALESCE((SELECT SUM(i.estimated_tokens) FROM session_memory_items i
            JOIN memories m ON m.id = i.memory_id
            WHERE i.session_id = parent.session_id AND m.partition_type = 'personal'), 0) END,
        omitted_count
      FROM session_memory_manifests parent WHERE session_id = ?`
        )
        .bind(childId, promptAuthorUserId, promptAuthorUserId, parentId),
      this.db
        .prepare(
          `INSERT INTO session_memory_items (session_id, position, memory_id, revision_id, scope_json, inclusion, estimated_tokens)
      SELECT ?, i.position, i.memory_id, i.revision_id, i.scope_json, i.inclusion, i.estimated_tokens
      FROM session_memory_items i
      JOIN memories m ON m.id = i.memory_id
      JOIN session_memory_manifests parent ON parent.session_id = i.session_id
      WHERE i.session_id = ? AND (m.partition_type <> 'personal' OR parent.personal_owner_user_id = ?)
      ORDER BY i.position`
        )
        .bind(childId, parentId, promptAuthorUserId),
    ];
  }

  /**
   * Whether handing `userId` the session's sandbox credentials would switch off its personal
   * memory: someone else's personal memory is still on in it.
   */
  async sandboxAccessEndsPersonal(sessionId: string, userId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS present FROM session_memory_manifests
        WHERE session_id = ? AND ${PERSONAL_ON_FOR_SOMEONE_ELSE}`
      )
      .bind(sessionId, userId)
      .first();
    return row !== null;
  }

  /**
   * Switch off personal reads and auto-save for good in a session and its descendants when
   * `userId`, not the personal owner, receives the session's sandbox credentials. Shell access
   * cannot be tied to a prompt, a restored sandbox keeps whatever was changed on disk, and the
   * sandbox can spawn and prompt children on the owner's later prompts.
   */
  bindRevokePersonalForSandboxAccess(sessionId: string, userId: string): SqlStatement {
    return this.db
      .prepare(
        `UPDATE session_memory_manifests SET personal_reads_eligible = 0, personal_auto_save_eligible = 0
        WHERE session_id IN (
          WITH RECURSIVE tree(id) AS (
            SELECT id FROM sessions WHERE id = ?
            UNION
            SELECT child.id FROM sessions child JOIN tree ON child.parent_session_id = tree.id
          ) SELECT id FROM tree
        ) AND ${PERSONAL_ON_FOR_SOMEONE_ELSE}`
      )
      .bind(sessionId, userId);
  }

  /**
   * Load the pinned selection with live drift flags and renderable pinned revisions.
   * Sessions that predate memory get empty context; nonexistent sessions return null.
   * Callers must authorize the session and recheck shared-partition access before rendering.
   */
  async loadSelection(sessionId: string): Promise<PinnedSelection | null> {
    const [headers, rows] = await this.db.batch<ManifestRow | PinnedItemRow>([
      this.db
        .prepare("SELECT * FROM session_memory_manifests WHERE session_id = ?")
        .bind(sessionId),
      this.db
        .prepare(
          `SELECT i.memory_id, i.revision_id, i.scope_json, i.inclusion, i.estimated_tokens,
            m.partition_type, m.owner_user_id, m.repo_id, m.environment_id, m.current_revision_id, m.status,
            r.revision_number, r.memory_type, r.title, r.description,
            CASE WHEN i.inclusion = 'full' THEN r.content ELSE NULL END AS content
          FROM session_memory_items i JOIN memories m ON m.id = i.memory_id
          JOIN memory_revisions r ON r.id = i.revision_id AND r.memory_id = i.memory_id
          WHERE i.session_id = ? ORDER BY i.position`
        )
        .bind(sessionId),
    ]);
    const header = headers.results[0] as ManifestRow | undefined;
    if (!header) {
      const session = await this.db
        .prepare("SELECT created_at FROM sessions WHERE id = ?")
        .bind(sessionId)
        .first<{ created_at: number }>();
      if (!session) return null;
      const manifest = await emptySelection(session.created_at);
      return { selection: manifest, drift: [], entries: [] };
    }
    const items = rows.results as PinnedItemRow[];
    const manifest: SessionMemorySelection = {
      selectionVersion: header.selection_version,
      manifestSha256: header.manifest_sha256,
      resolvedAt: header.resolved_at,
      personalOwnerUserId: header.personal_owner_user_id,
      directiveChars: header.directive_chars,
      catalogChars: header.catalog_chars,
      estimatedTokens: header.estimated_tokens,
      omittedCount: header.omitted_count,
      items: items.map((row) => ({
        memoryId: row.memory_id,
        revisionId: row.revision_id,
        revisionNumber: row.revision_number,
        scope: memoryScopeSchema.parse(JSON.parse(row.scope_json)),
        memoryType: row.memory_type,
        title: row.title,
        inclusion: row.inclusion,
        estimatedTokens: row.estimated_tokens,
      })),
    };
    return {
      selection: manifest,
      drift: items.map((row) => ({
        revisedSinceSelection: row.current_revision_id !== row.revision_id,
        archivedSinceSelection: row.status === "archived",
      })),
      entries: items.map((row, index): PinnedMemoryEntry => {
        const base = {
          memoryId: row.memory_id,
          revisionId: row.revision_id,
          scope: manifest.items[index].scope,
          partition: partitionFromColumns(row),
          title: row.title,
        };
        return row.inclusion === "full"
          ? { ...base, inclusion: "full", content: row.content ?? "" }
          : { ...base, inclusion: "summary", description: row.description };
      }),
    };
  }

  /**
   * Load a session as memory operations see it, in one batch: its principal, harness, and
   * memory sources from the session row and repositories, plus the personal owner and personal
   * read and auto-save eligibility pinned in its manifest. The personal owner is dropped while
   * their current preference excludes personal memory or their account is suspended, so either
   * reaches existing sessions. Does not read selection items. Returns null for nonexistent
   * sessions.
   */
  async loadSession(sessionId: string): Promise<MemorySession | null> {
    const [sessions, repositories] = await this.db.batch([
      this.db
        .prepare(
          `SELECT s.user_id, s.owner_team_id, s.harness, s.repo_owner, s.repo_name, s.environment_id,
             s.parent_session_id,
             CASE WHEN COALESCE(p.include_personal_memories, 1) = 1 AND owner.suspended_at IS NULL
               THEN m.personal_owner_user_id END AS personal_owner_user_id,
             m.personal_reads_eligible, m.personal_auto_save_eligible
           FROM sessions s LEFT JOIN session_memory_manifests m ON m.session_id = s.id
           LEFT JOIN memory_preferences p ON p.user_id = m.personal_owner_user_id
           LEFT JOIN users owner ON owner.id = m.personal_owner_user_id
           WHERE s.id = ?`
        )
        .bind(sessionId),
      this.db
        .prepare(
          "SELECT repo_owner, repo_name, repo_id FROM session_repositories WHERE session_id = ? ORDER BY position"
        )
        .bind(sessionId),
    ]);
    const session = sessions.results[0] as
      | {
          user_id: string | null;
          owner_team_id: string | null;
          harness: HarnessId | null;
          repo_owner: string | null;
          repo_name: string | null;
          environment_id: string | null;
          parent_session_id: string | null;
          personal_owner_user_id: string | null;
          personal_reads_eligible: number | null;
          personal_auto_save_eligible: number | null;
        }
      | undefined;
    if (!session) return null;
    const repos = repositories.results as {
      repo_owner: string;
      repo_name: string;
      repo_id: number | null;
    }[];
    return {
      id: sessionId,
      principal: { userId: session.user_id, ownerTeamId: session.owner_team_id },
      sources: {
        personalOwnerUserId: session.personal_owner_user_id,
        environmentId: session.environment_id,
        repositories: repos.length
          ? repos.map((repo) => ({
              repoOwner: repo.repo_owner,
              repoName: repo.repo_name,
              repoId: repo.repo_id,
            }))
          : session.repo_owner && session.repo_name
            ? [{ repoOwner: session.repo_owner, repoName: session.repo_name, repoId: null }]
            : [],
      },
      harness: session.harness ?? DEFAULT_HARNESS,
      isChildSession: session.parent_session_id !== null,
      personalReadsEligible: session.personal_reads_eligible === 1,
      personalAutoSaveEligible: session.personal_auto_save_eligible === 1,
    };
  }

  async isPinned(sessionId: string, memoryId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 AS present FROM session_memory_items WHERE session_id = ? AND memory_id = ?"
      )
      .bind(sessionId, memoryId)
      .first();
    return row !== null;
  }
}
