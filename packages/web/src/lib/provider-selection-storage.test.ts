// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readStoredProviderSelections,
  storeProviderSelections,
} from "./provider-selection-storage";

const LEGACY_STORAGE_KEY = "open-inspect-last-provider-selections";
const STORAGE_KEY = "open-inspect-last-provider-selections:v1";
const selections = { openai: { mode: "api_key" as const } };

describe("provider selection storage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("stores and reads the current schema version", () => {
    storeProviderSelections(selections);

    expect(readStoredProviderSelections()).toEqual(selections);
  });

  it("migrates valid legacy selections", () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(selections));

    expect(readStoredProviderSelections()).toEqual(selections);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(selections));
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("retains legacy selections when writing the migrated value fails", () => {
    const serialized = JSON.stringify(selections);
    localStorage.setItem(LEGACY_STORAGE_KEY, serialized);
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === STORAGE_KEY) throw new DOMException("Storage full", "QuotaExceededError");
      originalSetItem.call(this, key, value);
    });

    expect(() => readStoredProviderSelections()).toThrow("Storage full");
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBe(serialized);
  });
});
