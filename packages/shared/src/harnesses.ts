/**
 * Agent harness catalog.
 *
 * A session runs on exactly one harness — the agent that sits behind the
 * sandbox runtime's `AgentHarness` seam. The catalog is the declared
 * capability record for each harness, and `checkHarnessCompatibility` is the
 * one rule applied wherever a model or a provider-auth selection enters a
 * session.
 *
 * An id enters the catalog together with the runtime that boots it: the
 * catalog is exactly the set a session can be created on, never a wider set
 * of recognized names.
 */

import { z } from "zod";
import {
  extractProviderAndModel,
  getReasoningConfig,
  getCodexReasoningConfig,
  getValidModelOrDefault,
  normalizeModelId,
} from "./models";
import type {
  ModelProviderSelections,
  ProviderAuthMode,
  SessionProviderAuthMode,
} from "./types/provider-accounts";

export const HARNESS_IDS = ["opencode", "claude", "codex"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export const DEFAULT_HARNESS: HarnessId = "opencode";
export const harnessIdSchema = z.enum(HARNESS_IDS);

export interface HarnessCapabilities {
  /** User-facing name. Never "Claude Code" (branding rule). */
  readonly label: string;
  /** Legacy sessions retain historical defaults; strict selections never silently fall back. */
  readonly selectionPolicy: "legacy_fallback" | "strict";
  /** Model providers (catalog id prefixes) the harness can run, or any. */
  readonly modelFamilies: "any" | readonly string[];
  /** Provider id → auth modes the harness can *select* for that provider. */
  readonly providerAuth: Readonly<Partial<Record<string, readonly ProviderAuthMode[]>>>;
  /** How a sandbox restore resumes the conversation. */
  readonly resume: "session_id";
}

export const HARNESS_CATALOG = {
  opencode: {
    label: "OpenCode",
    selectionPolicy: "legacy_fallback",
    modelFamilies: "any",
    providerAuth: {
      anthropic: ["api_key"],
      openai: ["api_key", "provider_account"],
      xai: ["api_key", "provider_account"],
    },
    resume: "session_id",
  },
  claude: {
    label: "Claude Agent",
    selectionPolicy: "legacy_fallback",
    modelFamilies: ["anthropic"],
    providerAuth: {
      anthropic: ["api_key", "provider_account"],
    },
    resume: "session_id",
  },
  codex: {
    label: "Codex",
    selectionPolicy: "strict",
    modelFamilies: ["openai"],
    providerAuth: { openai: ["api_key", "provider_account"] },
    resume: "session_id",
  },
} as const satisfies Record<HarnessId, HarnessCapabilities>;

export function isValidHarness(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value);
}

/** Resolve a harness from an optional wire value; absent means the built-in harness. */
export function getValidHarnessOrDefault(value: string | null | undefined): HarnessId {
  return isValidHarness(value) ? value : DEFAULT_HARNESS;
}

export function getHarnessCapabilities(harness: HarnessId): HarnessCapabilities {
  // Widen the literal catalog entry to the interface so callers index by string.
  return HARNESS_CATALOG[harness] as HarnessCapabilities;
}

export function getHarnessLabel(harness: HarnessId): string {
  return HARNESS_CATALOG[harness].label;
}

/** Preserve explicit native model ids; only legacy harnesses substitute defaults. */
export function resolveHarnessModel(harness: HarnessId, model?: string | null): string {
  return getHarnessCapabilities(harness).selectionPolicy === "strict"
    ? normalizeModelId(model ?? "")
    : getValidModelOrDefault(model);
}

/** Execution-time reasoning rejection is strict; legacy callers retain their effort fallback. */
export function checkHarnessPromptCompatibility(
  harness: HarnessId,
  model: string,
  reasoningEffort?: string | null
): HarnessCompatibilityError | null {
  return checkHarnessCompatibility(
    harness,
    model,
    undefined,
    getHarnessCapabilities(harness).selectionPolicy === "strict" ? reasoningEffort : undefined
  );
}

/** Routing input, unlike UI preferences, must not bind unreachable strict-harness accounts. */
export function selectHarnessProviderSelections(
  harness: HarnessId,
  selections: ModelProviderSelections
): ModelProviderSelections {
  const capabilities = getHarnessCapabilities(harness);
  if (capabilities.selectionPolicy === "legacy_fallback") return selections;
  return Object.fromEntries(
    Object.entries(selections).filter(
      ([provider]) => capabilities.providerAuth[provider] !== undefined
    )
  );
}

/** Whether the harness can run a model (by its catalog provider prefix). */
export function harnessSupportsModel(harness: HarnessId, model: string): boolean {
  if (harness === "codex") return getCodexReasoningConfig(model) !== undefined;
  const families = getHarnessCapabilities(harness).modelFamilies;
  if (families === "any") return true;
  const { provider } = extractProviderAndModel(model);
  return families.includes(provider);
}

/**
 * Whether the harness can run a provider under an auth mode.
 * `legacy_scoped_oauth` passes through only on legacy harnesses. Codex supports
 * connected Settings accounts and explicit API-key routing, never legacy OAuth.
 */
export function harnessSupportsProviderAuth(
  harness: HarnessId,
  provider: string,
  mode: SessionProviderAuthMode
): boolean {
  if (mode === "legacy_scoped_oauth")
    return getHarnessCapabilities(harness).selectionPolicy === "legacy_fallback";
  const modes = getHarnessCapabilities(harness).providerAuth[provider];
  // No row means the harness does not run the provider at all, so it cannot
  // select any auth mode for it either. The model check reports that to the
  // user; the auth resolver falls back to the API key.
  return modes !== undefined && modes.includes(mode);
}

/** Models from a list that the harness can run. */
export function filterModelsForHarness<T extends string>(
  harness: HarnessId,
  models: readonly T[]
): T[] {
  return models.filter((model) => harnessSupportsModel(harness, model));
}

/**
 * The auth mode each explicit provider selection asks for, in the shape
 * `checkHarnessCompatibility` takes. Providers without a selection are left
 * out: they resolve later, against the harness, in the auth resolver.
 */
export function selectedProviderAuthModes(
  selections: ModelProviderSelections
): Partial<Record<string, SessionProviderAuthMode>> {
  return Object.fromEntries(
    Object.entries(selections).flatMap(([provider, selection]) =>
      selection ? [[provider, selection.mode]] : []
    )
  );
}

/**
 * Explicit selections the harness can honour. A selection is dropped only
 * when the harness runs that provider but not in the selected mode (an
 * Anthropic account on OpenCode): kept, it would fail every session or run
 * created with it. A provider the harness does not run at all cannot be
 * reached through it, so that selection survives a switch back untouched.
 * Returns the same object when nothing changes.
 */
export function reconcileProviderSelectionsForHarness(
  harness: HarnessId,
  selections: ModelProviderSelections
): ModelProviderSelections {
  const providerAuth = getHarnessCapabilities(harness).providerAuth;
  const next: ModelProviderSelections = {};
  let changed = false;
  for (const [provider, selection] of Object.entries(selections)) {
    if (!selection) continue;
    const modes = providerAuth[provider];
    if (modes !== undefined && !modes.includes(selection.mode)) {
      changed = true;
      continue;
    }
    next[provider as keyof ModelProviderSelections] = selection;
  }
  return changed ? next : selections;
}

export interface HarnessCompatibilityError {
  readonly code: "model" | "provider_auth" | "reasoning_effort";
  readonly message: string;
}

/**
 * The one compatibility rule: can `harness` run `model` under the session's
 * resolved provider-auth modes? Applied at session create, prompt admission,
 * queued-message dispatch, child spawn, automation save, integration launch
 * and settings save, and installation default resolution. Returns null when
 * compatible. Callers refuse incompatible selections rather than switching
 * harnesses.
 */
export function checkHarnessCompatibility(
  harness: HarnessId,
  model: string,
  providerAuthModes?: Readonly<Partial<Record<string, SessionProviderAuthMode>>>,
  reasoningEffort?: string | null
): HarnessCompatibilityError | null {
  const label = getHarnessLabel(harness);
  if (!harnessSupportsModel(harness, model)) {
    return {
      code: "model",
      message: `Model "${model}" cannot run on the ${label} harness.`,
    };
  }
  if (reasoningEffort != null && !isValidHarnessReasoningEffort(harness, model, reasoningEffort)) {
    return {
      code: "reasoning_effort",
      message: `Reasoning effort "${reasoningEffort}" cannot run on ${model} with the ${label} harness.`,
    };
  }
  const { provider } = extractProviderAndModel(model);
  const mode = providerAuthModes?.[provider];
  if (mode && !harnessSupportsProviderAuth(harness, provider, mode)) {
    return {
      code: "provider_auth",
      message:
        mode === "provider_account"
          ? `The ${label} harness cannot use a connected ${provider} account; select an API key for this session.`
          : `The ${label} harness cannot run ${provider} in ${mode} mode.`,
    };
  }
  return null;
}

export function getHarnessReasoningConfig(harness: HarnessId, model: string) {
  return harness === "codex" ? getCodexReasoningConfig(model) : getReasoningConfig(model);
}

export function isValidHarnessReasoningEffort(
  harness: HarnessId,
  model: string,
  effort: string
): boolean {
  return (
    getHarnessReasoningConfig(harness, model)?.efforts.some((value) => value === effort) ?? false
  );
}
