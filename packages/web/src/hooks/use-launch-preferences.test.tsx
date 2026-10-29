// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HARNESS, getHarnessReasoningConfig } from "@open-inspect/shared/harnesses";
import { DEFAULT_MODEL, type ModelCategory } from "@open-inspect/shared/models";
import type {
  ModelProviderAccount,
  ModelProviderSelections,
} from "@open-inspect/shared/types/provider-accounts";
import { useLaunchPreferences, type LaunchPreferencesInput } from "./use-launch-preferences";

const MODEL_KEY = "open-inspect-last-selected-model";
const HARNESS_KEY = "open-inspect-last-selected-harness";
const EFFORT_KEY = "open-inspect-last-selected-reasoning-effort";
const LEGACY_PROVIDER_KEY = "open-inspect-last-provider-selections";
const PROVIDER_KEY = "open-inspect-last-provider-selections:v1";
const OPENAI_MODEL = "openai/gpt-6.1-sol";
const account: ModelProviderAccount = {
  id: "a".repeat(32),
  provider: "openai",
  displayName: "Personal",
  externalAccountId: null,
  status: "active",
  createdBy: null,
  updatedBy: null,
  lastVerifiedAt: null,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
};
const pin: ModelProviderSelections = {
  openai: { mode: "provider_account", accountId: account.id },
};
const options: ModelCategory[] = [
  { category: "Anthropic", models: [{ id: DEFAULT_MODEL, name: "Default", description: "" }] },
  { category: "OpenAI", models: [{ id: OPENAI_MODEL, name: "OpenAI", description: "" }] },
];
const input: LaunchPreferencesInput = {
  models: {
    enabledModels: [DEFAULT_MODEL, OPENAI_MODEL],
    enabledModelOptions: options,
    loading: false,
  },
  providerAccounts: { accounts: [account], loading: false },
};

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  } satisfies Storage;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useLaunchPreferences", () => {
  it.each(["access", "read"])("hydrates defaults when browser storage %s fails", (failure) => {
    const storage = memoryStorage();
    const unavailable = () => {
      throw new DOMException("Storage is blocked", "SecurityError");
    };
    const access = vi.spyOn(window, "localStorage", "get");
    if (failure === "access") {
      access.mockImplementation(unavailable);
    } else {
      storage.getItem.mockImplementation(unavailable);
      access.mockReturnValue(storage);
    }

    const { result } = renderHook(() => useLaunchPreferences(input));

    expect(result.current).toMatchObject({
      selectedModel: DEFAULT_MODEL,
      harness: DEFAULT_HARNESS,
      providerSelections: {},
      providerReady: true,
      ready: true,
    });
    act(() => result.current.handleHarnessChange("codex"));
    act(() => result.current.handleReasoningEffortChange(undefined));
    expect(result.current.harness).toBe("codex");
  });

  it("keeps reconciled and edited preferences in memory when browser writes and removals fail", () => {
    const storage = memoryStorage({ [PROVIDER_KEY]: JSON.stringify(pin) });
    storage.setItem.mockImplementation(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    storage.removeItem.mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });
    vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
    const { result } = renderHook(() =>
      useLaunchPreferences({ ...input, providerAccounts: { accounts: [], loading: false } })
    );

    expect(result.current.providerSelections).toEqual({});
    expect(storage.setItem).toHaveBeenCalledWith(PROVIDER_KEY, "{}");
    act(() => result.current.handleHarnessChange("codex"));
    act(() => result.current.handleModelChange(OPENAI_MODEL));
    act(() => result.current.handleReasoningEffortChange(undefined));
    act(() => result.current.handleProviderSelectionChange("openai", { mode: "api_key" }));
    expect(result.current).toMatchObject({
      harness: "codex",
      selectedModel: OPENAI_MODEL,
      reasoningEffort: undefined,
      providerSelections: { openai: { mode: "api_key" } },
      ready: true,
    });
    expect(storage.removeItem).toHaveBeenCalledWith(EFFORT_KEY);
  });

  it("retains legacy pins when the browser adapter silently fails to write their replacement", () => {
    const storage = memoryStorage({ [LEGACY_PROVIDER_KEY]: JSON.stringify(pin) });
    storage.setItem.mockImplementation(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);

    const { result } = renderHook(() => useLaunchPreferences(input));

    expect(result.current.providerSelections).toEqual(pin);
    expect(result.current.ready).toBe(true);
    expect(storage.getItem(PROVIDER_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_PROVIDER_KEY)).toBe(JSON.stringify(pin));
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("does not access storage or report readiness during server rendering", () => {
    const storage = memoryStorage();
    function Probe() {
      const preferences = useLaunchPreferences(input, storage);
      expect(preferences.providerReady).toBe(false);
      expect(preferences.ready).toBe(false);
      return null;
    }

    renderToString(<Probe />);

    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("migrates legacy pins once and hydrates model, effort, and harness preferences", () => {
    const storage = memoryStorage({
      [LEGACY_PROVIDER_KEY]: JSON.stringify(pin),
      [MODEL_KEY]: OPENAI_MODEL,
      [EFFORT_KEY]: "max",
      [HARNESS_KEY]: "codex",
    });
    const { result, rerender } = renderHook(() => useLaunchPreferences(input, storage));

    expect(result.current).toMatchObject({
      selectedModel: OPENAI_MODEL,
      reasoningEffort: "max",
      harness: "codex",
      providerSelections: pin,
      providerReady: true,
      ready: true,
    });
    expect(storage.getItem(PROVIDER_KEY)).toBe(JSON.stringify(pin));
    expect(storage.getItem(LEGACY_PROVIDER_KEY)).toBeNull();
    rerender();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith(LEGACY_PROVIDER_KEY);
  });

  it("hydrates legacy pins even when the migration write fails", () => {
    const storage = memoryStorage({ [LEGACY_PROVIDER_KEY]: JSON.stringify(pin) });
    storage.setItem.mockImplementation(() => {
      throw new Error("Storage is full");
    });
    const { result } = renderHook(() => useLaunchPreferences(input, storage));

    expect(result.current.providerSelections).toEqual(pin);
    expect(result.current.ready).toBe(true);
    expect(storage.getItem(PROVIDER_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_PROVIDER_KEY)).toBe(JSON.stringify(pin));
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it.each([JSON.stringify({ openai: { mode: "api_key" } }), "{}", "invalid JSON"])(
    "prefers an existing versioned value over legacy pins: %s",
    (versioned) => {
      const storage = memoryStorage({
        [PROVIDER_KEY]: versioned,
        [LEGACY_PROVIDER_KEY]: JSON.stringify(pin),
      });
      const { result } = renderHook(() => useLaunchPreferences(input, storage));

      expect(result.current.providerSelections).toEqual(
        versioned === "invalid JSON" ? {} : JSON.parse(versioned)
      );
      expect(storage.getItem).not.toHaveBeenCalledWith(LEGACY_PROVIDER_KEY);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    }
  );

  it("removes invalid legacy data without creating a versioned selection", () => {
    const storage = memoryStorage({ [LEGACY_PROVIDER_KEY]: "invalid JSON" });
    const { result } = renderHook(() => useLaunchPreferences(input, storage));

    expect(result.current.providerSelections).toEqual({});
    expect(result.current.providerReady).toBe(true);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem(LEGACY_PROVIDER_KEY)).toBeNull();
  });

  it("keeps pins while accounts load and persists their removal only after reconciliation", () => {
    const storage = memoryStorage({ [PROVIDER_KEY]: JSON.stringify(pin) });
    const { result, rerender } = renderHook(
      (providerAccounts) => useLaunchPreferences({ ...input, providerAccounts }, storage),
      { initialProps: { accounts: [] as ModelProviderAccount[], loading: true } }
    );

    expect(result.current.providerSelections).toEqual(pin);
    expect(result.current.providerReady).toBe(false);
    expect(result.current.ready).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();

    rerender({ accounts: [account], loading: false });
    expect(result.current.providerSelections).toEqual(pin);
    expect(result.current.ready).toBe(true);
    expect(storage.setItem).not.toHaveBeenCalled();

    rerender({ accounts: [], loading: false });
    expect(result.current.providerSelections).toEqual({});
    expect(storage.getItem(PROVIDER_KEY)).toBe("{}");

    rerender({ accounts: [account], loading: false });
    expect(result.current.providerSelections).toEqual({});
  });

  it("drops incompatible harness pins permanently, but retains unrelated provider pins", () => {
    const anthropicAccount = { ...account, id: "b".repeat(32), provider: "anthropic" as const };
    const selections: ModelProviderSelections = {
      ...pin,
      anthropic: { mode: "provider_account", accountId: anthropicAccount.id },
    };
    const storage = memoryStorage({
      [HARNESS_KEY]: "claude",
      [PROVIDER_KEY]: JSON.stringify(selections),
    });
    const { result, rerender } = renderHook(
      (loading) =>
        useLaunchPreferences(
          { ...input, providerAccounts: { accounts: [account, anthropicAccount], loading } },
          storage
        ),
      { initialProps: true }
    );
    expect(result.current.providerSelections).toEqual(selections);

    act(() => result.current.handleHarnessChange("opencode"));
    expect(result.current.providerSelections).toEqual(pin);
    expect(storage.getItem(HARNESS_KEY)).toBe("opencode");
    expect(storage.getItem(PROVIDER_KEY)).toBe(JSON.stringify(selections));

    rerender(false);
    expect(storage.getItem(PROVIDER_KEY)).toBe(JSON.stringify(pin));
    act(() => result.current.handleHarnessChange("claude"));
    expect(result.current.providerSelections).toEqual(pin);
  });

  it("persists explicit provider changes and clearing a pin", () => {
    const storage = memoryStorage({ [PROVIDER_KEY]: JSON.stringify(pin) });
    const { result } = renderHook(() => useLaunchPreferences(input, storage));

    act(() => result.current.handleProviderSelectionChange("xai", { mode: "api_key" }));
    expect(result.current.providerSelections).toEqual({ ...pin, xai: { mode: "api_key" } });
    act(() => result.current.handleProviderSelectionChange("openai", undefined));
    expect(result.current.providerSelections).toEqual({ xai: { mode: "api_key" } });
    expect(storage.getItem(PROVIDER_KEY)).toBe(JSON.stringify({ xai: { mode: "api_key" } }));
  });

  it("separates provider readiness from model loading and unavailable models", () => {
    const storage = memoryStorage({ [HARNESS_KEY]: "claude", [MODEL_KEY]: OPENAI_MODEL });
    const { result, rerender } = renderHook(
      (models) => useLaunchPreferences({ ...input, models }, storage),
      { initialProps: { ...input.models, loading: true } }
    );

    expect(result.current.providerReady).toBe(true);
    expect(result.current.ready).toBe(false);
    expect(result.current.modelAvailability).toEqual({ status: "loading" });
    expect(result.current.selectedModel).toBe(OPENAI_MODEL);

    rerender(input.models);
    expect(result.current.ready).toBe(true);
    expect(result.current.selectedModel).toBe(DEFAULT_MODEL);
    expect(result.current.modelOptions).toEqual([options[0]]);
    expect(storage.getItem(MODEL_KEY)).toBe(OPENAI_MODEL);

    rerender({ enabledModels: [OPENAI_MODEL], enabledModelOptions: [options[1]], loading: false });
    expect(result.current.providerReady).toBe(true);
    expect(result.current.ready).toBe(false);
    expect(result.current.modelOptions).toEqual([]);
    expect(result.current.modelAvailability).toEqual({
      status: "unavailable",
      message: "No enabled models can run on Claude Agent.",
    });
  });

  it("falls back from invalid stored preferences without overwriting them", () => {
    const storage = memoryStorage({
      [MODEL_KEY]: "unknown-model",
      [HARNESS_KEY]: "unknown-harness",
      [EFFORT_KEY]: "unknown-effort",
    });
    const { result } = renderHook(() => useLaunchPreferences(input, storage));

    expect(result.current.harness).toBe(DEFAULT_HARNESS);
    expect(result.current.selectedModel).toBe(DEFAULT_MODEL);
    expect(result.current.reasoningEffort).toBe(
      getHarnessReasoningConfig(DEFAULT_HARNESS, DEFAULT_MODEL)?.default
    );
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("leaves absent effort unset, but model changes use the harness default and persist it", () => {
    const storage = memoryStorage();
    const { result } = renderHook(() => useLaunchPreferences(input, storage));

    expect(result.current.selectedModel).toBe(DEFAULT_MODEL);
    expect(result.current.reasoningEffort).toBeUndefined();
    act(() => result.current.handleHarnessChange("codex"));
    act(() => result.current.handleModelChange(OPENAI_MODEL));
    const defaultEffort = getHarnessReasoningConfig("codex", OPENAI_MODEL)?.default;
    expect(defaultEffort).toBe("low");
    expect(result.current.reasoningEffort).toBe(defaultEffort);
    expect(storage.getItem(MODEL_KEY)).toBe(OPENAI_MODEL);
    expect(storage.getItem(EFFORT_KEY)).toBe(defaultEffort);

    act(() => result.current.handleReasoningEffortChange("max"));
    expect(result.current.reasoningEffort).toBe("max");
    expect(storage.getItem(EFFORT_KEY)).toBe("max");
    act(() => result.current.handleReasoningEffortChange(undefined));
    expect(result.current.reasoningEffort).toBeUndefined();
    expect(storage.getItem(EFFORT_KEY)).toBeNull();
  });

  it("resolves drafts without overwriting them and edits effort on the resolved model", () => {
    const storage = memoryStorage();
    const { result } = renderHook(() => useLaunchPreferences(input, storage));

    act(() => result.current.handleModelChange(OPENAI_MODEL));
    act(() => result.current.handleHarnessChange("claude"));
    expect(result.current.selectedModel).toBe(DEFAULT_MODEL);
    expect(storage.getItem(MODEL_KEY)).toBe(OPENAI_MODEL);
    act(() => result.current.handleHarnessChange("opencode"));
    expect(result.current.selectedModel).toBe(OPENAI_MODEL);

    act(() => result.current.handleHarnessChange("claude"));
    act(() => result.current.handleReasoningEffortChange("high"));
    expect(storage.getItem(MODEL_KEY)).toBe(DEFAULT_MODEL);
    expect(storage.getItem(EFFORT_KEY)).toBe("high");
    act(() => result.current.handleHarnessChange("opencode"));
    expect(result.current.selectedModel).toBe(DEFAULT_MODEL);
  });
});
