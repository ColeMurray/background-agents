// Integration settings types

export type IntegrationId = "github" | "linear" | "code-server" | "sandbox" | "slack";

/** Enforces the common shape for all integration configurations. */
export interface IntegrationEntry<
  TRepo extends object = Record<string, unknown>,
  TGlobalDefaults extends object = TRepo,
> {
  global: {
    enabledRepos?: string[];
    defaults?: TGlobalDefaults;
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

/** Default maximum active agent-spawned child sessions per parent session. */
export const DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS = 5;

/** Default maximum agent-spawned child sessions per parent session. */
export const DEFAULT_MAX_TOTAL_CHILD_SESSIONS = 15;

/** Repo image/runtime profile that changes the base sandbox image requirements. */
export type SandboxImageProfile = "default" | "docker";

export const DEFAULT_SANDBOX_IMAGE_PROFILE: SandboxImageProfile = "default";

export function isSandboxImageProfile(value: unknown): value is SandboxImageProfile {
  return value === DEFAULT_SANDBOX_IMAGE_PROFILE || value === "docker";
}

/** Sandbox environment settings. Provider-agnostic: describes what the user wants, not how it's done. */
export interface SandboxSettings {
  /** Extra ports to expose via tunnels (e.g., dev server ports 3000, 5173). */
  tunnelPorts?: number[];
  /** Enable a browser-based terminal (ttyd) in sandbox sessions. */
  terminalEnabled?: boolean;
  /** Enable Docker Engine and Docker Compose inside Modal-backed sandboxes. */
  dockerEnabled?: boolean;
  /** Maximum active agent-spawned child sessions per parent session. */
  maxConcurrentChildSessions?: number;
  /** Maximum total agent-spawned child sessions per parent session. */
  maxTotalChildSessions?: number;
}

/** Runtime settings passed to sandbox providers. Excludes control-plane-only limits. */
export type SandboxRuntimeSettings = Pick<
  SandboxSettings,
  "tunnelPorts" | "terminalEnabled" | "dockerEnabled"
>;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function normalizeTunnelPorts(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value
    .filter((port): port is number => isPositiveInteger(port) && port <= 65535)
    .slice(0, MAX_TUNNEL_PORTS);
}

export function normalizeSandboxRuntimeSettings(value: unknown): SandboxRuntimeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const settings = value as Record<string, unknown>;
  const normalized: SandboxRuntimeSettings = {};
  const tunnelPorts = normalizeTunnelPorts(settings.tunnelPorts);

  if (tunnelPorts !== undefined) {
    normalized.tunnelPorts = tunnelPorts;
  }
  if (typeof settings.terminalEnabled === "boolean") {
    normalized.terminalEnabled = settings.terminalEnabled;
  }
  if (typeof settings.dockerEnabled === "boolean") {
    normalized.dockerEnabled = settings.dockerEnabled;
  }

  return normalized;
}

export function resolveSandboxImageProfile(
  settings: Pick<SandboxRuntimeSettings, "dockerEnabled"> | null | undefined
): SandboxImageProfile {
  return settings?.dockerEnabled === true ? "docker" : DEFAULT_SANDBOX_IMAGE_PROFILE;
}

export type SlackMentionsPolicy = "allow" | "escape" | "strip";

/** Per-repo Slack overrides. Mentions policy is workspace-wide and cannot be overridden per repo. */
export interface SlackRepoSettings {
  agentNotificationsEnabled?: boolean;
}

/** Global Slack defaults: per-repo fields plus workspace-wide policy controls. */
export interface SlackGlobalSettings extends SlackRepoSettings {
  mentionsPolicy?: SlackMentionsPolicy;
}

/** Maps each integration ID to its global and per-repo settings types. */
export interface IntegrationSettingsMap {
  github: IntegrationEntry<GitHubBotSettings>;
  linear: IntegrationEntry<LinearBotSettings>;
  "code-server": IntegrationEntry<CodeServerSettings>;
  sandbox: IntegrationEntry<SandboxSettings>;
  slack: IntegrationEntry<SlackRepoSettings, SlackGlobalSettings>;
}

/** Derived type for the GitHub bot global config. */
export type GitHubGlobalConfig = IntegrationSettingsMap["github"]["global"];
export type LinearGlobalConfig = IntegrationSettingsMap["linear"]["global"];
export type CodeServerGlobalConfig = IntegrationSettingsMap["code-server"]["global"];
export type SandboxGlobalConfig = IntegrationSettingsMap["sandbox"]["global"];
export type SlackGlobalConfig = IntegrationSettingsMap["slack"]["global"];

/** Full MCP server config with decrypted credentials. Internal use only. */
export interface McpServerConfig {
  id: string;
  name: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  repoScopes?: string[] | null;
  enabled: boolean;
}

/** MCP server metadata for API responses — no decrypted credentials. */
export interface McpServerMetadata {
  id: string;
  name: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  hasEnv: boolean;
  hasHeaders: boolean;
  repoScopes?: string[] | null;
  enabled: boolean;
}

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
  {
    id: "slack",
    name: "Slack",
    description: "Agent-driven Slack notifications and mention policy",
  },
];
