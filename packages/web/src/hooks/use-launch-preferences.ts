"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_HARNESS,
  getHarnessReasoningConfig,
  getValidHarnessOrDefault,
  reconcileProviderSelectionsForHarness,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import {
  DEFAULT_MODEL,
  type ModelCategory,
  type ReasoningEffort,
  type ValidModel,
} from "@open-inspect/shared/models";
import type {
  ModelProviderAccount,
  ModelProviderSelections,
  ProviderAuthSelection,
  SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import type { ModelPreference } from "@/lib/model-selection";
import {
  parseStoredProviderSelections,
  reconcileProviderSelections,
  setProviderSelection,
} from "@/lib/provider-selection";
import { resolveHarnessModelSelection } from "@/lib/session-harness";

const LAST_SELECTED_MODEL_STORAGE_KEY = "open-inspect-last-selected-model";
const LAST_SELECTED_HARNESS_STORAGE_KEY = "open-inspect-last-selected-harness";
const LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY = "open-inspect-last-selected-reasoning-effort";
const LEGACY_PROVIDER_SELECTIONS_STORAGE_KEY = "open-inspect-last-provider-selections";
const LAST_PROVIDER_SELECTIONS_STORAGE_KEY = "open-inspect-last-provider-selections:v1";

export type LaunchPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// Resolve localStorage only in effects and event handlers, never during SSR.
const browserStorage: LaunchPreferenceStorage = {
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Preferences continue in memory when storage is unavailable.
    }
  },
  removeItem: (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage is optional.
    }
  },
};

export interface LaunchPreferencesInput {
  models: {
    enabledModels: readonly string[];
    enabledModelOptions: ModelCategory[];
    loading: boolean;
  };
  providerAccounts: {
    accounts: ModelProviderAccount[];
    loading: boolean;
  };
}

export function useLaunchPreferences(
  { models, providerAccounts }: LaunchPreferencesInput,
  storage: LaunchPreferenceStorage = browserStorage
) {
  const { enabledModels, enabledModelOptions, loading: loadingEnabledModels } = models;
  const [storedPreference, setStoredPreference] = useState<ModelPreference>({
    model: DEFAULT_MODEL,
    reasoningEffort: getHarnessReasoningConfig(DEFAULT_HARNESS, DEFAULT_MODEL)?.default,
  });
  const [modelPreferenceDraft, setModelPreferenceDraft] = useState<ModelPreference | null>(null);
  const [harness, setHarness] = useState<HarnessId>(DEFAULT_HARNESS);
  const [providerSelections, setProviderSelections] = useState<ModelProviderSelections>({});
  const [providerSelectionsHydrated, setProviderSelectionsHydrated] = useState(false);
  const hasHydratedPreferencesRef = useRef(false);

  useEffect(() => {
    if (hasHydratedPreferencesRef.current) return;

    const storedModel = storage.getItem(LAST_SELECTED_MODEL_STORAGE_KEY);
    const storedReasoningEffort = storage.getItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
    const storedProviderSelectionsValue = storage.getItem(LAST_PROVIDER_SELECTIONS_STORAGE_KEY);
    const legacyProviderSelectionsValue =
      storedProviderSelectionsValue === null
        ? storage.getItem(LEGACY_PROVIDER_SELECTIONS_STORAGE_KEY)
        : null;
    const storedProviderSelections = parseStoredProviderSelections(
      storedProviderSelectionsValue ?? legacyProviderSelectionsValue
    );
    if (legacyProviderSelectionsValue !== null) {
      try {
        if (storedProviderSelections) {
          storage.setItem(
            LAST_PROVIDER_SELECTIONS_STORAGE_KEY,
            JSON.stringify(storedProviderSelections)
          );
        }
        // A best-effort write may fail silently; retain legacy pins until it is confirmed.
        if (
          !storedProviderSelections ||
          storage.getItem(LAST_PROVIDER_SELECTIONS_STORAGE_KEY) ===
            JSON.stringify(storedProviderSelections)
        ) {
          storage.removeItem(LEGACY_PROVIDER_SELECTIONS_STORAGE_KEY);
        }
      } catch {
        // Storage migration must not block provider-selection hydration.
      }
    }
    setStoredPreference({
      model: storedModel ?? DEFAULT_MODEL,
      reasoningEffort: storedReasoningEffort ?? undefined,
    });
    setHarness(getValidHarnessOrDefault(storage.getItem(LAST_SELECTED_HARNESS_STORAGE_KEY)));
    if (storedProviderSelections) setProviderSelections(storedProviderSelections);
    setProviderSelectionsHydrated(true);
    hasHydratedPreferencesRef.current = true;
  }, [storage]);

  const availableProviderSelections = reconcileProviderSelectionsForHarness(
    harness,
    providerAccounts.loading
      ? providerSelections
      : reconcileProviderSelections(providerSelections, providerAccounts.accounts)
  );

  useEffect(() => {
    if (
      !providerSelectionsHydrated ||
      providerAccounts.loading ||
      availableProviderSelections === providerSelections
    ) {
      return;
    }

    // Persist dropped pins only after the account list can be reconciled.
    setProviderSelections(availableProviderSelections);
    storage.setItem(
      LAST_PROVIDER_SELECTIONS_STORAGE_KEY,
      JSON.stringify(availableProviderSelections)
    );
  }, [
    availableProviderSelections,
    providerAccounts.loading,
    providerSelections,
    providerSelectionsHydrated,
    storage,
  ]);

  const modelSelection = useMemo(
    () =>
      resolveHarnessModelSelection({
        harness,
        preference: modelPreferenceDraft ?? storedPreference,
        enabledModels,
        enabledModelOptions,
        loading: loadingEnabledModels,
      }),
    [
      enabledModelOptions,
      enabledModels,
      harness,
      loadingEnabledModels,
      modelPreferenceDraft,
      storedPreference,
    ]
  );
  const { model: selectedModel, reasoningEffort } = modelSelection;
  const harnessHasModels = modelSelection.availability.status !== "unavailable";
  const providerReady = providerSelectionsHydrated && !providerAccounts.loading;

  function saveModelPreferenceDraft(preference: ModelPreference) {
    setModelPreferenceDraft(preference);
    storage.setItem(LAST_SELECTED_MODEL_STORAGE_KEY, preference.model);
    if (preference.reasoningEffort) {
      storage.setItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY, preference.reasoningEffort);
    } else {
      storage.removeItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
    }
  }

  function handleModelChange(model: ValidModel) {
    saveModelPreferenceDraft({
      model,
      reasoningEffort: getHarnessReasoningConfig(harness, model)?.default,
    });
  }

  function handleReasoningEffortChange(nextReasoningEffort: ReasoningEffort | undefined) {
    saveModelPreferenceDraft({ model: selectedModel, reasoningEffort: nextReasoningEffort });
  }

  function handleHarnessChange(nextHarness: HarnessId) {
    setHarness(nextHarness);
    storage.setItem(LAST_SELECTED_HARNESS_STORAGE_KEY, nextHarness);
  }

  function handleProviderSelectionChange(
    provider: SubscriptionProviderId,
    selection: ProviderAuthSelection | undefined
  ) {
    const next = setProviderSelection(availableProviderSelections, provider, selection);
    setProviderSelections(next);
    storage.setItem(LAST_PROVIDER_SELECTIONS_STORAGE_KEY, JSON.stringify(next));
  }

  return {
    selectedModel,
    reasoningEffort,
    harness,
    providerSelections: availableProviderSelections,
    modelOptions: modelSelection.options,
    modelAvailability: modelSelection.availability,
    // The send button intentionally uses provider readiness without model loading.
    providerReady,
    ready: providerReady && !loadingEnabledModels && harnessHasModels,
    handleModelChange,
    handleReasoningEffortChange,
    handleHarnessChange,
    handleProviderSelectionChange,
  };
}
