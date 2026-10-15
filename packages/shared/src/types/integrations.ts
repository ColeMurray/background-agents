// Integration settings types

import { harnessIdSchema } from "../harnesses";
import { escapeRegExp } from "../regex";
import { z } from "zod";
import { teamSettingsSchema } from "./teams";

export type IntegrationId = "github" | "linear" | "code-server" | "vnc" | "sandbox" | "slack";

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

/** Overridable behavior settings for GitHub Autofix. */
export const githubAutofixAttemptLimitSchema = z.number().int().positive().safe().nullable();

export const githubAutofixSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
  reviewsEnabled: z.boolean().optional(),
  prCommentsEnabled: z.boolean().optional(),
  openInspectReviewsEnabled: z.boolean().optional(),
  allowedReviewBots: z.array(z.string()).optional(),
  maxAttemptsPerPrPer24Hours: githubAutofixAttemptLimitSchema.optional(),
});

export type GitHubAutofixSettings = z.infer<typeof githubAutofixSettingsSchema>;

export interface ResolvedGitHubAutofixSettings {
  enabled: boolean;
  reviewsEnabled: boolean;
  prCommentsEnabled: boolean;
  openInspectReviewsEnabled: boolean;
  allowedReviewBots: string[];
  /** A positive attempt cap, or null for no rolling limit. */
  maxAttemptsPerPrPer24Hours: number | null;
}

export const GITHUB_AUTOFIX_DEFAULT_ATTEMPT_LIMIT = 30;

export const GITHUB_AUTOFIX_DEFAULTS: ResolvedGitHubAutofixSettings = {
  enabled: false,
  reviewsEnabled: true,
  prCommentsEnabled: true,
  openInspectReviewsEnabled: true,
  allowedReviewBots: [],
  maxAttemptsPerPrPer24Hours: GITHUB_AUTOFIX_DEFAULT_ATTEMPT_LIMIT,
};

/** Overridable behavior settings for the GitHub bot. Used at both global and repo levels. */
export const githubBotSettingsSchema = z.strictObject({
  autoReviewOnOpen: z.boolean().optional(),
  model: z.string().optional(),
  harness: harnessIdSchema.optional(),
  reasoningEffort: z.string().optional(),
  allowedTriggerUsers: z.array(z.string()).optional(),
  codeReviewInstructions: z.string().optional(),
  commentActionInstructions: z.string().optional(),
  autofix: githubAutofixSettingsSchema.optional(),
});

export type GitHubBotSettings = z.infer<typeof githubBotSettingsSchema>;

/**
 * Source-control (SCM) behavior settings.
 *
 * Provider-agnostic: applies to both GitHub and GitLab.
 */
export const scmSettingsSchema = z
  .object({
    /** Always open pull/merge requests created by sessions as drafts. */
    alwaysUseDraftMode: z.boolean({ error: "alwaysUseDraftMode must be a boolean" }).optional(),
    /** Label applied to pull/merge requests created by sessions. */
    pullRequestLabel: z
      .string({ error: "pullRequestLabel must be a string" })
      .trim()
      .refine((label) => !label.includes(","), {
        message: "pullRequestLabel must not contain commas",
      })
      .optional(),
  })
  .strict()
  .transform(({ alwaysUseDraftMode, pullRequestLabel }) => ({
    ...(alwaysUseDraftMode !== undefined ? { alwaysUseDraftMode } : {}),
    ...(pullRequestLabel ? { pullRequestLabel } : {}),
  }));

export type ScmSettings = z.infer<typeof scmSettingsSchema>;

/** SCM has no per-repository enable/disable allowlist. */
export type ScmGlobalConfig = {
  enabledRepos?: never;
  defaults?: ScmSettings;
};

export const scmGlobalConfigSchema: z.ZodType<ScmGlobalConfig> = z.strictObject({
  defaults: scmSettingsSchema.optional(),
});

/** Repository SCM settings are field-level overrides; omitted fields inherit globally. */
export type ScmRepoSettings = ScmSettings;

/** Overridable behavior settings for the Linear bot, shared by global defaults and repo overrides. */
export const linearBotSettingsSchema = z.strictObject({
  /** Preferred harness for new sessions; see `resolveHarnessForModel`. */
  harness: harnessIdSchema.optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  allowUserPreferenceOverride: z.boolean().optional(),
  allowLabelModelOverride: z.boolean().optional(),
  emitToolProgressActivities: z.boolean().optional(),
  issueSessionInstructions: z.string().optional(),
});

export type LinearBotSettings = z.infer<typeof linearBotSettingsSchema>;

export const linearUnboundChannelsSchema = z.enum(["workspace", "reject"]);
export type LinearUnboundChannels = z.infer<typeof linearUnboundChannelsSchema>;
export const DEFAULT_LINEAR_UNBOUND_CHANNELS: LinearUnboundChannels = "workspace";

/** Global Linear defaults include workspace-wide policy that repo overrides cannot change. */
export const linearBotGlobalSettingsSchema = linearBotSettingsSchema.extend({
  unboundChannels: linearUnboundChannelsSchema.optional(),
});

export type LinearBotGlobalSettings = z.infer<typeof linearBotGlobalSettingsSchema>;

/**
 * Maximum length of a custom session-instructions value (Linear
 * `issueSessionInstructions`, Slack `sessionInstructions`). Bounds the
 * settings blob and the prompt section built from it.
 */
export const MAX_SESSION_INSTRUCTIONS_LENGTH = 10000;

/** Overridable behavior settings for the code-server integration. */
export const codeServerSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
});

export type CodeServerSettings = z.infer<typeof codeServerSettingsSchema>;

/** Overridable behavior settings for the VNC desktop integration. */
export const vncSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
});

export type VncSettings = z.infer<typeof vncSettingsSchema>;

/** Maximum number of tunnel ports a user can configure per sandbox. */
export const MAX_TUNNEL_PORTS = 10;

/**
 * Default port code-server binds to inside the sandbox. Mirrors
 * `CODE_SERVER_PORT` in `packages/sandbox-runtime/src/sandbox_runtime/constants.py`.
 */
export const DEFAULT_CODE_SERVER_PORT = 8080;

/** Default public noVNC/websockify port inside the sandbox. */
export const DEFAULT_VNC_PORT = 6080;

/** Internal VNC server port. Reserved because noVNC proxies it. */
export const INTERNAL_VNC_PORT = 5900;

/**
 * Default port the web terminal (ttyd) proxy is exposed on. Mirrors
 * `TTYD_PROXY_PORT` in `packages/sandbox-runtime/src/sandbox_runtime/constants.py`.
 */
export const DEFAULT_TERMINAL_PORT = 7680;

/**
 * Internal ttyd port (localhost-only, behind the proxy). Reserved: it is never
 * exposed and cannot be chosen as a service or tunnel port.
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
 * Find the first conflict across configured sandbox ports: a port reserved for
 * an internal service ({@link INTERNAL_TTYD_PORT} or
 * {@link INTERNAL_VNC_PORT}), or a port used more than once. Returns null when
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
    if (port === INTERNAL_TTYD_PORT || port === INTERNAL_VNC_PORT) {
      return { kind: "reserved", port, label };
    }
    if (seen.has(port)) return { kind: "duplicate", port, label };
    seen.add(port);
  }
  return null;
}

/** Default maximum active agent-spawned child sessions per parent session. */
export const DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS = 5;

/** Default maximum agent-spawned child sessions per parent session. */
export const DEFAULT_MAX_TOTAL_CHILD_SESSIONS = 15;

/** Minimum configurable sandbox session lifetime, in milliseconds. */
export const MIN_SANDBOX_TIMEOUT_MS = 1000;

/** Default time reserved before provider expiry for final preservation. */
export const DEFAULT_FINAL_SNAPSHOT_BUFFER_MS = 600_000;

/** Minimum configurable final-preservation buffer, in milliseconds. */
export const MIN_FINAL_SNAPSHOT_BUFFER_MS = 300_000;

/** Whether a sandbox lifetime is a safe positive whole-second millisecond value. */
export function isValidSandboxTimeoutMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_SANDBOX_TIMEOUT_MS &&
    value % MIN_SANDBOX_TIMEOUT_MS === 0
  );
}

/**
 * Default repo-image build timeout (the build sandbox lifetime), in seconds.
 * Mirrors `DEFAULT_BUILD_TIMEOUT_SECONDS` in the Modal data plane
 * (`packages/modal-infra/src/sandbox/build_session.py`).
 */
export const DEFAULT_BUILD_TIMEOUT_SECONDS = 1800;

/**
 * Maximum configurable repo-image build timeout, in seconds. Control-plane
 * stale recovery derives its provider-session ceiling from this value.
 */
export const MAX_BUILD_TIMEOUT_SECONDS = 3600;

/** Modal resource defaults; mirrored by the Python launch policy. */
export const DEFAULT_MODAL_CPU_CORES = 0.125;
export const DEFAULT_MODAL_MEMORY_MIB = 128;
export const DEFAULT_MODAL_VM_CPU_CORES = 0.5;
export const DEFAULT_MODAL_VM_MEMORY_MIB = 2048;
export const DEFAULT_MODAL_VM_CPU_LIMIT_CORES = 2;
export const DEFAULT_MODAL_VM_MEMORY_LIMIT_MIB = 4096;

/**
 * Sandbox environment settings. Provider-agnostic: describes what the user
 * wants, not how it's done. Request fields (`cpuCores`, `memoryMib`) are
 * advisory and provider-dependent — Modal maps them directly, Vercel maps
 * them to vCPUs, and providers without resource reservations ignore them.
 * Limits are caps supported only by Modal backends. The provider enforces its
 * own real limits. When unset, the provider's own default applies. At repo or
 * environment scope, `null` explicitly uses the provider default instead of
 * inheriting a resource default.
 */
export const sandboxSettingsSchema = z.strictObject({
  /** Extra ports to expose via tunnels (e.g., dev server ports 3000, 5173). */
  tunnelPorts: z.array(z.number()).optional(),
  /** Enable a browser-based terminal (ttyd) in sandbox sessions. */
  terminalEnabled: z.boolean().optional(),
  /** Port code-server binds to inside the sandbox. */
  codeServerPort: z.number().optional(),
  /** Port noVNC/websockify binds to inside the sandbox. */
  vncPort: z.number().optional(),
  /** Port the web terminal (ttyd) proxy is exposed on. */
  terminalPort: z.number().optional(),
  /** Maximum active agent-spawned child sessions per parent session. */
  maxConcurrentChildSessions: z.number().optional(),
  /** Maximum total agent-spawned child sessions per parent session. */
  maxTotalChildSessions: z.number().optional(),
  /** CPU cores to reserve for the sandbox. */
  cpuCores: z.number().nullable().optional(),
  /** Memory to reserve for the sandbox, in MiB. */
  memoryMib: z.number().nullable().optional(),
  /** CPU cap for Modal backends; null resets to the provider default. */
  cpuLimitCores: z.number().nullable().optional(),
  /** Memory cap in MiB for Modal backends; null resets to the provider default. */
  memoryLimitMib: z.number().nullable().optional(),
  /** Requested sandbox session lifetime, in milliseconds. */
  sandboxTimeoutMs: z.number().optional(),
  /** Time reserved before provider expiry for final sandbox preservation. */
  finalSnapshotBufferMs: z.number().optional(),
  /** Repo-image build timeout (the build sandbox lifetime), in seconds. */
  buildTimeoutSeconds: z.number().optional(),
  /** Maximum OpenCode-reported session cost in USD. */
  maxSessionCostUsd: z.number().finite().positive().optional(),
});

export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;

/** Every supported sandbox backend. Keep provider policy exhaustive over this union. */
export const SANDBOX_PROVIDER_NAMES = [
  "modal",
  "modal-vm",
  "daytona",
  "vercel",
  "opencomputer",
  "e2b",
] as const;

export type SandboxProviderName = (typeof SANDBOX_PROVIDER_NAMES)[number];

const DEFAULT_SANDBOX_SETTING_CAPABILITIES = {
  resources: true,
  resourceLimits: false,
  timeout: true,
};
const SANDBOX_SETTING_CAPABILITIES = {
  modal: { ...DEFAULT_SANDBOX_SETTING_CAPABILITIES, resourceLimits: true },
  "modal-vm": { ...DEFAULT_SANDBOX_SETTING_CAPABILITIES, resourceLimits: true },
  daytona: { resources: false, resourceLimits: false, timeout: false },
  vercel: DEFAULT_SANDBOX_SETTING_CAPABILITIES,
  opencomputer: { resources: false, resourceLimits: false, timeout: true },
  e2b: { resources: false, resourceLimits: false, timeout: true },
} satisfies Record<
  SandboxProviderName,
  { resources: boolean; resourceLimits: boolean; timeout: boolean }
>;

export function isSandboxProviderName(provider: string): provider is SandboxProviderName {
  return (SANDBOX_PROVIDER_NAMES as readonly string[]).includes(provider);
}

/** Unvalidated provider names support resources and timeouts, but not resource caps. */
export function sandboxSettingCapabilities(provider: string): {
  resources: boolean;
  resourceLimits: boolean;
  timeout: boolean;
} {
  const normalized = provider.trim().toLowerCase();
  return isSandboxProviderName(normalized)
    ? SANDBOX_SETTING_CAPABILITIES[normalized]
    : DEFAULT_SANDBOX_SETTING_CAPABILITIES;
}

/** Whether the provider honors per-session CPU and memory settings. */
export function supportsConfigurableSandboxResources(provider: string): boolean {
  return sandboxSettingCapabilities(provider).resources;
}

/** Only Modal backends honor per-session resource caps. */
export function supportsConfigurableSandboxResourceLimits(provider: string): boolean {
  return sandboxSettingCapabilities(provider).resourceLimits;
}

/** Whether the provider honors a per-session sandbox lifetime. */
export function supportsConfigurableSandboxTimeout(provider: string): boolean {
  return sandboxSettingCapabilities(provider).timeout;
}

export type SandboxResources = Pick<
  SandboxSettings,
  "cpuCores" | "memoryMib" | "cpuLimitCores" | "memoryLimitMib"
>;

/** Compare supported caps against explicit requests or the selected provider's defaults. */
export function validateSandboxResourceLimits(
  settings: SandboxResources,
  provider: SandboxProviderName
): string | undefined {
  if (!supportsConfigurableSandboxResourceLimits(provider)) {
    return undefined;
  }
  const cpuCores =
    settings.cpuCores ??
    (provider === "modal-vm" ? DEFAULT_MODAL_VM_CPU_CORES : DEFAULT_MODAL_CPU_CORES);
  const memoryMib =
    settings.memoryMib ??
    (provider === "modal-vm" ? DEFAULT_MODAL_VM_MEMORY_MIB : DEFAULT_MODAL_MEMORY_MIB);
  if (settings.cpuLimitCores != null && settings.cpuLimitCores < cpuCores) {
    return "cpuLimitCores must be greater than or equal to cpuCores";
  }
  if (settings.memoryLimitMib != null && settings.memoryLimitMib < memoryMib) {
    return "memoryLimitMib must be greater than or equal to memoryMib";
  }
  return undefined;
}

export type ProviderSpecificSandboxSetting = keyof SandboxResources | "sandboxTimeoutMs";

export function unsupportedSandboxSettings(
  settings: SandboxSettings,
  provider: string
): ProviderSpecificSandboxSetting[] {
  const unsupported: ProviderSpecificSandboxSetting[] = [];
  if (!supportsConfigurableSandboxResources(provider)) {
    if (settings.cpuCores !== undefined) unsupported.push("cpuCores");
    if (settings.memoryMib !== undefined) unsupported.push("memoryMib");
  }
  if (!supportsConfigurableSandboxResourceLimits(provider)) {
    if (settings.cpuLimitCores !== undefined) unsupported.push("cpuLimitCores");
    if (settings.memoryLimitMib !== undefined) unsupported.push("memoryLimitMib");
  }
  if (!supportsConfigurableSandboxTimeout(provider) && settings.sandboxTimeoutMs !== undefined) {
    unsupported.push("sandboxTimeoutMs");
  }
  return unsupported;
}

/** Remove settings the selected provider cannot honor from an effective session snapshot. */
export function omitUnsupportedSandboxSettings(
  settings: SandboxSettings,
  provider: string
): SandboxSettings {
  const supported = { ...settings };
  for (const setting of unsupportedSandboxSettings(settings, provider)) delete supported[setting];
  return supported;
}

/** Validate the relationship only when both child-session limits are provided. */
export function validateSandboxChildSessionLimits(
  settings: Pick<SandboxSettings, "maxConcurrentChildSessions" | "maxTotalChildSessions">
): string | undefined {
  const { maxConcurrentChildSessions, maxTotalChildSessions } = settings;
  if (
    maxConcurrentChildSessions !== undefined &&
    maxTotalChildSessions !== undefined &&
    maxConcurrentChildSessions > maxTotalChildSessions
  ) {
    return "maxConcurrentChildSessions must be less than or equal to maxTotalChildSessions";
  }
  return undefined;
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

export const slackUnboundChannelsSchema = z.enum(["workspace", "reject"]);
export type SlackUnboundChannels = z.infer<typeof slackUnboundChannelsSchema>;
export const DEFAULT_SLACK_UNBOUND_CHANNELS: SlackUnboundChannels = "workspace";

/** What a Slack routing rule points at: a repository or a saved environment. */
export type SlackRoutingTargetType = "repository" | "environment";

export const slackRoutingTargetTypeSchema = z.enum(["repository", "environment"]);

/**
 * A workspace-wide keyword→target routing rule for Slack. When a Slack
 * message contains the keyword, the bot routes the agent to the target
 * repository or environment deterministically, before falling back to LLM
 * classification.
 */
export const slackRoutingRuleSchema = z.object({
  /** Case-insensitive keyword or phrase. Matched as a whole token in the message. */
  keyword: z.string(),
  /**
   * Canonical "owner/name" (lowercase) of the target repository, or — when
   * `targetType` is `"environment"` — the stable environment id (`env_…`),
   * never the rename-able display name.
   */
  target: z.string(),
  /** Absent means "repository" (every rule stored before environments existed). */
  targetType: slackRoutingTargetTypeSchema.optional(),
});

export type SlackRoutingRule = z.infer<typeof slackRoutingRuleSchema>;

export const slackIntegrationSettingsRoutingResponseSchema = z.object({
  settings: z
    .object({
      defaults: z
        .object({
          routingRules: z.array(slackRoutingRuleSchema).optional(),
        })
        .optional(),
    })
    .nullable()
    .optional(),
});

export type SlackIntegrationSettingsRoutingResponse = z.infer<
  typeof slackIntegrationSettingsRoutingResponseSchema
>;

/** Maximum number of routing rules a workspace can configure (bounds the settings blob). */
export const MAX_SLACK_ROUTING_RULES = 100;

/** Maximum length of a single routing-rule keyword. */
export const MAX_SLACK_ROUTING_KEYWORD_LENGTH = 100;

/** Per-repo Slack overrides. Mentions policy is workspace-wide and cannot be overridden per repo. */
export const slackRepoSettingsSchema = z.strictObject({
  agentNotificationsEnabled: z.boolean().optional(),
});

export type SlackRepoSettings = z.infer<typeof slackRepoSettingsSchema>;

/** Global Slack defaults: per-repo fields plus workspace-wide policy controls. */
export const slackGlobalSettingsSchema = slackRepoSettingsSchema.extend({
  /** Preferred harness for new sessions; see `resolveHarnessForModel`. */
  harness: harnessIdSchema.optional(),
  model: z.string().optional(),
  mentionsPolicy: z.enum(["allow", "escape", "strip"]).optional(),
  /** Ownership policy for Slack channels without a Team binding (global-only). */
  unboundChannels: slackUnboundChannelsSchema.optional(),
  /** Workspace-wide keyword→repository routing rules (global-only, like mentionsPolicy). */
  routingRules: z.array(slackRoutingRuleSchema.strict()).optional(),
  /** Custom instructions appended to the first prompt of every Slack-initiated session. */
  sessionInstructions: z.string().optional(),
});

export type SlackGlobalSettings = z.infer<typeof slackGlobalSettingsSchema>;

/**
 * Clean up raw routing rules for storage or use: trim and lowercase the keyword,
 * canonicalize the target (repository targets lowercase; environment ids are
 * opaque and only trimmed), drop entries that are empty after trimming, de-dupe
 * identical (keyword, targetType, target) triples, and cap the count at
 * {@link MAX_SLACK_ROUTING_RULES}. Repository rules normalize to the bare
 * `{ keyword, target }` shape (no `targetType`), keeping them byte-identical to
 * every rule stored before environments existed.
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
    const rawTarget = typeof rule?.target === "string" ? rule.target.trim() : "";
    const isEnvironment = rule?.targetType === "environment";
    const target = isEnvironment ? rawTarget : rawTarget.toLowerCase();
    if (!keyword || !target) continue;
    const dedupeKey = `${keyword} ${isEnvironment ? "environment" : "repository"} ${target}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(
      isEnvironment ? { keyword, target, targetType: "environment" } : { keyword, target }
    );
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
 * Integrations that accept environment-level setting overrides — the top layer
 * of the resolution chain (global defaults → primary-repo overrides →
 * environment overrides). Limited to the settings the session-scoped
 * resolution consumes; bot-scoped integrations (github, linear) resolve from
 * the trigger repo before a session exists, and slack is global/per-repo only.
 * The environment-level shape is the integration's repo (override) shape.
 */
export const ENVIRONMENT_SETTINGS_INTEGRATION_IDS = ["sandbox", "code-server", "vnc"] as const;

export type EnvironmentSettingsIntegrationId =
  (typeof ENVIRONMENT_SETTINGS_INTEGRATION_IDS)[number];

function integrationGlobalSettingsSchema<T extends z.ZodType<object>>(defaults: T) {
  return z.strictObject({
    enabledRepos: z.array(z.string()).nullable().optional(),
    defaults: defaults.optional(),
  });
}

/** Runtime schemas are the source of truth for every persisted settings type. */
export const integrationSettingsSchemas = {
  github: {
    global: integrationGlobalSettingsSchema(githubBotSettingsSchema),
    repo: githubBotSettingsSchema,
  },
  linear: {
    global: integrationGlobalSettingsSchema(linearBotGlobalSettingsSchema),
    repo: linearBotSettingsSchema,
  },
  "code-server": {
    global: integrationGlobalSettingsSchema(codeServerSettingsSchema),
    repo: codeServerSettingsSchema,
  },
  vnc: {
    global: integrationGlobalSettingsSchema(vncSettingsSchema),
    repo: vncSettingsSchema,
  },
  sandbox: {
    global: integrationGlobalSettingsSchema(sandboxSettingsSchema),
    repo: sandboxSettingsSchema,
  },
  slack: {
    global: integrationGlobalSettingsSchema(slackGlobalSettingsSchema),
    repo: slackRepoSettingsSchema,
  },
  scm: {
    global: scmGlobalConfigSchema,
    repo: scmSettingsSchema,
  },
  teams: {
    global: z.strictObject({
      enabledRepos: z.never().optional(),
      defaults: teamSettingsSchema.optional(),
    }),
    repo: z.strictObject({}),
  },
} as const;

export type IntegrationGlobalSettings<K extends keyof typeof integrationSettingsSchemas> = z.output<
  (typeof integrationSettingsSchemas)[K]["global"]
>;

export type IntegrationRepoSettings<K extends keyof typeof integrationSettingsSchemas> = z.output<
  (typeof integrationSettingsSchemas)[K]["repo"]
>;

export function getIntegrationGlobalSettingsSchema<
  K extends keyof typeof integrationSettingsSchemas,
>(integrationId: K): z.ZodType<IntegrationGlobalSettings<K>>;
export function getIntegrationGlobalSettingsSchema(
  integrationId: keyof typeof integrationSettingsSchemas
) {
  return integrationSettingsSchemas[integrationId].global;
}

export function getIntegrationRepoSettingsSchema<K extends keyof typeof integrationSettingsSchemas>(
  integrationId: K
): z.ZodType<IntegrationRepoSettings<K>>;
export function getIntegrationRepoSettingsSchema(
  integrationId: keyof typeof integrationSettingsSchemas
) {
  return integrationSettingsSchemas[integrationId].repo;
}

/** Maps each storage key to types inferred from its runtime schemas. */
export type IntegrationSettingsMap = {
  [K in keyof typeof integrationSettingsSchemas]: {
    global: IntegrationGlobalSettings<K>;
    repo: IntegrationRepoSettings<K>;
  };
};

/** Derived type for the GitHub bot global config. */
export type GitHubGlobalConfig = IntegrationSettingsMap["github"]["global"];
export type LinearGlobalConfig = IntegrationSettingsMap["linear"]["global"];
export type CodeServerGlobalConfig = IntegrationSettingsMap["code-server"]["global"];
export type VncGlobalConfig = IntegrationSettingsMap["vnc"]["global"];
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

export const DEFAULT_MCP_SERVER_ENABLED = true;
export const mcpServerTypeSchema = z.enum(["local", "remote"]);
export const mcpServerCommandSchema = z.array(z.string()).min(1);
export const mcpServerCredentialMapSchema = z.record(z.string(), z.string());

const mcpServerCommonFields = {
  name: z.string().trim().min(1),
  repoScopes: z.array(z.string()).nullable().optional(),
  enabled: z.boolean().optional(),
};

export const createMcpServerInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...mcpServerCommonFields,
      type: z.literal("local"),
      command: mcpServerCommandSchema,
      env: mcpServerCredentialMapSchema.optional(),
      enabled: mcpServerCommonFields.enabled.default(DEFAULT_MCP_SERVER_ENABLED),
    })
    .strict(),
  z
    .object({
      ...mcpServerCommonFields,
      type: z.literal("remote"),
      url: z.url(),
      headers: mcpServerCredentialMapSchema.optional(),
      enabled: mcpServerCommonFields.enabled.default(DEFAULT_MCP_SERVER_ENABLED),
    })
    .strict(),
]);

export const updateMcpServerInputSchema = z
  .object({
    ...mcpServerCommonFields,
    revision: z.number().int().positive(),
    type: mcpServerTypeSchema,
    command: mcpServerCommandSchema,
    url: z.url(),
    env: mcpServerCredentialMapSchema,
    headers: mcpServerCredentialMapSchema,
  })
  .partial()
  .strict();

export type CreateMcpServerRequest = z.input<typeof createMcpServerInputSchema>;
export type UpdateMcpServerRequest = Omit<
  z.input<typeof updateMcpServerInputSchema>,
  "revision"
> & { revision: number };
export type ValidatedCreateMcpServerInput = z.output<typeof createMcpServerInputSchema>;
export type ValidatedUpdateMcpServerInput = Omit<
  z.output<typeof updateMcpServerInputSchema>,
  "revision"
>;

/** MCP server metadata for API responses — no decrypted credentials. */
export interface McpServerMetadata {
  id: string;
  revision: number;
  name: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  hasEnv: boolean;
  hasHeaders: boolean;
  repoScopes?: string[] | null;
  enabled: boolean;
}

/**
 * Saved MCP server credentials, decrypted for the settings edit form.
 * Only returned to callers with `mcp_servers.manage`.
 */
export interface McpServerCredentials {
  id: string;
  revision: number;
  type: "local" | "remote";
  env?: Record<string, string>;
  headers?: Record<string, string>;
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
    id: "vnc",
    name: "VNC Desktop",
    description: "Remote desktop access attached to sandbox sessions",
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
