// Integration settings types

export type IntegrationId = "github";

/** Enforces the common shape for all integration configurations. */
export interface IntegrationEntry<TRepo extends object = Record<string, unknown>> {
  global: {
    enabledRepos?: string[];
    defaults?: TRepo;
  };
  repo: TRepo;
}

/** Overridable behavior settings for the GitHub bot. Used at both global (defaults) and per-repo (overrides) levels. */
export interface GitHubBotSettings {
  autoReviewOnOpen?: boolean;
  model?: string;
  reasoningEffort?: string;
}

/** Maps each integration ID to its global and per-repo settings types. */
export interface IntegrationSettingsMap {
  github: IntegrationEntry<GitHubBotSettings>;
}

/** Derived type for the GitHub bot global config. */
export type GitHubGlobalConfig = IntegrationSettingsMap["github"]["global"];

export const INTEGRATION_DEFINITIONS: {
  id: IntegrationId;
  name: string;
  description: string;
}[] = [
  {
    id: "github",
    name: "GitHub Bot",
    description: "Automated PR reviews and comment-triggered actions",
  },
];
