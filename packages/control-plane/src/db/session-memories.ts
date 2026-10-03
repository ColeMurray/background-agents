import {
  memoryScopeSchema,
  type MemoryRecord,
  type SessionMemoryManifest,
  type SessionMemoryDiagnostics,
  type PinnedMemoryRevision,
  type MemorySearchInput,
} from "@open-inspect/shared/types/memories";
import {
  matchesMemoryTarget,
  resolveMemoryRecords,
  type MemoryTarget,
} from "../session/memory-resolution";
import { bulkInsertStatements } from "./bulk-insert";
import { MemoryStore, type MemoryRow } from "./memories";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import type { MemorySearchScope } from "./memory-search";

export class MemorySearchScopeError extends Error {}

interface ManifestRow {
  session_id: string;
  resolver_version: number;
  manifest_sha256: string;
  resolved_at: number;
  include_personal_memories: number;
  personal_owner_user_id: string | null;
  directive_chars: number;
  catalog_chars: number;
  estimated_tokens: number;
  truncated_count: number;
}
interface ItemRow extends MemoryRow {
  pinned_revision_id: string;
  pinned_memory_type: MemoryRecord["memoryType"];
  scope_json: string;
  inclusion: SessionMemoryManifest["items"][number]["inclusion"];
  estimated_tokens: number;
}

/** The tool's narrow response contract: live facts or body-free pinned archive notices. */
export type SessionMemoryRead = {
  scope: MemoryRecord["scope"];
  repoId: number | null;
  result:
    | { id: string; status: "archived"; archivedAt: number | null; reason: string | null }
    | (Pick<
        MemoryRecord,
        | "id"
        | "title"
        | "description"
        | "content"
        | "scope"
        | "revisionNumber"
        | "authorKind"
        | "authorUserId"
        | "authorSessionId"
      > & {
        status: "active";
        memoryType: "fact";
        revisionId: string;
      });
};

/** Persist immutable session selections separately from live memory content and lifecycle state. */
export class SessionMemoryStore {
  constructor(private readonly db: SqlDatabase) {}
  /**
   * Build statements to run after the session insert in the same atomic batch.
   * Only private, collaborator-free root sessions start eligible for personal fact auto-save.
   */
  bindInsert(sessionId: string, manifest: SessionMemoryManifest): SqlStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO session_memory_manifests
      (session_id, resolver_version, manifest_sha256, resolved_at, include_personal_memories, personal_owner_user_id, directive_chars, catalog_chars, estimated_tokens, truncated_count, personal_auto_save_eligible)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN visibility = 'private' AND parent_session_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM session_collaborators WHERE session_id = sessions.id AND user_id <> sessions.user_id)
        THEN 1 ELSE 0 END FROM sessions WHERE id = ?`
        )
        .bind(
          sessionId,
          manifest.resolverVersion,
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
  /**
   * Copy the parent's pinned owner/selection without resolving the child's participant catalog.
   * Run with the child session insert; auto-save eligibility is deliberately not inherited.
   * A legacy parent without a manifest leaves the child with the same empty-context fallback.
   */
  bindCopy(childId: string, parentId: string): SqlStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO session_memory_manifests
      (session_id, resolver_version, manifest_sha256, resolved_at, include_personal_memories, personal_owner_user_id, directive_chars, catalog_chars, estimated_tokens, truncated_count)
      SELECT ?, resolver_version, manifest_sha256, resolved_at, include_personal_memories, personal_owner_user_id, directive_chars, catalog_chars, estimated_tokens, truncated_count FROM session_memory_manifests WHERE session_id = ?`
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
   * Load pinned titles/directives plus live changed/archived diagnostics, never fact bodies.
   * Existing sessions without a manifest get empty context; nonexistent sessions return null.
   * Callers must authorize the session and check current shared-scope access before rendering.
   */
  async load(sessionId: string): Promise<{
    manifest: SessionMemoryManifest;
    diagnostics: SessionMemoryDiagnostics;
    revisions: PinnedMemoryRevision[];
  } | null> {
    const [headers, rows] = await this.db.batch<ManifestRow | ItemRow>([
      this.db
        .prepare("SELECT * FROM session_memory_manifests WHERE session_id = ?")
        .bind(sessionId),
      this.db
        .prepare(
          `SELECT m.*, r.title, r.description, CASE WHEN r.memory_type = 'directive' THEN r.content ELSE '' END AS content, r.revision_number, r.memory_type AS pinned_memory_type,
        i.revision_id AS pinned_revision_id, i.scope_json, i.inclusion, i.estimated_tokens
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
      const manifest = await resolveMemoryRecords([], {
        canonicalUserId: null,
        repositories: [],
        environmentId: null,
        includePersonalMemories: false,
      });
      const empty = { ...manifest, resolvedAt: session.created_at, items: [] };
      return { manifest: empty, diagnostics: empty, revisions: [] };
    }
    if (header.resolver_version !== 1) throw new Error("Unsupported memory resolver version");
    const items = rows.results as ItemRow[];
    const manifest: SessionMemoryManifest = {
      resolverVersion: header.resolver_version,
      manifestSha256: header.manifest_sha256,
      resolvedAt: header.resolved_at,
      includePersonalMemories: header.include_personal_memories === 1,
      personalOwnerUserId: header.personal_owner_user_id,
      directiveChars: header.directive_chars,
      catalogChars: header.catalog_chars,
      estimatedTokens: header.estimated_tokens,
      truncatedCount: header.truncated_count,
      items: items.map((row) => ({
        memoryId: row.id,
        revisionId: row.pinned_revision_id,
        revisionNumber: row.revision_number,
        scope: memoryScopeSchema.parse(JSON.parse(row.scope_json)),
        memoryType: row.pinned_memory_type,
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
      revisions: items.map((row, index) => ({
        memoryId: row.id,
        revisionId: row.pinned_revision_id,
        memoryType: row.pinned_memory_type,
        scope: manifest.items[index].scope,
        repoId: row.repo_id,
        title: row.title,
        description: row.description,
        content: row.content,
      })),
    };
  }

  /** Recover tool scope from session metadata and the pinned personal owner, not current preferences. */
  async target(sessionId: string): Promise<(MemoryTarget & { inherited: boolean }) | null> {
    const session = await this.db
      .prepare(
        `SELECT s.repo_owner, s.repo_name, s.environment_id, s.parent_session_id,
           m.personal_owner_user_id, m.include_personal_memories
         FROM sessions s LEFT JOIN session_memory_manifests m ON m.session_id = s.id WHERE s.id = ?`
      )
      .bind(sessionId)
      .first<{
        personal_owner_user_id: string | null;
        include_personal_memories: number | null;
        repo_owner: string | null;
        repo_name: string | null;
        environment_id: string | null;
        parent_session_id: string | null;
      }>();
    if (!session) return null;
    const repositories = (
      await this.db
        .prepare(
          "SELECT repo_owner, repo_name, repo_id FROM session_repositories WHERE session_id = ? ORDER BY position"
        )
        .bind(sessionId)
        .all<{ repo_owner: string; repo_name: string; repo_id: number | null }>()
    ).results;
    return {
      inherited: session.parent_session_id !== null,
      canonicalUserId: session.personal_owner_user_id,
      includePersonalMemories: session.include_personal_memories === 1,
      environmentId: session.environment_id,
      repositories: repositories.length
        ? repositories.map((repo) => ({
            repoOwner: repo.repo_owner,
            repoName: repo.repo_name,
            repoId: repo.repo_id,
          }))
        : session.repo_owner && session.repo_name
          ? [{ repoOwner: session.repo_owner, repoName: session.repo_name, repoId: null }]
          : [],
    };
  }
  /** Resolve only session-relative identities; explicit unavailable scopes fail closed. */
  async searchScopes(
    sessionId: string,
    input: MemorySearchInput
  ): Promise<MemorySearchScope[] | null> {
    const target = await this.target(sessionId);
    if (!target) return null;
    const scopes: MemorySearchScope[] = [];
    if (!input.scope || input.scope === "personal") {
      if (target.includePersonalMemories && target.canonicalUserId)
        scopes.push({
          scope: { type: "personal" },
          ownerUserId: target.canonicalUserId,
          repoId: null,
          ...(target.inherited ? { personalSessionId: sessionId } : {}),
        });
      else if (input.scope)
        throw new MemorySearchScopeError("Personal memory is excluded from this session");
    }
    if (!input.scope || input.scope === "repository") {
      const repositories =
        input.repoOwner === undefined
          ? target.repositories
          : target.repositories.filter(
              (repo) =>
                repo.repoOwner.toLowerCase() === input.repoOwner &&
                repo.repoName.toLowerCase() === input.repoName
            );
      if (input.scope && !repositories.length)
        throw new MemorySearchScopeError("Repository is outside this session");
      for (const repo of repositories) {
        if (repo.repoId === null || repo.repoId <= 0)
          throw new MemorySearchScopeError("Repository identity is unavailable");
        scopes.push({
          scope: { type: "repository", repoOwner: repo.repoOwner, repoName: repo.repoName },
          ownerUserId: null,
          repoId: repo.repoId,
        });
      }
    }
    if (!input.scope || input.scope === "environment") {
      if (target.environmentId)
        scopes.push({
          scope: { type: "environment", environmentId: target.environmentId },
          ownerUserId: null,
          repoId: null,
        });
      else if (input.scope)
        throw new MemorySearchScopeError("This session has no associated environment");
    }
    return scopes;
  }
  /**
   * Expand active facts in the current target; directives are never live-expandable.
   * Pinned archives yield a body-free notice. Proposals, unpinned archives, opt-out,
   * and unpinned personal reads from children are concealed. Callers recheck shared grants.
   */
  async read(sessionId: string, memoryId: string): Promise<SessionMemoryRead | null> {
    const [target, pinned, record] = await Promise.all([
      this.target(sessionId),
      this.db
        .prepare(
          "SELECT 1 AS present FROM session_memory_items WHERE session_id = ? AND memory_id = ?"
        )
        .bind(sessionId, memoryId)
        .first(),
      new MemoryStore(this.db).get(memoryId),
    ]);
    if (!target || !record || record.status === "proposed") return null;
    if (record.scope.type === "personal" && !target.includePersonalMemories) return null;
    if (!pinned && record.scope.type === "personal" && target.inherited) return null;
    const access = { scope: record.scope, repoId: record.repoId ?? null };
    if (record.status === "archived")
      return pinned
        ? {
            ...access,
            result: {
              id: record.id,
              status: "archived",
              archivedAt: record.archivedAt,
              reason: record.archiveReason,
            },
          }
        : null;
    if (record.memoryType !== "fact" || !matchesMemoryTarget(record, target)) return null;
    return {
      ...access,
      result: {
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
      },
    };
  }
}
