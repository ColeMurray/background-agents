import {
  isValidModel,
  isValidReasoningEffort,
  INTEGRATION_DEFINITIONS,
  DEFAULT_MENTIONS_POLICY,
  MAX_SLACK_ROUTING_RULES,
  MAX_SLACK_ROUTING_KEYWORD_LENGTH,
  normalizeRoutingRules,
  type IntegrationId,
  type IntegrationSettingsMap,
  type GitHubBotSettings,
  type LinearBotSettings,
  type CodeServerSettings,
  type SlackGlobalSettings,
  type SlackMentionsPolicy,
  type SlackRoutingRule,
} from "@open-inspect/shared";
import { normalizeSandboxSettings } from "../sandbox/settings";

type SettingsLevel = "global" | "repo";

const SLACK_MENTIONS_POLICIES = ["allow", "escape", "strip"] as const;

export class IntegrationSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationSettingsValidationError";
  }
}

const VALID_INTEGRATION_IDS = new Set<string>(INTEGRATION_DEFINITIONS.map((d) => d.id));

export function isValidIntegrationId(id: string): id is IntegrationId {
  return VALID_INTEGRATION_IDS.has(id);
}

export class IntegrationSettingsStore {
  constructor(private readonly db: D1Database) {}

  async getGlobal<K extends IntegrationId>(
    integrationId: K
  ): Promise<IntegrationSettingsMap[K]["global"] | null> {
    const row = await this.db
      .prepare("SELECT settings FROM integration_settings WHERE integration_id = ?")
      .bind(integrationId)
      .first<{ settings: string }>();

    if (!row) return null;
    const settings = JSON.parse(row.settings) as IntegrationSettingsMap[K]["global"];
    return this.normalizeStoredGlobalSettings(integrationId, settings);
  }

  async setGlobal<K extends IntegrationId>(
    integrationId: K,
    settings: IntegrationSettingsMap[K]["global"]
  ): Promise<void> {
    if (settings.enabledRepos !== undefined) {
      if (
        !Array.isArray(settings.enabledRepos) ||
        !settings.enabledRepos.every((r) => typeof r === "string")
      ) {
        throw new IntegrationSettingsValidationError("enabledRepos must be an array of strings");
      }
      settings = {
        ...settings,
        enabledRepos: settings.enabledRepos.map((r) => r.toLowerCase()),
      };
    }

    if (settings.defaults) {
      settings = {
        ...settings,
        defaults: this.validateAndNormalizeSettings(integrationId, settings.defaults, "global"),
      };
    }

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO integration_settings (integration_id, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(integration_id) DO UPDATE SET
           settings = excluded.settings,
           updated_at = excluded.updated_at`
      )
      .bind(integrationId, JSON.stringify(settings), now, now)
      .run();
  }

  async deleteGlobal<K extends IntegrationId>(integrationId: K): Promise<void> {
    await this.db
      .prepare("DELETE FROM integration_settings WHERE integration_id = ?")
      .bind(integrationId)
      .run();
  }

  async getRepoSettings<K extends IntegrationId>(
    integrationId: K,
    repo: string
  ): Promise<IntegrationSettingsMap[K]["repo"] | null> {
    const row = await this.db
      .prepare(
        "SELECT settings FROM integration_repo_settings WHERE integration_id = ? AND repo = ?"
      )
      .bind(integrationId, repo.toLowerCase())
      .first<{ settings: string }>();

    if (!row) return null;
    const settings = JSON.parse(row.settings) as IntegrationSettingsMap[K]["repo"];
    return this.normalizeStoredRepoSettings(integrationId, settings);
  }

  async setRepoSettings<K extends IntegrationId>(
    integrationId: K,
    repo: string,
    settings: IntegrationSettingsMap[K]["repo"]
  ): Promise<void> {
    const normalized = this.validateAndNormalizeSettings(integrationId, settings, "repo");

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO integration_repo_settings (integration_id, repo, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(integration_id, repo) DO UPDATE SET
           settings = excluded.settings,
           updated_at = excluded.updated_at`
      )
      .bind(integrationId, repo.toLowerCase(), JSON.stringify(normalized), now, now)
      .run();
  }

  async deleteRepoSettings<K extends IntegrationId>(integrationId: K, repo: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM integration_repo_settings WHERE integration_id = ? AND repo = ?")
      .bind(integrationId, repo.toLowerCase())
      .run();
  }

  async listRepoSettings<K extends IntegrationId>(
    integrationId: K
  ): Promise<Array<{ repo: string; settings: IntegrationSettingsMap[K]["repo"] }>> {
    const { results } = await this.db
      .prepare("SELECT repo, settings FROM integration_repo_settings WHERE integration_id = ?")
      .bind(integrationId)
      .all<{ repo: string; settings: string }>();

    return results.map((row) => ({
      repo: row.repo,
      settings: this.normalizeStoredRepoSettings(
        integrationId,
        JSON.parse(row.settings) as IntegrationSettingsMap[K]["repo"]
      ),
    }));
  }

  async getResolvedConfig<K extends IntegrationId>(
    integrationId: K,
    repo: string
  ): Promise<
    ResolvedIntegrationConfig<NonNullable<IntegrationSettingsMap[K]["global"]["defaults"]>>
  > {
    const [globalSettings, repoSettings] = await Promise.all([
      this.getGlobal(integrationId),
      this.getRepoSettings(integrationId, repo),
    ]);

    // undefined → null (all repos), [] → [] (disabled), [...] → [...] (allowlist)
    const enabledRepos =
      globalSettings?.enabledRepos !== undefined ? globalSettings.enabledRepos : null;

    const defaults = globalSettings?.defaults ?? {};
    const overrides = repoSettings ?? {};

    // Generic merge: repo overrides win, undefined keys don't clobber defaults
    const settings: Record<string, unknown> = { ...defaults };
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        settings[key] = value;
      }
    }

    const resolvedSettings =
      integrationId === "sandbox"
        ? normalizeSandboxSettings(settings, { invalid: "omit" })
        : settings;

    return { enabledRepos, settings: resolvedSettings } as ResolvedIntegrationConfig<
      NonNullable<IntegrationSettingsMap[K]["global"]["defaults"]>
    >;
  }

  private normalizeStoredGlobalSettings<K extends IntegrationId>(
    integrationId: K,
    settings: IntegrationSettingsMap[K]["global"]
  ): IntegrationSettingsMap[K]["global"] {
    if (integrationId !== "sandbox" || !settings.defaults) return settings;
    return {
      ...settings,
      defaults: normalizeSandboxSettings(settings.defaults, { invalid: "omit" }),
    } as IntegrationSettingsMap[K]["global"];
  }

  private normalizeStoredRepoSettings<K extends IntegrationId>(
    integrationId: K,
    settings: IntegrationSettingsMap[K]["repo"]
  ): IntegrationSettingsMap[K]["repo"] {
    if (integrationId !== "sandbox") return settings;
    return normalizeSandboxSettings(settings, {
      invalid: "omit",
    }) as IntegrationSettingsMap[K]["repo"];
  }

  private validateAndNormalizeSettings<K extends IntegrationId>(
    integrationId: K,
    settings: IntegrationSettingsMap[K]["repo"],
    level: SettingsLevel
  ): IntegrationSettingsMap[K]["repo"] {
    if (integrationId === "github") {
      return this.validateAndNormalizeGitHubSettings(
        settings as GitHubBotSettings
      ) as IntegrationSettingsMap[K]["repo"];
    }

    if (integrationId === "linear") {
      this.validateLinearSettings(settings as LinearBotSettings);
    }

    if (integrationId === "code-server") {
      this.validateCodeServerSettings(settings as CodeServerSettings);
    }

    if (integrationId === "sandbox") {
      return normalizeSandboxSettings(settings, {
        invalid: "throw",
        createError: (message) => new IntegrationSettingsValidationError(message),
      }) as IntegrationSettingsMap[K]["repo"];
    }

    if (integrationId === "slack") {
      return this.validateSlackSettings(
        settings as SlackGlobalSettings,
        level
      ) as IntegrationSettingsMap[K]["repo"];
    }

    return settings;
  }

  private validateModelAndEffort(settings: { model?: string; reasoningEffort?: string }): void {
    if (settings.model !== undefined && !isValidModel(settings.model)) {
      throw new IntegrationSettingsValidationError(`Invalid model ID: ${settings.model}`);
    }

    if (
      settings.model !== undefined &&
      settings.reasoningEffort !== undefined &&
      !isValidReasoningEffort(settings.model, settings.reasoningEffort)
    ) {
      throw new IntegrationSettingsValidationError(
        `Invalid reasoning effort "${settings.reasoningEffort}" for model "${settings.model}"`
      );
    }
  }

  private validateAndNormalizeGitHubSettings(settings: GitHubBotSettings): GitHubBotSettings {
    this.validateModelAndEffort(settings);

    if (
      settings.codeReviewInstructions !== undefined &&
      typeof settings.codeReviewInstructions !== "string"
    ) {
      throw new IntegrationSettingsValidationError("codeReviewInstructions must be a string");
    }

    if (
      settings.commentActionInstructions !== undefined &&
      typeof settings.commentActionInstructions !== "string"
    ) {
      throw new IntegrationSettingsValidationError("commentActionInstructions must be a string");
    }

    if (settings.allowedTriggerUsers !== undefined) {
      if (
        !Array.isArray(settings.allowedTriggerUsers) ||
        !settings.allowedTriggerUsers.every((u) => typeof u === "string")
      ) {
        throw new IntegrationSettingsValidationError(
          "allowedTriggerUsers must be an array of strings"
        );
      }
      return {
        ...settings,
        allowedTriggerUsers: settings.allowedTriggerUsers.map((u) => u.trim().toLowerCase()),
      };
    }

    return settings;
  }

  private validateLinearSettings(settings: LinearBotSettings): void {
    this.validateModelAndEffort(settings);

    if (
      settings.allowUserPreferenceOverride !== undefined &&
      typeof settings.allowUserPreferenceOverride !== "boolean"
    ) {
      throw new IntegrationSettingsValidationError("allowUserPreferenceOverride must be a boolean");
    }

    if (
      settings.allowLabelModelOverride !== undefined &&
      typeof settings.allowLabelModelOverride !== "boolean"
    ) {
      throw new IntegrationSettingsValidationError("allowLabelModelOverride must be a boolean");
    }

    if (
      settings.emitToolProgressActivities !== undefined &&
      typeof settings.emitToolProgressActivities !== "boolean"
    ) {
      throw new IntegrationSettingsValidationError("emitToolProgressActivities must be a boolean");
    }

    if (
      settings.issueSessionInstructions !== undefined &&
      typeof settings.issueSessionInstructions !== "string"
    ) {
      throw new IntegrationSettingsValidationError("issueSessionInstructions must be a string");
    }

    if (
      typeof settings.issueSessionInstructions === "string" &&
      settings.issueSessionInstructions.length > 10000
    ) {
      throw new IntegrationSettingsValidationError(
        "issueSessionInstructions must be 10000 characters or fewer"
      );
    }
  }

  private validateCodeServerSettings(settings: CodeServerSettings): void {
    if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") {
      throw new IntegrationSettingsValidationError("enabled must be a boolean");
    }
  }

  private validateSlackSettings(
    settings: SlackGlobalSettings,
    level: SettingsLevel
  ): SlackGlobalSettings {
    const allowedKeys =
      level === "global"
        ? new Set(["agentNotificationsEnabled", "model", "mentionsPolicy", "routingRules"])
        : new Set(["agentNotificationsEnabled"]);

    for (const key of Object.keys(settings)) {
      if (!allowedKeys.has(key)) {
        throw new IntegrationSettingsValidationError(`Unknown slack setting: ${key}`);
      }
    }

    if (
      settings.agentNotificationsEnabled !== undefined &&
      typeof settings.agentNotificationsEnabled !== "boolean"
    ) {
      throw new IntegrationSettingsValidationError("agentNotificationsEnabled must be a boolean");
    }

    this.validateModelAndEffort(settings);

    if (
      settings.mentionsPolicy !== undefined &&
      !SLACK_MENTIONS_POLICIES.includes(settings.mentionsPolicy)
    ) {
      throw new IntegrationSettingsValidationError(
        `mentionsPolicy must be one of: ${SLACK_MENTIONS_POLICIES.join(", ")}`
      );
    }

    // Routing rules are workspace-wide (the allowedKeys gate above already
    // rejects them at the per-repo level). Validate structure here; normalize
    // for storage. Target existence is not checked (the repo list isn't
    // available at this layer) — the bot skips stale targets at match time.
    if (settings.routingRules !== undefined) {
      return { ...settings, routingRules: this.validateRoutingRules(settings.routingRules) };
    }

    return settings;
  }

  private validateRoutingRules(rules: unknown): SlackRoutingRule[] {
    if (!Array.isArray(rules)) {
      throw new IntegrationSettingsValidationError("routingRules must be an array");
    }
    if (rules.length > MAX_SLACK_ROUTING_RULES) {
      throw new IntegrationSettingsValidationError(
        `routingRules cannot exceed ${MAX_SLACK_ROUTING_RULES} entries`
      );
    }
    for (const rule of rules) {
      if (typeof rule !== "object" || rule === null) {
        throw new IntegrationSettingsValidationError("each routing rule must be an object");
      }
      const { keyword, target, targetType } = rule as {
        keyword?: unknown;
        target?: unknown;
        targetType?: unknown;
      };
      if (typeof keyword !== "string" || keyword.trim() === "") {
        throw new IntegrationSettingsValidationError(
          "routing rule keyword must be a non-empty string"
        );
      }
      if (keyword.trim().length > MAX_SLACK_ROUTING_KEYWORD_LENGTH) {
        throw new IntegrationSettingsValidationError(
          `routing rule keyword must be ${MAX_SLACK_ROUTING_KEYWORD_LENGTH} characters or fewer`
        );
      }
      if (targetType !== undefined && targetType !== "repository" && targetType !== "environment") {
        throw new IntegrationSettingsValidationError(
          'routing rule targetType must be "repository" or "environment"'
        );
      }
      if (targetType === "environment") {
        // The stable environment id, never the rename-able display name.
        if (typeof target !== "string" || !/^env_[A-Za-z0-9]+$/.test(target.trim())) {
          throw new IntegrationSettingsValidationError(
            "routing rule target must be an environment id (env_…) when targetType is environment"
          );
        }
      } else if (typeof target !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(target.trim())) {
        throw new IntegrationSettingsValidationError(
          "routing rule target must be a repository in owner/name form"
        );
      }
    }
    return normalizeRoutingRules(rules as SlackRoutingRule[]);
  }
}

export interface ResolvedIntegrationConfig<TRepo extends object = Record<string, unknown>> {
  enabledRepos: string[] | null;
  settings: TRepo;
}

/**
 * Apply runtime defaults to raw Slack settings.
 *
 * Reads the partially-typed shape returned by `getResolvedConfig("slack", ...)`
 * and produces the canonical view used by the route handler and the DO
 * lifecycle factory: a definite boolean for the master gate, and a definite
 * mention policy. Avoids re-applying `=== true` and `?? "allow"` at every
 * call site.
 */
export function resolveSlackSettings(raw: Partial<SlackGlobalSettings> | undefined): {
  agentNotificationsEnabled: boolean;
  mentionsPolicy: SlackMentionsPolicy;
} {
  return {
    agentNotificationsEnabled: raw?.agentNotificationsEnabled === true,
    mentionsPolicy: raw?.mentionsPolicy ?? DEFAULT_MENTIONS_POLICY,
  };
}
