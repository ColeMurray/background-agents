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

export interface ModelPreferencesSnapshot {
  enabledModels: ValidModel[];
  revision: number;
  storedCount: number;
  reconciled: boolean;
  fallbackApplied: boolean;
}

export class ModelPreferencesStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Resolve persisted preferences and reconciliation metadata through one decoding policy. */
  async getSnapshot(): Promise<ModelPreferencesSnapshot> {
    const row = await this.db
      .prepare("SELECT enabled_models, revision FROM model_preferences WHERE id = 'global'")
      .first<ModelPreferencesRow>();
    return this.decodeSnapshot(row);
  }

  /** Apply set-membership changes with compare-and-swap retries across concurrent writers. */
  async applyChanges(changes: readonly ModelPreferenceChange[]): Promise<ModelPreferencesSnapshot> {
    this.validateChanges(changes);

    for (let attempt = 0; attempt < MAX_MODEL_PREFERENCE_WRITE_ATTEMPTS; attempt += 1) {
      const row = await this.db
        .prepare("SELECT enabled_models, revision FROM model_preferences WHERE id = 'global'")
        .first<ModelPreferencesRow>();
      const current = this.decodeSnapshot(row);
      const next = applyModelPreferenceChanges(current.enabledModels, changes);
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

      if (result.meta.changes === 1) {
        return {
          enabledModels: next,
          revision: row ? row.revision + 1 : 1,
          storedCount: next.length,
          reconciled: false,
          fallbackApplied: false,
        };
      }
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

  private decodeSnapshot(row: ModelPreferencesRow | null): ModelPreferencesSnapshot {
    if (!row) {
      return {
        enabledModels: DEFAULT_ENABLED_MODELS,
        revision: 0,
        storedCount: 0,
        reconciled: false,
        fallbackApplied: true,
      };
    }

    let stored: string[] | null = null;
    try {
      const parsed: unknown = JSON.parse(row.enabled_models);
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
        stored = parsed;
      }
    } catch {
      // Malformed persisted values use the same default snapshot as unusable arrays.
    }

    const normalized = normalizeValidModels(stored ?? []);
    const enabledModels = normalized.length > 0 ? normalized : DEFAULT_ENABLED_MODELS;
    return {
      enabledModels,
      revision: row.revision,
      storedCount: stored?.length ?? 0,
      reconciled: !stored || JSON.stringify(enabledModels) !== JSON.stringify(stored),
      fallbackApplied: normalized.length === 0,
    };
  }
}

/** Resolve the currently enabled catalog, using defaults only when no usable preferences exist. */
export async function getEffectiveEnabledModels(db: SqlDatabase): Promise<ValidModel[]> {
  return (await new ModelPreferencesStore(db).getSnapshot()).enabledModels;
}
