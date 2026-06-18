import type { ScmSettings, ScmGlobalConfig } from "@open-inspect/shared";
import { IntegrationSettingsStore } from "./integration-settings";

/**
 * Storage key under which SCM settings live in the shared settings tables.
 *
 * SCM settings are a top-level setting, NOT an integration — they are kept out
 * of the integration framework (`isValidIntegrationId`, `INTEGRATION_DEFINITIONS`).
 * For storage they reuse the generic `IntegrationSettingsStore` (and its
 * `integration_settings` / `integration_repo_settings` tables) under this fixed
 * key, so there's no schema migration and no duplicated SQL.
 */
const SCM_SETTINGS_KEY = "scm";

export class ScmSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScmSettingsValidationError";
  }
}

const ALLOWED_SCM_SETTING_KEYS = new Set(["alwaysUseDraftMode"]);

function validateScmSettings(settings: unknown): asserts settings is ScmSettings {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new ScmSettingsValidationError("SCM settings must be an object");
  }

  for (const key of Object.keys(settings)) {
    if (!ALLOWED_SCM_SETTING_KEYS.has(key)) {
      throw new ScmSettingsValidationError(`Unknown SCM setting: ${key}`);
    }
  }

  const { alwaysUseDraftMode } = settings as { alwaysUseDraftMode?: unknown };
  if (alwaysUseDraftMode !== undefined && typeof alwaysUseDraftMode !== "boolean") {
    throw new ScmSettingsValidationError("alwaysUseDraftMode must be a boolean");
  }
}

/**
 * Global defaults + per-repo overrides for source-control (SCM) behavior, such
 * as always opening pull/merge requests as drafts. Applies to both GitHub and
 * GitLab. A thin wrapper over the generic {@link IntegrationSettingsStore} that
 * pins the storage key to `scm` and validates the SCM-specific shape.
 */
export class ScmSettingsStore {
  private readonly store: IntegrationSettingsStore;

  constructor(db: D1Database) {
    this.store = new IntegrationSettingsStore(db);
  }

  getGlobal(): Promise<ScmGlobalConfig | null> {
    return this.store.getGlobal(SCM_SETTINGS_KEY);
  }

  async setGlobal(config: ScmGlobalConfig): Promise<void> {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new ScmSettingsValidationError("SCM settings must be an object");
    }
    // `scm` has no enable/disable-per-repo concept, so only `defaults` is
    // supported at the global level. Reject anything else (e.g. `enabledRepos`)
    // rather than silently persisting config that downstream resolution ignores.
    for (const key of Object.keys(config)) {
      if (key !== "defaults") {
        throw new ScmSettingsValidationError(`Unknown SCM global setting: ${key}`);
      }
    }
    if (config.defaults) {
      validateScmSettings(config.defaults);
    }
    await this.store.setGlobal(SCM_SETTINGS_KEY, config);
  }

  deleteGlobal(): Promise<void> {
    return this.store.deleteGlobal(SCM_SETTINGS_KEY);
  }

  getRepoSettings(repo: string): Promise<ScmSettings | null> {
    return this.store.getRepoSettings(SCM_SETTINGS_KEY, repo);
  }

  async setRepoSettings(repo: string, settings: ScmSettings): Promise<void> {
    validateScmSettings(settings);
    await this.store.setRepoSettings(SCM_SETTINGS_KEY, repo, settings);
  }

  deleteRepoSettings(repo: string): Promise<void> {
    return this.store.deleteRepoSettings(SCM_SETTINGS_KEY, repo);
  }

  listRepoSettings(): Promise<Array<{ repo: string; settings: ScmSettings }>> {
    return this.store.listRepoSettings(SCM_SETTINGS_KEY);
  }

  /** Resolve a repo's effective settings: global defaults merged with the per-repo override (override wins). */
  async getResolvedSettings(repo: string): Promise<ScmSettings> {
    const { settings } = await this.store.getResolvedConfig(SCM_SETTINGS_KEY, repo);
    return settings;
  }
}
