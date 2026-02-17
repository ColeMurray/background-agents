import { isValidModel } from "@open-inspect/shared";

export class ModelPreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPreferencesValidationError";
  }
}

export class ModelPreferencesStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Get the list of enabled model IDs, or null if no preferences stored.
   */
  async getEnabledModels(): Promise<string[] | null> {
    const row = await this.db
      .prepare("SELECT enabled_models FROM model_preferences WHERE id = 'global'")
      .first<{ enabled_models: string }>();

    if (!row) return null;

    return JSON.parse(row.enabled_models) as string[];
  }

  /**
   * Set the list of enabled model IDs.
   * Validates all IDs against VALID_MODELS.
   */
  async setEnabledModels(modelIds: string[]): Promise<void> {
    const unique = [...new Set(modelIds)];
    const invalid = unique.filter((id) => !isValidModel(id));
    if (invalid.length > 0) {
      throw new ModelPreferencesValidationError(`Invalid model IDs: ${invalid.join(", ")}`);
    }

    if (unique.length === 0) {
      throw new ModelPreferencesValidationError("At least one model must be enabled");
    }

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO model_preferences (id, enabled_models, updated_at)
         VALUES ('global', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled_models = excluded.enabled_models,
           updated_at = excluded.updated_at`
      )
      .bind(JSON.stringify(unique), now)
      .run();
  }
}
