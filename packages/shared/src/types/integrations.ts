// Integration settings types

export type IntegrationId = "github" | "linear" | "code-server" | "sandbox";

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
  allowedTriggerUsers?: string[];
  codeReviewInstructions?: string;
  commentActionInstructions?: string;
}

/** Overridable behavior settings for the Linear bot. Used at both global (defaults) and per-repo (overrides) levels. */
export interface LinearBotSettings {
  model?: string;
  reasoningEffort?: string;
  allowUserPreferenceOverride?: boolean;
  allowLabelModelOverride?: boolean;
  emitToolProgressActivities?: boolean;
  issueSessionInstructions?: string;
}

/** Overridable behavior settings for the code-server integration. */
export interface CodeServerSettings {
  enabled?: boolean;
}

/** Maximum number of tunnel ports a user can configure per sandbox. */
export const MAX_TUNNEL_PORTS = 10;

/** Sandbox environment settings. Provider-agnostic: describes what the user wants, not how it's done. */
export interface SandboxSettings {
  /** Extra ports to expose via tunnels (e.g., dev server ports 3000, 5173). */
  tunnelPorts?: number[];
  /** Enable a browser-based terminal (ttyd) in sandbox sessions. */
  terminalEnabled?: boolean;
}

/** Maps each integration ID to its global and per-repo settings types. */
export interface IntegrationSettingsMap {
  github: IntegrationEntry<GitHubBotSettings>;
  linear: IntegrationEntry<LinearBotSettings>;
  "code-server": IntegrationEntry<CodeServerSettings>;
  sandbox: IntegrationEntry<SandboxSettings>;
}

/** Derived type for the GitHub bot global config. */
export type GitHubGlobalConfig = IntegrationSettingsMap["github"]["global"];
export type LinearGlobalConfig = IntegrationSettingsMap["linear"]["global"];
export type CodeServerGlobalConfig = IntegrationSettingsMap["code-server"]["global"];
export type SandboxGlobalConfig = IntegrationSettingsMap["sandbox"]["global"];

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
  {
    id: "code-server",
    name: "Code Server",
    description: "Browser-based VS Code editor attached to sandbox sessions",
  },
  {
    id: "sandbox",
    name: "Sandbox",
    description: "Sandbox environment settings (tunnel ports, timeouts, etc.)",
  },
];
