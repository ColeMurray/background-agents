import type { SandboxSkillManifest, SkillAssignment } from "@open-inspect/shared/types/skills";
import { SkillStore } from "./skills";
import type { SqlDatabase } from "./sql-database";

interface ManifestRow {
  session_id: string;
  selection_mode: "all" | "none" | "profile";
  profile_id: string | null;
  profile_name: string | null;
  resolver_version: number;
  manifest_sha256: string;
  resolved_at: number;
  activation_status: "pending" | "activated" | "failed";
  activated_at: number | null;
  activation_error_code: string | null;
  activation_error: string | null;
}

interface RevisionRow {
  position: number;
  skill_id: string;
  revision_id: string;
  skill_name: string;
  description: string;
  revision_number: number;
  content_sha256: string;
  total_bytes: number;
  assignment_sources: string;
}

export interface HumanSessionSkills {
  manifestSha256: string;
  resolverVersion: number;
  selection: SandboxSkillManifest["selection"];
  resolvedAt: number;
  activation: {
    status: "pending" | "activated" | "failed";
    activatedAt: number | null;
    errorCode: string | null;
    message: string | null;
  };
  skills: Omit<SandboxSkillManifest["skills"][number], "files">[];
}

interface SkillActivationInput {
  manifestSha256: string;
  status: "activated" | "failed";
  errorCode?: string;
  message?: string;
}

export class SessionSkillStore {
  constructor(private readonly db: SqlDatabase) {}

  async getHumanManifest(sessionId: string): Promise<HumanSessionSkills | null> {
    const loaded = await this.load(sessionId);
    if (!loaded) return null;
    return {
      manifestSha256: loaded.manifest.manifest_sha256,
      resolverVersion: loaded.manifest.resolver_version,
      selection: this.selection(loaded.manifest),
      resolvedAt: loaded.manifest.resolved_at,
      activation: {
        status: loaded.manifest.activation_status,
        activatedAt: loaded.manifest.activated_at,
        errorCode: loaded.manifest.activation_error_code,
        message: loaded.manifest.activation_error,
      },
      skills: loaded.revisions.map((row) => this.resolvedSkill(row)),
    };
  }

  async getSandboxManifest(sessionId: string): Promise<SandboxSkillManifest | null> {
    const loaded = await this.load(sessionId);
    if (!loaded) return null;
    const skillStore = new SkillStore(this.db);
    return {
      schemaVersion: 1,
      resolverVersion: loaded.manifest.resolver_version as 1,
      manifestSha256: loaded.manifest.manifest_sha256,
      selection: this.selection(loaded.manifest),
      skills: await Promise.all(
        loaded.revisions.map(async (row) => ({
          ...this.resolvedSkill(row),
          files: await skillStore.filesForRevision(row.revision_id),
        }))
      ),
    };
  }

  async reportActivation(
    sessionId: string,
    input: SkillActivationInput
  ): Promise<"updated" | "unchanged" | "not_found" | "digest_mismatch"> {
    const current = await this.db
      .prepare("SELECT * FROM session_skill_manifests WHERE session_id = ?")
      .bind(sessionId)
      .first<ManifestRow>();
    if (!current) return "not_found";
    if (current.manifest_sha256 !== input.manifestSha256) return "digest_mismatch";
    if (current.activation_status === input.status) return "unchanged";
    const result = await this.db
      .prepare(
        `UPDATE session_skill_manifests
         SET activation_status = ?, activated_at = ?, activation_error_code = ?, activation_error = ?
         WHERE session_id = ? AND manifest_sha256 = ?`
      )
      .bind(
        input.status,
        input.status === "activated" ? Date.now() : null,
        input.status === "failed" ? (input.errorCode ?? null) : null,
        input.status === "failed" ? sanitizeMessage(input.message) : null,
        sessionId,
        input.manifestSha256
      )
      .run();
    return result.meta.changes > 0 ? "updated" : "unchanged";
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

  private selection(manifest: ManifestRow): SandboxSkillManifest["selection"] {
    return manifest.selection_mode === "profile"
      ? {
          mode: "profile",
          profileId: manifest.profile_id!,
          profileName: manifest.profile_name!,
        }
      : { mode: manifest.selection_mode };
  }

  private resolvedSkill(row: RevisionRow) {
    return {
      skillId: row.skill_id,
      revisionId: row.revision_id,
      name: row.skill_name,
      description: row.description,
      revisionNumber: row.revision_number,
      contentSha256: row.content_sha256,
      totalBytes: row.total_bytes,
      assignmentSources: JSON.parse(row.assignment_sources) as SkillAssignment[],
    };
  }
}

function sanitizeMessage(message: string | undefined): string | null {
  if (!message) return null;
  return Array.from(message)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("")
    .slice(0, 1000);
}
