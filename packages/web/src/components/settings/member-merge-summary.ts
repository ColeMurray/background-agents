import type { MemberIdentity } from "@open-inspect/shared/rbac";

interface CountGroup {
  readonly keys: readonly string[];
  readonly singular: string;
  readonly plural: string;
}

/** Records an administrator recognizes, in the order the preview lists them. */
const COUNT_GROUPS: readonly CountGroup[] = [
  { keys: ["identitiesRepointed"], singular: "linked sign-in", plural: "linked sign-ins" },
  { keys: ["sessionsRepointed"], singular: "session", plural: "sessions" },
  { keys: ["automationsOwnedRepointed"], singular: "automation", plural: "automations" },
  {
    keys: ["teamMembershipsRepointed"],
    singular: "team membership",
    plural: "team memberships",
  },
  {
    keys: ["sessionCollaboratorsRepointed"],
    singular: "shared session",
    plural: "shared sessions",
  },
  { keys: ["memoriesOwnedRepointed"], singular: "memory", plural: "memories" },
  { keys: ["skillProfilesRepointed"], singular: "skill profile", plural: "skill profiles" },
  {
    keys: ["scmTokensRepointed"],
    singular: "source control connection",
    plural: "source control connections",
  },
  {
    keys: ["providerAccountAuthorizationsRepointed"],
    singular: "model provider connection",
    plural: "model provider connections",
  },
];

/** Merge bookkeeping that is described separately or not at all. */
const UNLISTED_KEYS = new Set([
  "authSessionsDeleted",
  "auditEventsCreated",
  "canonicalEmailBackfilled",
  "roleAssignmentsRemoved",
  "skillCatalogGenerationsAdvanced",
  "usersDeleted",
]);

const GROUPED_KEYS = new Set(COUNT_GROUPS.flatMap((group) => group.keys));

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** A readable account of what a merge moves, skips, and ends. */
export interface MemberMergeSummary {
  /** Recognizable records that move to the kept member, e.g. "3 sessions". */
  readonly moves: string[];
  /** Other records whose ownership or attribution moves, e.g. who created a skill. */
  readonly otherRecords: number;
  /** Source records dropped because the kept member already has the same one. */
  readonly duplicates: number;
  /** Browser sign-ins of the removed member that end immediately. */
  readonly endedSignIns: number;
  /** Whether the kept member, having no email, takes the removed member's. */
  readonly emailCarriedOver: boolean;
}

/** Summarizes per-table merge counts into the lines an administrator reviews. */
export function summarizeMergeCounts(counts: Readonly<Record<string, number>>): MemberMergeSummary {
  const moves = COUNT_GROUPS.flatMap((group) => {
    const total = group.keys.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
    return total > 0 ? [plural(total, group.singular, group.plural)] : [];
  });
  let otherRecords = 0;
  let duplicates = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (GROUPED_KEYS.has(key) || UNLISTED_KEYS.has(key)) continue;
    if (key.endsWith("Deduped")) duplicates += count;
    else otherRecords += count;
  }
  return {
    moves,
    otherRecords,
    duplicates,
    endedSignIns: counts.authSessionsDeleted ?? 0,
    emailCarriedOver: (counts.canonicalEmailBackfilled ?? 0) > 0,
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
