// Integration settings types

import { escapeRegExp } from "../regex";

/** Third-party integrations, each surfaced as a card in the Integrations settings list. */
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

/**
 * Source-control (SCM) behavior settings.
 *
 * Provider-agnostic: applies to both GitHub and GitLab.
 */
export interface ScmSettings {
  /** Always open pull/merge requests created by sessions as drafts. */
  alwaysUseDraftMode?: boolean;
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

/**
 * Default port code-server binds to inside the sandbox. Mirrors
 * `CODE_SERVER_PORT` in `packages/sandbox-runtime/src/sandbox_runtime/constants.py`.
 */
export const DEFAULT_CODE_SERVER_PORT = 8080;

/**
 * Default port the web terminal (ttyd) proxy is exposed on. Mirrors
 * `TTYD_PROXY_PORT` in `packages/sandbox-runtime/src/sandbox_runtime/constants.py`.
 */
export const DEFAULT_TERMINAL_PORT = 7680;

/**
 * Internal ttyd port (localhost-only, behind the proxy). Reserved: it is never
 * exposed and cannot be chosen as a code-server, terminal, or tunnel port.
 * Mirrors `TTYD_PORT` in `packages/sandbox-runtime/src/sandbox_runtime/constants.py`.
 */
export const INTERNAL_TTYD_PORT = 7681;

/** A configured sandbox port plus where it came from, for conflict diagnostics. */
export interface ConfiguredSandboxPort {
  port: number;
  /** Human-readable source, e.g. "codeServerPort" or "terminal port". */
  label: string;
}

/** A port conflict: either the reserved internal port, or a duplicate. */
export type SandboxPortConflict =
  | { kind: "reserved"; port: number; label: string }
  | { kind: "duplicate"; port: number; label: string };

/**
 * Find the first conflict across configured sandbox ports (code-server,
 * terminal, and tunnel ports): a port equal to the reserved internal ttyd port
 * ({@link INTERNAL_TTYD_PORT}), or a port used more than once. Returns null when
 * every port is usable.
 *
 * Enablement-independent — every configured port must be unique so none is
 * silently dropped at sandbox spawn. Shared by control-plane validation and the
 * web settings UI so the rule lives in exactly one place.
 */
export function findSandboxPortConflict(
  ports: ConfiguredSandboxPort[]
): SandboxPortConflict | null {
  const seen = new Set<number>();
  for (const { port, label } of ports) {
    if (port === INTERNAL_TTYD_PORT) return { kind: "reserved", port, label };
    if (seen.has(port)) return { kind: "duplicate", port, label };
    seen.add(port);
  }
  return null;
}

/** Default maximum active agent-spawned child sessions per parent session. */
export const DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS = 5;

/** Default maximum agent-spawned child sessions per parent session. */
export const DEFAULT_MAX_TOTAL_CHILD_SESSIONS = 15;

/**
 * Default repo-image build timeout (the build sandbox lifetime), in seconds.
 * Mirrors `DEFAULT_BUILD_TIMEOUT_SECONDS` in the Modal data plane
 * (`packages/modal-infra/src/sandbox/manager.py`).
 */
export const DEFAULT_BUILD_TIMEOUT_SECONDS = 1800;

/**
 * Maximum configurable repo-image build timeout, in seconds. The Modal
 * stale-build sweep (`STALE_BUILD_THRESHOLD_SECONDS`) is sized above this, so
 * raising it requires raising that threshold in lockstep.
 */
export const MAX_BUILD_TIMEOUT_SECONDS = 3600;

/**
 * Sandbox environment settings. Provider-agnostic: describes what the user
 * wants, not how it's done. Resource fields (`cpuCores`, `memoryMib`) are
 * advisory and provider-dependent — Modal maps them directly, Vercel maps
 * them to vCPUs, and providers without resource reservations ignore them. We
 * only check they're positive; the provider enforces its own real limits. When
 * unset, the provider's own default applies. At repo scope, `null` explicitly
 * uses the provider default instead of inheriting a global resource default.
 */
export interface SandboxSettings {
  /** Extra ports to expose via tunnels (e.g., dev server ports 3000, 5173). */
  tunnelPorts?: number[];
  /** Enable a browser-based terminal (ttyd) in sandbox sessions. */
  terminalEnabled?: boolean;
  /**
   * Port code-server binds to inside the sandbox (only used when code-server is
   * enabled). Unset → DEFAULT_CODE_SERVER_PORT. Set this to free the default
   * port for your own service on a tunnel.
   */
  codeServerPort?: number;
  /**
   * Port the web terminal (ttyd) proxy is exposed on (only used when
   * `terminalEnabled`). Unset → DEFAULT_TERMINAL_PORT. Ignored by providers
   * without terminal support.
   */
  terminalPort?: number;
  /** Maximum active agent-spawned child sessions per parent session. */
  maxConcurrentChildSessions?: number;
  /** Maximum total agent-spawned child sessions per parent session. */
  maxTotalChildSessions?: number;
  /**
   * CPU cores to reserve for the sandbox. Fractional values are allowed, but
   * providers may round to their supported resource shapes. Unset →
   * inherit/default; null → provider default.
   */
  cpuCores?: number | null;
  /**
   * Memory to reserve for the sandbox, in MiB. Providers may map this to their
   * closest supported resource shape. Unset → inherit/default; null → provider
   * default.
   */
  memoryMib?: number | null;
  /**
   * Repo-image build timeout (the build sandbox lifetime), in seconds.
   * Build-only — sessions are unaffected. Unset → DEFAULT_BUILD_TIMEOUT_SECONDS.
   * The trigger caps the effective value at MAX_BUILD_TIMEOUT_SECONDS via
   * {@link resolveBuildTimeoutSeconds}.
   */
  buildTimeoutSeconds?: number;
}

/**
 * Resolve the effective repo-image build timeout (seconds) from sandbox
 * settings: the default when unset, otherwise capped at
 * MAX_BUILD_TIMEOUT_SECONDS. Capping here keeps the Modal function-timeout and
 * stale-sweep invariants intact regardless of how the stored value got there
 * (old rows, direct API writes). A non-finite value falls back to the default.
 */
export function resolveBuildTimeoutSeconds(settings: SandboxSettings | undefined): number {
  const requested = settings?.buildTimeoutSeconds;
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return DEFAULT_BUILD_TIMEOUT_SECONDS;
  }
  return Math.min(MAX_BUILD_TIMEOUT_SECONDS, Math.max(1, Math.round(requested)));
}

export type SlackMentionsPolicy = "allow" | "escape" | "strip";

/**
 * A workspace-wide keyword→repository routing rule for Slack. When a Slack
 * message contains the keyword, the bot routes the agent to the target
 * repository deterministically, before falling back to LLM classification.
 */
export interface SlackRoutingRule {
  /** Case-insensitive keyword or phrase. Matched as a whole token in the message. */
  keyword: string;
  /** Canonical "owner/name" (lowercase) of the target repository. */
  target: string;
  // Future (deferred): targetType?: "repository" | "environment" — defaults to "repository".
}

/** Maximum number of routing rules a workspace can configure (bounds the settings blob). */
export const MAX_SLACK_ROUTING_RULES = 100;

/** Maximum length of a single routing-rule keyword. */
export const MAX_SLACK_ROUTING_KEYWORD_LENGTH = 100;

/** Per-repo Slack overrides. Mentions policy is workspace-wide and cannot be overridden per repo. */
export interface SlackRepoSettings {
  agentNotificationsEnabled?: boolean;
}

/** Global Slack defaults: per-repo fields plus workspace-wide policy controls. */
export interface SlackGlobalSettings extends SlackRepoSettings {
  mentionsPolicy?: SlackMentionsPolicy;
  /** Workspace-wide keyword→repository routing rules (global-only, like mentionsPolicy). */
  routingRules?: SlackRoutingRule[];
}

/**
 * Clean up raw routing rules for storage or use: trim and lowercase keyword and
 * target, drop entries that are empty after trimming, de-dupe identical
 * (keyword, target) pairs, and cap the count at {@link MAX_SLACK_ROUTING_RULES}.
 *
 * Lenient by design — it never throws — so it is safe on the bot's read path as
 * well as the control plane's write path. Shape/length enforcement (with errors)
 * lives in the control plane validator. A keyword pointing at two different
 * targets is intentionally preserved; that conflict surfaces at match time.
 */
export function normalizeRoutingRules(rules: SlackRoutingRule[] | undefined): SlackRoutingRule[] {
  if (!rules || rules.length === 0) return [];
  const seen = new Set<string>();
  const normalized: SlackRoutingRule[] = [];
  for (const rule of rules) {
    const keyword = typeof rule?.keyword === "string" ? rule.keyword.trim().toLowerCase() : "";
    const target = typeof rule?.target === "string" ? rule.target.trim().toLowerCase() : "";
    if (!keyword || !target) continue;
    const dedupeKey = `${keyword} ${target}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({ keyword, target });
    if (normalized.length >= MAX_SLACK_ROUTING_RULES) break;
  }
  return normalized;
}

/**
 * Return the rules whose keyword appears in `message` as a whole token
 * (case-insensitive, word-boundary match so "api" does not match "rapidly";
 * multi-word keywords match as a phrase). Rule order is preserved. Keywords are
 * matched literally, so regex-special characters carry no special meaning.
 *
 * Boundaries use `\W` (ASCII word characters), which is the right granularity
 * for the alphanumeric technical keywords this is designed for; matching against
 * non-ASCII keywords is intentionally looser.
 */
export function matchRoutingRules(message: string, rules: SlackRoutingRule[]): SlackRoutingRule[] {
  if (!message || rules.length === 0) return [];
  const haystack = message.toLowerCase();
  return rules.filter((rule) => {
    const keyword = typeof rule?.keyword === "string" ? rule.keyword.trim().toLowerCase() : "";
    if (!keyword) return false;
    return new RegExp(`(?:^|\\W)${escapeRegExp(keyword)}(?:\\W|$)`).test(haystack);
  });
}

/**
 * Maps each settings-store key to its global and per-repo settings types. Keys
 * are the integration IDs plus top-level settings that share the
 * same generic settings store for storage only.
 */
export interface IntegrationSettingsMap {
  github: IntegrationEntry<GitHubBotSettings>;
  linear: IntegrationEntry<LinearBotSettings>;
  "code-server": IntegrationEntry<CodeServerSettings>;
  sandbox: IntegrationEntry<SandboxSettings>;
  slack: IntegrationEntry<SlackRepoSettings, SlackGlobalSettings>;
  scm: IntegrationEntry<ScmSettings>;
}

/** Derived type for the GitHub bot global config. */
export type GitHubGlobalConfig = IntegrationSettingsMap["github"]["global"];
export type LinearGlobalConfig = IntegrationSettingsMap["linear"]["global"];
export type CodeServerGlobalConfig = IntegrationSettingsMap["code-server"]["global"];
export type SandboxGlobalConfig = IntegrationSettingsMap["sandbox"]["global"];
export type ScmGlobalConfig = IntegrationSettingsMap["scm"]["global"];
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
