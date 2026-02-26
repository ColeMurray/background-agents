import {
  isValidModel,
  isValidReasoningEffort,
  INTEGRATION_DEFINITIONS,
  type IntegrationId,
  type IntegrationSettingsMap,
  type GitHubBotSettings,
  type LinearBotSettings,
  type TeamsBotSettings,
  TEAMS_TYPING_MODES,
} from "@open-inspect/shared";

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
    return JSON.parse(row.settings) as IntegrationSettingsMap[K]["global"];
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
        defaults: this.validateAndNormalizeSettings(integrationId, settings.defaults),
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
    return JSON.parse(row.settings) as IntegrationSettingsMap[K]["repo"];
  }

  async setRepoSettings<K extends IntegrationId>(
    integrationId: K,
    repo: string,
    settings: IntegrationSettingsMap[K]["repo"]
  ): Promise<void> {
    const normalized = this.validateAndNormalizeSettings(integrationId, settings);

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
      settings: JSON.parse(row.settings) as IntegrationSettingsMap[K]["repo"],
    }));
  }

  async getResolvedConfig<K extends IntegrationId>(
    integrationId: K,
    repo: string
  ): Promise<ResolvedIntegrationConfig<IntegrationSettingsMap[K]["repo"]>> {
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

    return { enabledRepos, settings } as ResolvedIntegrationConfig<
      IntegrationSettingsMap[K]["repo"]
    >;
  }

  private validateAndNormalizeSettings<K extends IntegrationId>(
    integrationId: K,
    settings: IntegrationSettingsMap[K]["repo"]
  ): IntegrationSettingsMap[K]["repo"] {
    if (integrationId === "github") {
      return this.validateAndNormalizeGitHubSettings(
        settings as GitHubBotSettings
      ) as IntegrationSettingsMap[K]["repo"];
    }

    if (integrationId === "linear") {
      this.validateLinearSettings(settings as LinearBotSettings);
    }

    if (integrationId === "teams") {
      this.validateTeamsSettings(settings as TeamsBotSettings);
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

  private validateTeamsSettings(settings: TeamsBotSettings): void {
    this.validateModelAndEffort(settings);

    const validModes = TEAMS_TYPING_MODES.map((m) => m.value);
    if (settings.typingMode !== undefined && !validModes.includes(settings.typingMode)) {
      throw new IntegrationSettingsValidationError(
        `Invalid typingMode: ${settings.typingMode}. Must be one of: ${validModes.join(", ")}`
      );
    }
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
  }
}

export interface ResolvedIntegrationConfig<TRepo extends object = Record<string, unknown>> {
  enabledRepos: string[] | null;
  settings: TRepo;
}
