import {
  checkHarnessCompatibility,
  filterModelsForHarness,
  getHarnessReasoningConfig,
  getHarnessCapabilities,
  getHarnessLabel,
  isValidHarnessReasoningEffort,
  resolveHarnessModel,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import {
  getValidModelOrDefault,
  isValidReasoningEffort,
  normalizeModelId,
  resolveEnabledModel,
  type ReasoningEffort,
  type ValidModel,
} from "@open-inspect/shared/models";
import { ModelPreferencesStore } from "./db/model-preferences";
import type { SqlDatabase } from "./db/sql-database";
import type {
  ModelProviderSelections,
  SessionProviderAuthMode,
} from "@open-inspect/shared/types/provider-accounts";
import { resolveSessionProviderAuth } from "./session/provider-account-resolution";

export class HarnessAdmissionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400
  ) {
    super(message);
  }
}

/** The internal session boundary must retain the public admission's exact native choice. */
export function resolveHarnessInitialization(
  harness: HarnessId,
  input: { model?: string; reasoningEffort?: string | null }
): { model: string; reasoningEffort?: string } {
  const model = resolveHarnessModel(harness, input.model);
  if (getHarnessCapabilities(harness).selectionPolicy === "legacy_fallback")
    return { model, reasoningEffort: input.reasoningEffort ?? undefined };
  const incompatible = checkHarnessCompatibility(harness, model, undefined, input.reasoningEffort);
  if (incompatible) throw new HarnessAdmissionError(incompatible.message);
  return {
    model,
    reasoningEffort: input.reasoningEffort ?? getHarnessReasoningConfig(harness, model)?.default,
  };
}

/** Resolve new execution selections without silently replacing an explicit Codex model. */
export async function resolveHarnessSelection(
  db: SqlDatabase,
  input: {
    harness: HarnessId;
    model?: string | null;
    reasoningEffort?: string | null;
  },
  enabledModels?: readonly ValidModel[]
): Promise<{ model: ValidModel; reasoningEffort: ReasoningEffort | null }> {
  if (getHarnessCapabilities(input.harness).selectionPolicy === "legacy_fallback") {
    const model = getValidModelOrDefault(input.model);
    const incompatible = checkHarnessCompatibility(input.harness, model);
    if (incompatible) throw new HarnessAdmissionError(incompatible.message);
    return {
      model,
      reasoningEffort:
        input.reasoningEffort && isValidReasoningEffort(model, input.reasoningEffort)
          ? (input.reasoningEffort as ReasoningEffort)
          : null,
    };
  }
  // Storage failures deliberately fail closed; a fallback catalog is not an
  // authorization to run a disabled model.
  const enabled = filterModelsForHarness(
    input.harness,
    enabledModels ?? (await new ModelPreferencesStore(db).getEnabledModels())
  );
  const model = input.model == null ? enabled[0] : normalizeModelId(input.model);
  if (model === undefined)
    throw new HarnessAdmissionError(
      `No qualified ${getHarnessLabel(input.harness)} model is enabled. Enable a compatible model in Settings.`,
      409
    );
  const incompatible = checkHarnessCompatibility(
    input.harness,
    model,
    undefined,
    input.reasoningEffort
  );
  if (incompatible) throw new HarnessAdmissionError(incompatible.message);
  if (!enabled.includes(model as (typeof enabled)[number]))
    throw new HarnessAdmissionError(`Model "${model}" is not enabled for this deployment.`);
  return {
    model: model as ValidModel,
    reasoningEffort: (input.reasoningEffort ??
      getHarnessReasoningConfig(input.harness, model)?.default ??
      null) as ReasoningEffort | null,
  };
}

/** Recheck mutable deployment policy before execution, without changing legacy dispatch semantics. */
export async function validateHarnessExecution(
  db: SqlDatabase,
  input: { harness: HarnessId; model: string; reasoningEffort?: string | null },
  providerAuthModes?: Readonly<Partial<Record<string, SessionProviderAuthMode>>>
): Promise<void> {
  if (getHarnessCapabilities(input.harness).selectionPolicy === "legacy_fallback") return;
  await resolveHarnessSelection(db, input);
  const incompatible = checkHarnessCompatibility(
    input.harness,
    input.model,
    providerAuthModes,
    input.reasoningEffort
  );
  if (incompatible) throw new HarnessAdmissionError(incompatible.message);
}

/** Validate live defaults on save, but never turn them into persisted automation pins. */
export async function validateHarnessAutomationAuth(
  db: SqlDatabase,
  harness: HarnessId,
  model: string,
  explicit: ModelProviderSelections
): Promise<void> {
  if (getHarnessCapabilities(harness).selectionPolicy === "legacy_fallback") return;
  const resolved = await resolveSessionProviderAuth(db, { harness, unattended: true, explicit });
  const incompatible = checkHarnessCompatibility(
    harness,
    model,
    Object.fromEntries(resolved.map((auth) => [auth.provider, auth.authMode]))
  );
  if (incompatible) throw new HarnessAdmissionError(incompatible.message);
}

/**
 * An inherited effort (from a parent, the stored automation or the session) applies
 * only when the destination model supports it; otherwise the destination's own
 * default applies. Explicit efforts are never inherited and are validated as given.
 */
export function inheritReasoningEffort(
  harness: HarnessId,
  model: string,
  inherited: string | null | undefined
): string | undefined {
  return inherited && isValidHarnessReasoningEffort(harness, model, inherited)
    ? inherited
    : undefined;
}

/** Children inherit only efforts valid for their selected model. Native defaults must be enabled. */
export async function resolveChildHarnessSelection(
  db: SqlDatabase,
  parent: { harness: HarnessId; model: string; reasoningEffort: string | null },
  requested: { model?: string; reasoningEffort?: string },
  enabledModels: ValidModel[]
): Promise<{ model: ValidModel; reasoningEffort: ReasoningEffort | null }> {
  const strict = getHarnessCapabilities(parent.harness).selectionPolicy === "strict";
  const inheritedModel = getValidModelOrDefault(requested.model ?? parent.model);
  const compatible = strict ? filterModelsForHarness(parent.harness, enabledModels) : enabledModels;
  const model = strict
    ? (requested.model ?? compatible.find((model) => model === inheritedModel) ?? compatible[0])
    : resolveEnabledModel({ model: inheritedModel, enabledModels });
  const inheritedEffort = model
    ? inheritReasoningEffort(parent.harness, model, parent.reasoningEffort)
    : undefined;
  if (
    requested.reasoningEffort !== undefined &&
    model &&
    !isValidHarnessReasoningEffort(parent.harness, model, requested.reasoningEffort)
  ) {
    const validEfforts = getHarnessReasoningConfig(parent.harness, model)?.efforts;
    const suffix = validEfforts?.length
      ? ` Valid efforts: ${validEfforts.join(", ")}`
      : " This model does not support reasoning effort overrides.";
    throw new HarnessAdmissionError(
      `Invalid reasoning effort "${requested.reasoningEffort}" for model "${model}".${suffix}`
    );
  }
  return resolveHarnessSelection(
    db,
    {
      harness: parent.harness,
      model,
      reasoningEffort: requested.reasoningEffort ?? inheritedEffort,
    },
    enabledModels
  );
}

/** Metadata-only automation edits must not depend on current execution availability. */
export async function resolveHarnessAutomationUpdate(
  db: SqlDatabase,
  existing: { model: string; reasoningEffort: string | null },
  input: {
    harness: HarnessId;
    model?: string;
    reasoningEffort?: string | null;
    executionChanged: boolean;
  }
): Promise<{ model: string; reasoningEffort: string | null }> {
  const model =
    input.model === undefined ? existing.model : resolveHarnessModel(input.harness, input.model);
  if (getHarnessCapabilities(input.harness).selectionPolicy === "strict" && input.executionChanged)
    return resolveHarnessSelection(db, {
      harness: input.harness,
      model,
      reasoningEffort:
        input.reasoningEffort !== undefined
          ? input.reasoningEffort
          : inheritReasoningEffort(input.harness, model, existing.reasoningEffort),
    });
  if (!input.executionChanged) return { model, reasoningEffort: existing.reasoningEffort };
  const effort =
    input.reasoningEffort !== undefined ? input.reasoningEffort : existing.reasoningEffort;
  return {
    model,
    reasoningEffort:
      effort && isValidReasoningEffort(model, effort) ? (effort as ReasoningEffort) : null,
  };
}
