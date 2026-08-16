import {
  MAX_MANAGED_SKILLS_PER_SESSION,
  MAX_MANAGED_SKILL_MANIFEST_BYTES,
  type ResolvedSkill,
  type SessionSkillManifestSelection,
  type SessionSkillSelection,
} from "@open-inspect/shared/types/skills";
import { SkillProfileStore } from "../db/skill-profiles";
import { SkillStore } from "../db/skills";
import type { SqlDatabase } from "../db/sql-database";
import { hashSessionSkillManifest, SKILL_RESOLVER_VERSION } from "../skills/content-addressing";

const MAX_CATALOG_READ_ATTEMPTS = 3;

/** Immutable resolver output persisted with a session before sandbox creation. */
export interface SessionSkillManifestInput {
  selection: SessionSkillManifestSelection;
  resolverVersion: number;
  manifestSha256: string;
  resolvedAt: number;
  skills: ResolvedSkill[];
  ignoredProfileSkillIds?: string[];
}

interface SkillResolutionTarget {
  repositories: readonly { repoOwner: string; repoName: string }[];
  environmentId: string | null;
}

/**
 * Resolve the mutable catalog into a deterministic session snapshot. Generation
 * checks retry concurrent catalog changes so the returned digest never mixes
 * rows from different catalog states.
 */
export async function resolveManagedSkills(
  db: SqlDatabase,
  target: SkillResolutionTarget,
  selection: SessionSkillSelection,
  canonicalUserId: string | null
): Promise<SessionSkillManifestInput> {
  const skills = new SkillStore(db);
  const profiles = new SkillProfileStore(db);

  for (let attempt = 0; attempt < MAX_CATALOG_READ_ATTEMPTS; attempt++) {
    const generationBefore = await skills.catalogGeneration();
    const applicable = await skills.listApplicable(target);
    let manifestSelection: SessionSkillManifestSelection;
    let selectedIds: Set<string> | null;
    if (selection.mode === "profile") {
      if (!canonicalUserId)
        throw new SkillResolutionError("A canonical user is required for profiles", 403);
      const profile = await profiles.getOwned(selection.profileId, canonicalUserId);
      if (!profile) throw new SkillResolutionError("Skill profile not found", 404);
      manifestSelection = {
        mode: "profile",
        profileId: profile.id,
        profileName: profile.name,
      };
      selectedIds = new Set(profile.skillIds);
    } else {
      manifestSelection = selection;
      selectedIds = selection.mode === "none" ? new Set() : null;
    }

    // Profiles filter the already-applicable set; membership never bypasses
    // disabled state or repository/environment assignment scope.
    const resolved = applicable
      .filter((skill) => selectedIds === null || selectedIds.has(skill.id))
      .map<ResolvedSkill>((skill) => ({
        skillId: skill.id,
        revisionId: skill.currentRevisionId,
        name: skill.name,
        description: skill.description,
        revisionNumber: skill.revisionNumber,
        revisionSha256: skill.revisionSha256,
        totalBytes: skill.totalBytes,
        assignmentSources: skill.assignments,
      }));
    const applicableIds = new Set(applicable.map((skill) => skill.id));
    const ignoredProfileSkillIds =
      selectedIds === null ? [] : [...selectedIds].filter((id) => !applicableIds.has(id)).sort();
    const generationAfter = await skills.catalogGeneration();
    if (generationBefore !== generationAfter) continue;
    enforceManifestLimits(resolved);

    return {
      selection: manifestSelection,
      resolverVersion: SKILL_RESOLVER_VERSION,
      manifestSha256: await hashSessionSkillManifest(manifestSelection, resolved),
      resolvedAt: Date.now(),
      skills: resolved,
      ignoredProfileSkillIds,
    };
  }
  throw new SkillResolutionError("Managed skills catalog changed during resolution", 409);
}

function enforceManifestLimits(skills: ResolvedSkill[]): void {
  if (skills.length > MAX_MANAGED_SKILLS_PER_SESSION) {
    throw new SkillResolutionError(
      `Managed skill selection exceeds the ${MAX_MANAGED_SKILLS_PER_SESSION} skill limit`,
      400
    );
  }
  const totalBytes = skills.reduce((total, skill) => total + skill.totalBytes, 0);
  if (totalBytes > MAX_MANAGED_SKILL_MANIFEST_BYTES) {
    throw new SkillResolutionError("Managed skill selection exceeds the content size limit", 400);
  }
}

export class SkillResolutionError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}
