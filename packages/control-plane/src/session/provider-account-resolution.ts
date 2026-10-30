import { extractProviderAndModel } from "@open-inspect/shared/models";
import {
  SUBSCRIPTION_PROVIDER_IDS,
  type ModelProviderSelections,
  type ProviderAccountRouting,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import {
  getHarnessCapabilities,
  harnessSupportsProviderAuth,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import { ProviderDefaultStore } from "../db/provider-account-defaults";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { SessionIndexStore } from "../db/session-index";
import type { SessionModelProviderAuthInput } from "../model-provider-accounts/provider-auth-contracts";
import type { SqlDatabase } from "../db/sql-database";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import {
  ProviderAccountSelectionPolicy,
  ProviderAccountSelectionPolicyError,
  type ProviderAccountAdapterLookup,
} from "../model-provider-accounts/selection-policy";

interface ProviderAccountResolutionStores {
  defaults: Pick<ProviderDefaultStore, "get">;
  routing?: Pick<ProviderDefaultStore, "getRouting">;
  /** Inclusive of 0 and exclusive of 1. Defaults to Math.random. */
  random?: () => number;
  accounts: Pick<ModelProviderAccountStore, "getById">;
  adapters: ProviderAccountAdapterLookup;
}

/**
 * What a provider resolves to when nothing was selected and no default exists.
 * OpenAI and xAI keep the legacy scoped-OAuth path their plugins understand;
 * Anthropic never had one, so it falls back to the API key (the platform key
 * or a user secret), never to a placeholder.
 */
function noSelectionFallback(provider: SubscriptionProviderId): SessionModelProviderAuthInput {
  if (LEGACY_SCOPED_OAUTH_PROVIDERS.has(provider)) {
    return { provider, authMode: "legacy_scoped_oauth", selectionSource: "legacy_fallback" };
  }
  return apiKey(provider, "api_key_fallback");
}

const LEGACY_SCOPED_OAUTH_PROVIDERS: ReadonlySet<SubscriptionProviderId> = new Set([
  "openai",
  "xai",
]);

export interface ProviderAccountResolutionInput {
  /**
   * When a row for this id already exists, its stored provider auth is returned
   * unchanged. Creating a session allocates a new id, so this does not make an
   * HTTP retry of `POST /sessions` draw the same account.
   */
  sessionId?: string;
  /** From `PROVIDER_ACCOUNT_RANDOM_ENABLED`. Random pools are refused while this is false. */
  randomEnabled?: boolean;
  /** Catalog model being started. Scopes a disabled random pool to its provider. */
  model: string;
  explicit?: ModelProviderSelections;
  unattended: boolean;
  /**
   * The session's harness. An installation default only applies where the
   * harness can select a provider account; otherwise the provider resolves
   * to api_key (selectionSource "harness_fallback") rather than binding an
   * account the harness cannot use.
   */
  harness: HarnessId;
}

/** Subscription provider that bills `model`, or null when the model is not one of those providers. */
function subscriptionProviderForModel(model: string): SubscriptionProviderId | null {
  const { provider } = extractProviderAndModel(model);
  return (SUBSCRIPTION_PROVIDER_IDS as readonly string[]).includes(provider)
    ? (provider as SubscriptionProviderId)
    : null;
}

function apiKey(
  provider: SubscriptionProviderId,
  selectionSource: string
): SessionModelProviderAuthInput {
  return { provider, authMode: "api_key", selectionSource };
}

async function resolveProvider(
  provider: SubscriptionProviderId,
  input: ProviderAccountResolutionInput,
  stores: ProviderAccountResolutionStores,
  policy: ProviderAccountSelectionPolicy
): Promise<SessionModelProviderAuthInput> {
  // Preserve the complete routing shape without binding unreachable strict-harness accounts.
  const capabilities = getHarnessCapabilities(input.harness);
  if (
    capabilities.selectionPolicy === "strict" &&
    capabilities.providerAuth[provider] === undefined
  ) {
    return apiKey(provider, "harness_fallback");
  }
  const explicit = input.explicit?.[provider];
  if (explicit?.mode === "api_key") return apiKey(provider, "explicit");
  if (explicit?.mode === "provider_account") {
    const account = await policy.validateSelection(provider, explicit.accountId);
    return {
      provider,
      authMode: "provider_account",
      providerAccountId: account.id,
      selectionSource: "explicit",
    };
  }

  const routing = stores.routing ? await stores.routing.getRouting(provider) : null;
  if (routing && routing.selection.mode !== "unconfigured") {
    return resolveInstallationRouting(provider, routing, input, stores, policy);
  }

  const providerDefault = await stores.defaults.get(provider);
  if (!providerDefault) {
    // A strict harness has no legacy scoped-OAuth path; with nothing selected it
    // runs on the API key (platform key or user secret), as Anthropic does.
    if (capabilities.selectionPolicy === "strict") return apiKey(provider, "api_key_fallback");
    return noSelectionFallback(provider);
  }
  if (!harnessSupportsProviderAuth(input.harness, provider, "provider_account")) {
    return apiKey(provider, "harness_fallback");
  }
  if (input.unattended && providerDefault.unattendedMode === "api_key") {
    return apiKey(provider, "unattended_policy");
  }

  const account = await policy.validateDefault(provider, providerDefault.providerAccountId);
  return {
    provider,
    authMode: "provider_account",
    providerAccountId: account.id,
    selectionSource: input.unattended ? "unattended_policy" : "installation_default",
  };
}

/**
 * Apply a configured fixed default or random pool. A disabled flag or an empty
 * pool fails only the provider that bills the selected model. Every other
 * provider keeps its harness fallback so the three-provider snapshot still closes.
 */
async function resolveInstallationRouting(
  provider: SubscriptionProviderId,
  routing: ProviderAccountRouting,
  input: ProviderAccountResolutionInput,
  stores: ProviderAccountResolutionStores,
  policy: ProviderAccountSelectionPolicy
): Promise<SessionModelProviderAuthInput> {
  if (!harnessSupportsProviderAuth(input.harness, provider, "provider_account")) {
    return apiKey(provider, "harness_fallback");
  }
  if (input.unattended && routing.unattendedMode === "api_key") {
    return apiKey(provider, "unattended_policy");
  }
  if (routing.selection.mode === "random" && !input.randomEnabled) {
    if (subscriptionProviderForModel(input.model) === provider) {
      throw new ProviderAccountSelectionPolicyError(
        "Random provider allocation is temporarily unavailable",
        409
      );
    }
    const capabilities = getHarnessCapabilities(input.harness);
    if (capabilities.selectionPolicy === "strict") return apiKey(provider, "api_key_fallback");
    return noSelectionFallback(provider);
  }
  if (routing.selection.mode === "random") {
    const candidates = (
      await Promise.all(
        routing.selection.accountIds.map(async (id) => {
          try {
            return await policy.validateSelection(provider, id);
          } catch (error) {
            if (error instanceof ProviderAccountSelectionPolicyError) return null;
            throw error;
          }
        })
      )
    ).filter((account) => account !== null);
    if (!candidates.length) {
      if (subscriptionProviderForModel(input.model) === provider) {
        throw new ProviderAccountSelectionPolicyError(
          "No eligible accounts in the configured provider pool",
          409
        );
      }
      const capabilities = getHarnessCapabilities(input.harness);
      if (capabilities.selectionPolicy === "strict") return apiKey(provider, "api_key_fallback");
      return noSelectionFallback(provider);
    }
    const draw = (stores.random ?? Math.random)();
    if (!(draw >= 0 && draw < 1)) throw new Error("Invalid provider allocation random value");
    return {
      provider,
      authMode: "provider_account",
      providerAccountId: candidates[Math.floor(draw * candidates.length)].id,
      selectionSource: "installation_random",
    };
  }
  if (routing.selection.mode !== "fixed") {
    return apiKey(provider, "api_key_fallback");
  }
  const account = await policy.validateDefault(provider, routing.selection.accountId);
  return {
    provider,
    authMode: "provider_account",
    providerAccountId: account.id,
    selectionSource: input.unattended ? "unattended_policy" : "installation_default",
  };
}

function assertStableRetryIntent(
  explicit: ModelProviderSelections | undefined,
  existing: readonly SessionModelProviderAuthInput[]
): void {
  if (!explicit) return;
  for (const binding of existing) {
    const requested = explicit[binding.provider];
    if (!requested) continue;
    const accountMismatch =
      requested.mode === "provider_account" &&
      (binding.authMode !== "provider_account" ||
        requested.accountId !== binding.providerAccountId);
    if (requested.mode !== binding.authMode || accountMismatch) {
      throw new ProviderAccountSelectionPolicyError("session_creation_intent_conflict", 409);
    }
  }
}

/** Resolve one auth row per subscription provider, in catalog order. */
export async function resolveProviderAccountSelections(
  input: ProviderAccountResolutionInput,
  stores: ProviderAccountResolutionStores
): Promise<SessionModelProviderAuthInput[]> {
  const policy = new ProviderAccountSelectionPolicy(stores.accounts, stores.adapters);
  return Promise.all(
    SUBSCRIPTION_PROVIDER_IDS.map((provider) => resolveProvider(provider, input, stores, policy))
  );
}

/**
 * Resolve the complete provider-auth snapshot for a new session. A session row
 * that already exists is returned as stored, so a second resolve for that id
 * does not draw again.
 */
export async function resolveSessionProviderAuth(
  db: SqlDatabase,
  input: ProviderAccountResolutionInput
): Promise<SessionModelProviderAuthInput[]> {
  if (input.sessionId) {
    const sessions = new SessionIndexStore(db);
    if (await sessions.get(input.sessionId)) {
      const existing = await sessions.getCompleteProviderAuth(input.sessionId);
      assertStableRetryIntent(input.explicit, existing);
      return existing;
    }
  }
  const defaults = new ProviderDefaultStore(db);
  return resolveProviderAccountSelections(input, {
    defaults,
    routing: defaults,
    accounts: new ModelProviderAccountStore(db),
    adapters: modelProviderAccountAdapterRegistry,
  });
}
