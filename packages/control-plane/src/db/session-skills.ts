import {
  sandboxSkillInstallationSchema,
  type SandboxSkillInstallation,
  type SessionSkillsView,
  skillAssignmentSchema,
} from "@open-inspect/shared/types/skills";
import { SkillStore } from "./skills";
import type { SqlDatabase } from "./sql-database";

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
      resolverVersion: 1,
      selection: this.selection(loaded.manifest),
      resolvedAt: loaded.manifest.resolved_at,
      skills: loaded.revisions.map((row) => this.resolvedSkill(row)),
    };
  }

  /**
   * Project the pinned snapshot into the narrow sandbox installation contract.
   * Persisted revisions fail closed if their generated SKILL.md is missing.
   */
  async getSandboxInstallation(sessionId: string): Promise<SandboxSkillInstallation | null> {
    const loaded = await this.load(sessionId);
    if (!loaded) return null;
    const skillStore = new SkillStore(this.db);
    const filesByRevision = await skillStore.filesForRevisions(
      loaded.revisions.map((row) => row.revision_id)
    );
    const installation = {
      schemaVersion: 1,
      manifestSha256: loaded.manifest.manifest_sha256,
      skills: loaded.revisions.map((row) => {
        const files = filesByRevision.get(row.revision_id);
        if (!files?.some((file) => file.path === "SKILL.md")) {
          throw new Error(`Missing files for session skill revision ${row.revision_id}`);
        }
        return { name: row.skill_name, files };
      }),
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
    sessionId: string
  ): Promise<{ manifest: ManifestRow; revisions: RevisionRow[] } | null> {
    const manifest = await this.db
      .prepare("SELECT * FROM session_skill_manifests WHERE session_id = ?")
      .bind(sessionId)
      .first<ManifestRow>();
    if (!manifest) return null;
    const revisions = await this.db
      .prepare("SELECT * FROM session_skill_revisions WHERE session_id = ? ORDER BY position")
      .bind(sessionId)
      .all<RevisionRow>();
    return { manifest, revisions: revisions.results ?? [] };
  }

  private selection(manifest: ManifestRow): SessionSkillsView["selection"] {
    if (manifest.resolver_version !== 1) {
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
