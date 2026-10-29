import type {
  AdmissionPolicySnapshot,
  AdmissionRules,
} from "@open-inspect/shared/admission-settings";

export type AdmissionRuleType = keyof AdmissionRules;

/** Display order: individual people first, then groups. */
const RULE_TYPE_ORDER: readonly AdmissionRuleType[] = [
  "allowedEmails",
  "allowedGitHubUsers",
  "allowedEmailDomains",
  "allowedGitHubOrganizations",
];

/** Plain-language description of who a rule lets in. */
export function describeRule(type: AdmissionRuleType, value: string) {
  switch (type) {
    case "allowedEmails":
      return value;
    case "allowedEmailDomains":
      return `Anyone with an @${value} email`;
    case "allowedGitHubUsers":
      return `${value} on GitHub`;
    case "allowedGitHubOrganizations":
      return `Members of ${value} on GitHub`;
  }
}

export interface RuleCandidate {
  type: AdmissionRuleType;
  value: string;
}

/**
 * A GitHub profile or organization URL; only literal spaces may surround it, as
 * admissionRulesSchema trims those.
 */
const GITHUB_PROFILE_URL = /^ *(?:https?:\/\/)?(?:www\.)?github\.com\/(orgs\/)?([^/@\s]+)\/? *$/i;

/**
 * Rule types that free-form input could mean, most likely first. Emails and domains are
 * unambiguous; a bare name could be a GitHub user or organization, so both are offered.
 *
 * Only classifies: candidate values keep the raw input so admissionRulesSchema alone validates
 * and normalizes it. The sole extractions are a leading "@" and a GitHub URL's user or org name.
 */
export function detectRuleTypes(raw: string): RuleCandidate[] {
  const input = raw.trim();
  if (!input) return [];
  if (/^[^@\s]+@[^@\s]+$/.test(input)) return [{ type: "allowedEmails", value: raw }];
  const profile = raw.match(GITHUB_PROFILE_URL);
  if (profile?.[1]) return [{ type: "allowedGitHubOrganizations", value: profile[2] }];
  const name = profile?.[2] ?? raw.replace(/^(\s*)@/, "$1");
  if (name.includes(".")) return [{ type: "allowedEmailDomains", value: name }];
  return [
    { type: "allowedGitHubUsers", value: name },
    { type: "allowedGitHubOrganizations", value: name },
  ];
}

export interface AllowlistEntry {
  type: AdmissionRuleType;
  value: string;
  /** Granted by the deployment (environment / Terraform), so settings can't revoke it. */
  fromDeployment: boolean;
  /** Present in the settings draft, so it can be removed here. */
  inDraft: boolean;
  status: "saved" | "added" | "removed";
}

/** Every rule in one list, settings rules before deployment rules, with pending edits in place. */
export function allowlistEntries(
  snapshot: AdmissionPolicySnapshot,
  draft: AdmissionRules
): AllowlistEntry[] {
  const entries = RULE_TYPE_ORDER.flatMap((type) =>
    [...new Set([...snapshot.deployment[type], ...snapshot.managed[type], ...draft[type]])]
      .sort()
      .map((value): AllowlistEntry => {
        const inDraft = draft[type].includes(value);
        const saved = snapshot.managed[type].includes(value);
        return {
          type,
          value,
          fromDeployment: snapshot.deployment[type].includes(value),
          inDraft,
          status: inDraft && !saved ? "added" : !inDraft && saved ? "removed" : "saved",
        };
      })
  );
  return [
    ...entries.filter((entry) => !entry.fromDeployment),
    ...entries.filter((entry) => entry.fromDeployment),
  ];
}
