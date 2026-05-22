import { isValidModel } from "@open-inspect/shared";

export class ModelPreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPreferencesValidationError";
  }
}

export interface ModelPreferences {
  enabledModels: string[];
  defaultModel: string | null;
  defaultPlanModel: string | null;
}

interface ModelPreferencesRow {
  enabled_models: string;
  default_model: string | null;
  default_plan_model: string | null;
}

export class ModelPreferencesStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Get the full singleton preferences row, or null if no preferences stored.
   */
  async getPreferences(): Promise<ModelPreferences | null> {
    const row = await this.db
      .prepare(
        "SELECT enabled_models, default_model, default_plan_model FROM model_preferences WHERE id = 'global'"
      )
      .first<ModelPreferencesRow>();

    if (!row) return null;

    return {
      enabledModels: JSON.parse(row.enabled_models) as string[],
      defaultModel: row.default_model,
      defaultPlanModel: row.default_plan_model,
    };
  }

  /**
   * Back-compat shim. Prefer getPreferences() for new callers.
   */
  async getEnabledModels(): Promise<string[] | null> {
    return (await this.getPreferences())?.enabledModels ?? null;
  }

  /**
   * Atomically persist the three preference fields. defaultModel /
   * defaultPlanModel may be null (= delegate to env/shared fallback). When
   * non-null, they must be members of enabledModels.
   */
  async setPreferences(prefs: ModelPreferences): Promise<void> {
    const unique = [...new Set(prefs.enabledModels)];
    const invalid = unique.filter((id) => !isValidModel(id));
    if (invalid.length > 0) {
      throw new ModelPreferencesValidationError(`Invalid model IDs: ${invalid.join(", ")}`);
    }

    if (unique.length === 0) {
      throw new ModelPreferencesValidationError("At least one model must be enabled");
    }

    const enabledSet = new Set(unique);

    if (prefs.defaultModel !== null) {
      if (!isValidModel(prefs.defaultModel)) {
        throw new ModelPreferencesValidationError(
          `Invalid default model ID: ${prefs.defaultModel}`
        );
      }
      if (!enabledSet.has(prefs.defaultModel)) {
        throw new ModelPreferencesValidationError(
          `Default model "${prefs.defaultModel}" is not in the enabled models list`
        );
      }
    }

    if (prefs.defaultPlanModel !== null) {
      if (!isValidModel(prefs.defaultPlanModel)) {
        throw new ModelPreferencesValidationError(
          `Invalid default plan model ID: ${prefs.defaultPlanModel}`
        );
      }
      if (!enabledSet.has(prefs.defaultPlanModel)) {
        throw new ModelPreferencesValidationError(
          `Default plan model "${prefs.defaultPlanModel}" is not in the enabled models list`
        );
      }
    }

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO model_preferences (id, enabled_models, default_model, default_plan_model, updated_at)
         VALUES ('global', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled_models     = excluded.enabled_models,
           default_model      = excluded.default_model,
           default_plan_model = excluded.default_plan_model,
           updated_at         = excluded.updated_at`
      )
      .bind(JSON.stringify(unique), prefs.defaultModel, prefs.defaultPlanModel, now)
      .run();
  }
}
