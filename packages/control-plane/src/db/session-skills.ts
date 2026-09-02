import {
  sandboxSkillInstallationSchema,
  type SandboxSkillInstallation,
  type SessionSkillsView,
  skillAssignmentSchema,
} from "@open-inspect/shared/types/skills";
import { hashSessionSkillManifest, SKILL_RESOLVER_VERSION } from "../skills/content-addressing";
import { SkillStore } from "./skills";
import type { SqlDatabase } from "./sql-database";

const LEGACY_SESSION_SKILL_SELECTION = { mode: "all" as const };

/** Snapshot rows preserve resolution-time provenance independently of the mutable catalog. */
interface ManifestRow {
  session_id: string;
  selection_mode: "all" | "none" | "profile";
  profile_id: string | null;
  profile_name: string | null;
  resolver_version: number;
  manifest_sha256: string;
  resolved_at: number;
}

interface RevisionRow {
  position: number;
  skill_id: string;
  revision_id: string;
  skill_name: string;
  description: string;
  revision_number: number;
  revision_sha256: string;
  total_bytes: number;
  assignment_sources: string;
}

export class SessionSkillStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Return selection and revision provenance without installation file contents. */
  async getSessionSkillsView(sessionId: string): Promise<SessionSkillsView | null> {
    const loaded = await this.load(sessionId);
    if (!loaded) return null;
    return {
      manifestSha256: loaded.manifest.manifest_sha256,
      resolverVersion: SKILL_RESOLVER_VERSION,
      selection: this.selection(loaded.manifest),
      resolvedAt: loaded.manifest.resolved_at,
      skills: loaded.revisions.map((row) => this.resolvedSkill(row)),
    };
  }

  /**
   * Project the pinned snapshot into the narrow sandbox installation contract.
   * Persisted revisions fail closed if their generated SKILL.md is missing.
   *
   * `page` narrows the response to one window of manifest positions. Pinned
   * revisions are immutable, so paging by position is stable and every page
   * carries the same `manifestSha256`; omitting `page` returns the whole
   * installation, which is the contract older sandbox runtimes expect.
   */
  async getSandboxInstallation(
    sessionId: string,
    page?: { after: number; limit: number }
  ): Promise<SandboxSkillInstallation | null> {
    // One extra row distinguishes "page is full" from "more remain" without a
    // second count query.
    const loaded = await this.load(sessionId, page && { ...page, limit: page.limit + 1 });
    if (!loaded) return null;
    const hasMore = page !== undefined && loaded.revisions.length > page.limit;
    const revisions = hasMore ? loaded.revisions.slice(0, page.limit) : loaded.revisions;
    const filesByRevision = await new SkillStore(this.db).filesForSessionRevisions(sessionId, page);
    const installation = {
      schemaVersion: 1,
      manifestSha256: loaded.manifest.manifest_sha256,
      skills: revisions.map((row) => {
        const files = filesByRevision.get(row.revision_id);
        if (!files?.some((file) => file.path === "SKILL.md")) {
          throw new Error(`Missing files for session skill revision ${row.revision_id}`);
        }
        return { name: row.skill_name, files };
      }),
      nextCursor: hasMore ? String(revisions[revisions.length - 1]?.position) : null,
    };
    const parsed = sandboxSkillInstallationSchema.safeParse(installation);
    if (!parsed.success) {
      throw new Error(
        `Invalid persisted sandbox skill installation: ${parsed.error.issues[0]?.message}`
      );
    }
    return parsed.data;
  }

  private async load(
    sessionId: string,
    page?: { after: number; limit: number }
  ): Promise<{ manifest: ManifestRow; revisions: RevisionRow[] } | null> {
    let manifest = await this.db
      .prepare("SELECT * FROM session_skill_manifests WHERE session_id = ?")
      .bind(sessionId)
      .first<ManifestRow>();
    if (!manifest) {
      const session = await this.db
        .prepare("SELECT created_at FROM sessions WHERE id = ?")
        .bind(sessionId)
        .first<{ created_at: number }>();
      if (!session) return null;
      manifest = {
        session_id: sessionId,
        selection_mode: LEGACY_SESSION_SKILL_SELECTION.mode,
        profile_id: null,
        profile_name: null,
        resolver_version: SKILL_RESOLVER_VERSION,
        manifest_sha256: await hashSessionSkillManifest(LEGACY_SESSION_SKILL_SELECTION, []),
        resolved_at: session.created_at,
      };
    }
    const revisions = await this.db
      .prepare(
        page
          ? `SELECT * FROM session_skill_revisions
             WHERE session_id = ? AND position > ? ORDER BY position LIMIT ?`
          : "SELECT * FROM session_skill_revisions WHERE session_id = ? ORDER BY position"
      )
      .bind(...(page ? [sessionId, page.after, page.limit] : [sessionId]))
      .all<RevisionRow>();
    return { manifest, revisions: revisions.results ?? [] };
  }

  private selection(manifest: ManifestRow): SessionSkillsView["selection"] {
    if (manifest.resolver_version !== SKILL_RESOLVER_VERSION) {
      throw new Error(`Unsupported managed skill resolver version: ${manifest.resolver_version}`);
    }
    if (manifest.selection_mode === "profile") {
      if (!manifest.profile_id || !manifest.profile_name) {
        throw new Error("Invalid profile selection: profile id and name are required");
      }
      return {
        mode: "profile",
        profileId: manifest.profile_id,
        profileName: manifest.profile_name,
      };
    }
    if (manifest.profile_id !== null || manifest.profile_name !== null) {
      throw new Error("Invalid non-profile selection: profile fields must be null");
    }
    return { mode: manifest.selection_mode };
  }

  private resolvedSkill(row: RevisionRow) {
    let assignmentSources: SessionSkillsView["skills"][number]["assignmentSources"];
    try {
      assignmentSources = skillAssignmentSchema.array().parse(JSON.parse(row.assignment_sources));
    } catch {
      throw new Error(`Invalid assignment sources for session skill revision ${row.revision_id}`);
    }
    return {
      skillId: row.skill_id,
      revisionId: row.revision_id,
      name: row.skill_name,
      description: row.description,
      revisionNumber: row.revision_number,
      revisionSha256: row.revision_sha256,
      totalBytes: row.total_bytes,
      assignmentSources,
    };
  }
}
