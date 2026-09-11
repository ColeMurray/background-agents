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
import { extractProviderAndModel } from "./models";
import type {
  ModelProviderSelections,
  ProviderAuthMode,
  SessionProviderAuthMode,
} from "./types/provider-accounts";

export const HARNESS_IDS = ["opencode", "claude"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export const DEFAULT_HARNESS: HarnessId = "opencode";
export const harnessIdSchema = z.enum(HARNESS_IDS);

export interface HarnessCapabilities {
  /** User-facing name. Never "Claude Code" (branding rule). */
  readonly label: string;
  /** Model providers (catalog id prefixes) the harness can run, or any. */
  readonly modelFamilies: "any" | readonly string[];
  /** Provider id → auth modes the harness can *select* for that provider. */
  readonly providerAuth: Readonly<Partial<Record<string, readonly ProviderAuthMode[]>>>;
  /** Whether the harness surfaces thinking text to the timeline. */
  readonly reasoningDisplay: boolean;
  /** How a sandbox restore resumes the conversation. */
  readonly resume: "session_id";
}

export const HARNESS_CATALOG = {
  opencode: {
    label: "OpenCode",
    modelFamilies: "any",
    providerAuth: {
      anthropic: ["api_key"],
      openai: ["api_key", "provider_account"],
      xai: ["api_key", "provider_account"],
    },
    reasoningDisplay: false,
    resume: "session_id",
  },
  claude: {
    label: "Claude Agent",
    modelFamilies: ["anthropic"],
    providerAuth: {
      anthropic: ["api_key", "provider_account"],
    },
    reasoningDisplay: true,
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

/** Whether the harness can run a model (by its catalog provider prefix). */
export function harnessSupportsModel(harness: HarnessId, model: string): boolean {
  const families = getHarnessCapabilities(harness).modelFamilies;
  if (families === "any") return true;
  const { provider } = extractProviderAndModel(model);
  return families.includes(provider);
}

/**
 * Whether the harness can run a provider under an auth mode.
 * `legacy_scoped_oauth` is resolver-assigned, not selectable, and passes through.
 */
export function harnessSupportsProviderAuth(
  harness: HarnessId,
  provider: string,
  mode: SessionProviderAuthMode
): boolean {
  if (mode === "legacy_scoped_oauth") return true;
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

export interface HarnessCompatibilityError {
  readonly code: "model" | "provider_auth";
  readonly message: string;
}

/**
 * The one compatibility rule: can `harness` run `model` under the session's
 * resolved provider-auth modes? Applied at session create, prompt admission,
 * queued-message dispatch, child spawn, automation save, and installation
 * default resolution. Returns null when compatible.
 */
export function checkHarnessCompatibility(
  harness: HarnessId,
  model: string,
  providerAuthModes?: Readonly<Partial<Record<string, SessionProviderAuthMode>>>
): HarnessCompatibilityError | null {
  const label = getHarnessLabel(harness);
  if (!harnessSupportsModel(harness, model)) {
    return {
      code: "model",
      message: `Model "${model}" cannot run on the ${label} harness.`,
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
