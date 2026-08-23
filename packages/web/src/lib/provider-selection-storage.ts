import type { ModelProviderSelections } from "@open-inspect/shared/types/provider-accounts";
import { parseStoredProviderSelections } from "@/lib/provider-selection";

const STORAGE_KEY = "open-inspect-last-provider-selections:v1";
const LEGACY_STORAGE_KEY = "open-inspect-last-provider-selections";

export function readStoredProviderSelections(): ModelProviderSelections | null {
  const storedSelections = parseStoredProviderSelections(localStorage.getItem(STORAGE_KEY));
  if (storedSelections) return storedSelections;

  const legacyValue = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacyValue === null) return null;

  const legacySelections = parseStoredProviderSelections(legacyValue);
  if (!legacySelections) {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return null;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(legacySelections));
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  return legacySelections;
}

export function storeProviderSelections(selections: ModelProviderSelections): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(selections));
}
