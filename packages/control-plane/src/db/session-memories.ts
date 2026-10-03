import { DEFAULT_HARNESS, type HarnessId } from "@open-inspect/shared/harnesses";
import {
  memoryScopeSchema,
  type MemoryInclusion,
  type MemoryStatus,
  type MemoryType,
  type SessionMemoryDiagnostics,
  type SessionMemoryManifest,
} from "@open-inspect/shared/types/memories";
import { partitionFromColumns, type PartitionColumns } from "../memory/partition";
import { emptyManifest } from "../memory/selection";
import type { PinnedMemoryEntry, SessionMemoryContext } from "../memory/types";
import type { Pinned } from "../session/pinned";
import { bulkInsertStatements } from "./bulk-insert";
import type { SqlDatabase, SqlStatement } from "./sql-database";

interface ManifestRow {
  selection_version: number;
  manifest_sha256: string;
  resolved_at: number;
  include_personal_memories: number;
  personal_owner_user_id: string | null;
  directive_chars: number;
  catalog_chars: number;
  estimated_tokens: number;
  truncated_count: number;
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

export interface LoadedSessionMemory {
  manifest: SessionMemoryManifest;
  /** The manifest plus live drift flags, for inspection only. */
  diagnostics: SessionMemoryDiagnostics;
  /** Pinned revisions to render; fact bodies are never loaded. */
  entries: PinnedMemoryEntry[];
}

/** Persist immutable session selections separately from live memory content and lifecycle state. */
export class SessionMemoryStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Statements that pin a session's selection, run in the session insert's atomic batch.
   * Resolved root sessions start eligible for personal auto-save only when private and
   * collaborator-free. Children copy the parent's owner and selection; eligibility is never
   * inherited, and a legacy parent without a manifest leaves the child with empty context.
   */
  bindPinned(sessionId: string, pinned: Pinned<SessionMemoryManifest>): SqlStatement[] {
    return pinned.kind === "resolved"
      ? this.bindInsert(sessionId, pinned.value)
      : this.bindCopy(sessionId, pinned.parentSessionId);
  }

  private bindInsert(sessionId: string, manifest: SessionMemoryManifest): SqlStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO session_memory_manifests
      (session_id, selection_version, manifest_sha256, resolved_at, include_personal_memories, personal_owner_user_id, directive_chars, catalog_chars, estimated_tokens, truncated_count, personal_auto_save_eligible)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN visibility = 'private' AND parent_session_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM session_collaborators WHERE session_id = sessions.id AND user_id <> sessions.user_id)
        THEN 1 ELSE 0 END FROM sessions WHERE id = ?`
        )
        .bind(
          sessionId,
          manifest.selectionVersion,
          manifest.manifestSha256,
          manifest.resolvedAt,
          manifest.includePersonalMemories ? 1 : 0,
          manifest.personalOwnerUserId,
          manifest.directiveChars,
          manifest.catalogChars,
          manifest.estimatedTokens,
          manifest.truncatedCount,
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

  private bindCopy(childId: string, parentId: string): SqlStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO session_memory_manifests
      (session_id, selection_version, manifest_sha256, resolved_at, include_personal_memories, personal_owner_user_id, directive_chars, catalog_chars, estimated_tokens, truncated_count)
      SELECT ?, selection_version, manifest_sha256, resolved_at, include_personal_memories, personal_owner_user_id, directive_chars, catalog_chars, estimated_tokens, truncated_count FROM session_memory_manifests WHERE session_id = ?`
        )
        .bind(childId, parentId),
      this.db
        .prepare(
          `INSERT INTO session_memory_items (session_id, position, memory_id, revision_id, scope_json, inclusion, estimated_tokens)
      SELECT ?, position, memory_id, revision_id, scope_json, inclusion, estimated_tokens FROM session_memory_items WHERE session_id = ? ORDER BY position`
        )
        .bind(childId, parentId),
    ];
  }

  /**
   * Permanently revoke personal auto-save once a session's audience widens, in the same batch
   * as that change. `addedUserId` skips revocation when the owner adds themselves.
   */
  bindRevokePersonalAutoSave(sessionId: string, addedUserId?: string): SqlStatement {
    return addedUserId === undefined
      ? this.db
          .prepare(
            "UPDATE session_memory_manifests SET personal_auto_save_eligible = 0 WHERE session_id = ?"
          )
          .bind(sessionId)
      : this.db
          .prepare(
            `UPDATE session_memory_manifests SET personal_auto_save_eligible = 0
        WHERE session_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND user_id <> ?)`
          )
          .bind(sessionId, sessionId, addedUserId);
  }

  /**
   * Load the pinned selection with live drift flags and renderable pinned revisions.
   * Sessions that predate memory get empty context; nonexistent sessions return null.
   * Callers must authorize the session and recheck shared-partition access before rendering.
   */
  async load(sessionId: string): Promise<LoadedSessionMemory | null> {
    const [headers, rows] = await this.db.batch<ManifestRow | PinnedItemRow>([
      this.db
        .prepare("SELECT * FROM session_memory_manifests WHERE session_id = ?")
        .bind(sessionId),
      this.db
        .prepare(
          `SELECT i.memory_id, i.revision_id, i.scope_json, i.inclusion, i.estimated_tokens,
            m.scope_type, m.scope_key, m.repo_owner, m.repo_name, m.current_revision_id, m.status,
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
      const manifest = await emptyManifest(session.created_at);
      return { manifest, diagnostics: { ...manifest, items: [] }, entries: [] };
    }
    const items = rows.results as PinnedItemRow[];
    const manifest: SessionMemoryManifest = {
      selectionVersion: header.selection_version,
      manifestSha256: header.manifest_sha256,
      resolvedAt: header.resolved_at,
      includePersonalMemories: header.include_personal_memories === 1,
      personalOwnerUserId: header.personal_owner_user_id,
      directiveChars: header.directive_chars,
      catalogChars: header.catalog_chars,
      estimatedTokens: header.estimated_tokens,
      truncatedCount: header.truncated_count,
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
      manifest,
      diagnostics: {
        ...manifest,
        items: manifest.items.map((item, index) => ({
          ...item,
          changed: items[index].current_revision_id !== item.revisionId,
          archived: items[index].status === "archived",
        })),
      },
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
   * Recover a session's memory context from its metadata and pinned personal owner (never the
   * owner's current preferences). Returns null for nonexistent sessions.
   */
  async context(sessionId: string): Promise<SessionMemoryContext | null> {
    const [sessions, repositories] = await this.db.batch([
      this.db
        .prepare(
          `SELECT s.user_id, s.owner_team_id, s.harness, s.repo_owner, s.repo_name, s.environment_id,
             s.parent_session_id, m.personal_owner_user_id, m.include_personal_memories,
             m.personal_auto_save_eligible
           FROM sessions s LEFT JOIN session_memory_manifests m ON m.session_id = s.id WHERE s.id = ?`
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
          include_personal_memories: number | null;
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
      sessionId,
      sessionUserId: session.user_id,
      ownerTeamId: session.owner_team_id,
      harness: session.harness ?? DEFAULT_HARNESS,
      inherited: session.parent_session_id !== null,
      personalAutoSave: session.personal_auto_save_eligible === 1,
      personalOwnerUserId:
        session.include_personal_memories === 1 ? session.personal_owner_user_id : null,
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
