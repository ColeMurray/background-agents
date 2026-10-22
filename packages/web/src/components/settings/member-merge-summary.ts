import type { MemberIdentity, UserMergeCountKey } from "@open-inspect/shared/rbac";

/** What a merge does with the records behind one count. */
type CountEffect =
  /** Recognizable records that move to the kept account. */
  | { kind: "moved"; singular: string; plural: string }
  /** Authorship, settings, and other references that move to the kept account. */
  | { kind: "reattributed" }
  /** Records identical to ones the kept account has (same team, session, or sign-in), dropped. */
  | { kind: "duplicate" }
  /** Settings dropped because the kept account's own settings win. */
  | { kind: "replaced_setting"; label: string }
  /** Same-named skill profiles whose skills are combined into the kept account's profile. */
  | { kind: "combined_skill_profile" }
  /** Team memberships upgraded to lead because the merged-in account led the team. */
  | { kind: "team_lead_promotion" }
  /** Described elsewhere in the review, or internal bookkeeping. */
  | { kind: "detail" };

const moved = (singular: string, plural: string): CountEffect => ({
  kind: "moved",
  singular,
  plural,
});
const REATTRIBUTED: CountEffect = { kind: "reattributed" };
const DUPLICATE: CountEffect = { kind: "duplicate" };
const DETAIL: CountEffect = { kind: "detail" };

/**
 * Every count the merge API reports, classified explicitly. Typed as exhaustive so a new count
 * cannot reach administrators without someone deciding what it means.
 */
const COUNT_EFFECTS: Record<UserMergeCountKey, CountEffect> = {
  identitiesRepointed: moved("linked sign-in", "linked sign-ins"),
  sessionsRepointed: moved("session", "sessions"),
  automationsOwnedRepointed: moved("automation", "automations"),
  teamMembershipsRepointed: moved("team membership", "team memberships"),
  sessionCollaboratorsRepointed: moved("shared session", "shared sessions"),
  memoriesOwnedRepointed: moved("memory", "memories"),
  skillProfilesRepointed: moved("skill profile", "skill profiles"),
  scmTokensRepointed: moved("source control connection", "source control connections"),
  providerAccountAuthorizationsRepointed: moved(
    "model provider connection",
    "model provider connections"
  ),
  memoryAuthorsRepointed: REATTRIBUTED,
  memoryRevisionAuthorsRepointed: REATTRIBUTED,
  memoryDecidersRepointed: REATTRIBUTED,
  memoryArchiversRepointed: REATTRIBUTED,
  memoryManifestOwnersRepointed: REATTRIBUTED,
  memoryPreferencesRepointed: REATTRIBUTED,
  readStatesRepointed: REATTRIBUTED,
  automationsCreatedRepointed: REATTRIBUTED,
  providerAccountAuthorizationAttemptsRepointed: REATTRIBUTED,
  providerAccountsCreatedRepointed: REATTRIBUTED,
  providerAccountsUpdatedRepointed: REATTRIBUTED,
  providerAccountDefaultsCreatedRepointed: REATTRIBUTED,
  providerAccountDefaultsUpdatedRepointed: REATTRIBUTED,
  skillsCreatedRepointed: REATTRIBUTED,
  skillsUpdatedRepointed: REATTRIBUTED,
  skillRevisionsCreatedRepointed: REATTRIBUTED,
  skillAssignmentsCreatedRepointed: REATTRIBUTED,
  keyboardShortcutPreferencesRepointed: REATTRIBUTED,
  identitiesDeduped: DUPLICATE,
  readStatesDeduped: DUPLICATE,
  teamMembershipsDeduped: DUPLICATE,
  sessionCollaboratorsDeduped: DUPLICATE,
  memoryPreferencesDeduped: { kind: "replaced_setting", label: "memory preferences" },
  keyboardShortcutPreferencesDeduped: { kind: "replaced_setting", label: "keyboard shortcuts" },
  skillProfilesDeduped: { kind: "combined_skill_profile" },
  teamLeadRolesPromoted: { kind: "team_lead_promotion" },
  skillProfileItemsMerged: DETAIL,
  authSessionsDeleted: DETAIL,
  canonicalEmailBackfilled: DETAIL,
  roleAssignmentsRemoved: DETAIL,
  skillCatalogGenerationsAdvanced: DETAIL,
  auditEventsCreated: DETAIL,
  usersDeleted: DETAIL,
};

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** A readable account of what a merge moves, changes, drops, and ends. */
export interface MemberMergeSummary {
  /** Recognizable records that move to the kept account, e.g. "3 sessions". */
  readonly moves: string[];
  /** Other records whose authorship or ownership moves, e.g. who created a skill. */
  readonly otherRecords: number;
  /** Teams where the kept account becomes a lead: an access change. */
  readonly teamLeadPromotions: number;
  /** Same-named skill profiles combined into the kept account's profiles. */
  readonly combinedSkillProfiles: number;
  /** Settings of the merged-in account discarded in favor of the kept account's own. */
  readonly replacedSettings: string[];
  /** Records identical to ones the kept account already has, dropped. */
  readonly duplicates: number;
  /** Browser sign-ins of the removed account that end immediately. */
  readonly endedSignIns: number;
  /** Whether the kept account, having no email, takes the removed account's. */
  readonly emailCarriedOver: boolean;
}

/** Summarizes per-record merge counts into the lines an administrator reviews. */
export function summarizeMergeCounts(
  counts: Readonly<Record<UserMergeCountKey, number>>
): MemberMergeSummary {
  const moves: string[] = [];
  const replacedSettings: string[] = [];
  let otherRecords = 0;
  let duplicates = 0;
  let combinedSkillProfiles = 0;
  let teamLeadPromotions = 0;
  for (const [key, effect] of Object.entries(COUNT_EFFECTS) as [UserMergeCountKey, CountEffect][]) {
    const count = counts[key];
    if (count === 0) continue;
    switch (effect.kind) {
      case "moved":
        moves.push(plural(count, effect.singular, effect.plural));
        break;
      case "reattributed":
        otherRecords += count;
        break;
      case "duplicate":
        duplicates += count;
        break;
      case "replaced_setting":
        replacedSettings.push(effect.label);
        break;
      case "combined_skill_profile":
        combinedSkillProfiles += count;
        break;
      case "team_lead_promotion":
        teamLeadPromotions += count;
        break;
      case "detail":
        break;
    }
  }
  return {
    moves,
    otherRecords,
    teamLeadPromotions,
    combinedSkillProfiles,
    replacedSettings,
    duplicates,
    endedSignIns: counts.authSessionsDeleted,
    emailCarriedOver: counts.canonicalEmailBackfilled > 0,
  };
}

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  google: "Google",
  linear: "Linear",
  slack: "Slack",
};

/** Labels a linked identity, e.g. "GitHub · octocat" or "Slack". */
export function describeIdentity(identity: MemberIdentity): string {
  const provider = PROVIDER_LABELS[identity.provider] ?? identity.provider;
  const detail = identity.login ?? identity.email;
  return detail ? `${provider} · ${detail}` : provider;
}
