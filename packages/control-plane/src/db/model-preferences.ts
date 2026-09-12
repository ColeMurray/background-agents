import {
  DEFAULT_ENABLED_MODELS,
  applyModelPreferenceChanges,
  isValidModel,
  normalizeValidModels,
  normalizeModelId,
  type ModelPreferenceChange,
  type ValidModel,
} from "@open-inspect/shared/models";
import type { SqlDatabase } from "./sql-database";

const MAX_MODEL_PREFERENCE_WRITE_ATTEMPTS = 3;

export class ModelPreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPreferencesValidationError";
  }
}

export class ModelPreferencesConflictError extends Error {
  constructor() {
    super("Model preferences changed too frequently; retry the update");
    this.name = "ModelPreferencesConflictError";
  }
}

interface ModelPreferencesRow {
  enabled_models: string;
  revision: number;
}

export class ModelPreferencesStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Get the list of enabled model IDs, or null if no preferences stored.
   */
  async getEnabledModels(): Promise<string[] | null> {
    const row = await this.db
      .prepare("SELECT enabled_models FROM model_preferences WHERE id = 'global'")
      .first<{ enabled_models: string }>();

    if (!row) return null;

    const enabledModels: unknown = JSON.parse(row.enabled_models);
    if (!Array.isArray(enabledModels) || !enabledModels.every((id) => typeof id === "string")) {
      throw new Error("Stored model preferences must be an array of strings");
    }

    return enabledModels;
  }

  /**
   * Set the list of enabled model IDs.
   * Validates all IDs against VALID_MODELS.
   */
  async setEnabledModels(modelIds: string[]): Promise<ValidModel[]> {
    const invalid = [...new Set(modelIds)].filter((id) => !isValidModel(id));
    if (invalid.length > 0) {
      throw new ModelPreferencesValidationError(`Invalid model IDs: ${invalid.join(", ")}`);
    }

    const normalized = normalizeValidModels(modelIds);
    if (normalized.length === 0) {
      throw new ModelPreferencesValidationError("At least one model must be enabled");
    }

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO model_preferences (id, enabled_models, updated_at)
         VALUES ('global', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled_models = excluded.enabled_models,
           updated_at = excluded.updated_at,
           revision = model_preferences.revision + 1`
      )
      .bind(JSON.stringify(normalized), now)
      .run();

    return normalized;
  }

  /** Apply set-membership changes with compare-and-swap retries across concurrent writers. */
  async applyChanges(changes: readonly ModelPreferenceChange[]): Promise<ValidModel[]> {
    this.validateChanges(changes);

    for (let attempt = 0; attempt < MAX_MODEL_PREFERENCE_WRITE_ATTEMPTS; attempt += 1) {
      const row = await this.db
        .prepare("SELECT enabled_models, revision FROM model_preferences WHERE id = 'global'")
        .first<ModelPreferencesRow>();
      const current = row ? this.parseEffectiveModels(row.enabled_models) : DEFAULT_ENABLED_MODELS;
      const next = applyModelPreferenceChanges(current, changes);
      if (next.length === 0) {
        throw new ModelPreferencesValidationError("At least one model must be enabled");
      }

      const now = Date.now();
      const result = row
        ? await this.db
            .prepare(
              `UPDATE model_preferences
               SET enabled_models = ?, updated_at = ?, revision = revision + 1
               WHERE id = 'global' AND revision = ?`
            )
            .bind(JSON.stringify(next), now, row.revision)
            .run()
        : await this.db
            .prepare(
              `INSERT INTO model_preferences (id, enabled_models, updated_at, revision)
               VALUES ('global', ?, ?, 1)
               ON CONFLICT(id) DO NOTHING`
            )
            .bind(JSON.stringify(next), now)
            .run();

      if (result.meta.changes === 1) return next;
    }

    throw new ModelPreferencesConflictError();
  }

  private validateChanges(changes: readonly ModelPreferenceChange[]): void {
    if (changes.length === 0) {
      throw new ModelPreferencesValidationError("At least one model preference change is required");
    }

    const seen = new Set<string>();
    for (const change of changes) {
      if (!isValidModel(change.modelId) || normalizeModelId(change.modelId) !== change.modelId) {
        throw new ModelPreferencesValidationError(`Invalid canonical model ID: ${change.modelId}`);
      }
      if (seen.has(change.modelId)) {
        throw new ModelPreferencesValidationError(`Duplicate model preference: ${change.modelId}`);
      }
      seen.add(change.modelId);
    }
  }

  private parseEffectiveModels(value: string): ValidModel[] {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
        const normalized = normalizeValidModels(parsed);
        if (normalized.length > 0) return normalized;
      }
    } catch {
      // A successful patch repairs malformed legacy storage from the defaults.
    }
    return DEFAULT_ENABLED_MODELS;
  }
}

/** Resolve the currently enabled catalog, using defaults only when no usable preferences exist. */
export async function getEffectiveEnabledModels(db: SqlDatabase): Promise<ValidModel[]> {
  const stored = await new ModelPreferencesStore(db).getEnabledModels();
  if (!stored) return DEFAULT_ENABLED_MODELS;

  const normalized = normalizeValidModels(stored);
  return normalized.length > 0 ? normalized : DEFAULT_ENABLED_MODELS;
}
