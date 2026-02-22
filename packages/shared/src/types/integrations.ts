// Integration settings types

export type IntegrationId = "github" | "linear";

/** Enforces the common shape for all integration configurations. */
export interface IntegrationEntry<TRepo extends object = Record<string, unknown>> {
  global: {
    enabledRepos?: string[];
    allowedTriggerUsers?: string[];
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

/** Overridable behavior settings for the Linear bot. Used at both global (defaults) and per-repo (overrides) levels. */
export interface LinearBotSettings {
  model?: string;
  reasoningEffort?: string;
  allowUserPreferenceOverride?: boolean;
  allowLabelModelOverride?: boolean;
  emitToolProgressActivities?: boolean;
}

/** Maps each integration ID to its global and per-repo settings types. */
export interface IntegrationSettingsMap {
  github: IntegrationEntry<GitHubBotSettings>;
  linear: IntegrationEntry<LinearBotSettings>;
}

/** Derived type for the GitHub bot global config. */
export type GitHubGlobalConfig = IntegrationSettingsMap["github"]["global"];
export type LinearGlobalConfig = IntegrationSettingsMap["linear"]["global"];

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
  {
    id: "linear",
    name: "Linear Agent",
    description: "Issue-driven coding sessions from Linear agent mentions",
  },
];
