import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  ModelPreferencesStore,
  ModelPreferencesValidationError,
} from "../../src/db/model-preferences";
import { cleanD1Tables } from "./cleanup";

describe("ModelPreferencesStore (D1 integration)", () => {
  beforeEach(cleanD1Tables);

  it("returns null when no row has been written yet", async () => {
    const store = new ModelPreferencesStore(env.DB);
    expect(await store.getPreferences()).toBeNull();
    expect(await store.getEnabledModels()).toBeNull();
  });

  it("upserts the singleton row and round-trips all three fields", async () => {
    const store = new ModelPreferencesStore(env.DB);

    await store.setPreferences({
      enabledModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"],
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultPlanModel: "anthropic/claude-opus-4-6",
    });

    expect(await store.getPreferences()).toEqual({
      enabledModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"],
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultPlanModel: "anthropic/claude-opus-4-6",
    });
  });

  it("persists null defaults (= delegate to env/shared fallback)", async () => {
    const store = new ModelPreferencesStore(env.DB);

    await store.setPreferences({
      enabledModels: ["anthropic/claude-haiku-4-5"],
      defaultModel: null,
      defaultPlanModel: null,
    });

    const prefs = await store.getPreferences();
    expect(prefs).toEqual({
      enabledModels: ["anthropic/claude-haiku-4-5"],
      defaultModel: null,
      defaultPlanModel: null,
    });
  });

  it("overwrites existing values on the second setPreferences call (upsert)", async () => {
    const store = new ModelPreferencesStore(env.DB);

    await store.setPreferences({
      enabledModels: ["anthropic/claude-haiku-4-5"],
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultPlanModel: null,
    });
    await store.setPreferences({
      enabledModels: ["anthropic/claude-opus-4-7"],
      defaultModel: "anthropic/claude-opus-4-7",
      defaultPlanModel: "anthropic/claude-opus-4-7",
    });

    expect(await store.getPreferences()).toEqual({
      enabledModels: ["anthropic/claude-opus-4-7"],
      defaultModel: "anthropic/claude-opus-4-7",
      defaultPlanModel: "anthropic/claude-opus-4-7",
    });
  });

  it("dedupes enabledModels", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await store.setPreferences({
      enabledModels: [
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-opus-4-6",
      ],
      defaultModel: null,
      defaultPlanModel: null,
    });
    expect((await store.getPreferences())?.enabledModels).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
    ]);
  });

  it("rejects empty enabledModels", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({ enabledModels: [], defaultModel: null, defaultPlanModel: null })
    ).rejects.toBeInstanceOf(ModelPreferencesValidationError);
  });

  it("rejects invalid model ids in enabledModels", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({
        enabledModels: ["not-a-real-model"],
        defaultModel: null,
        defaultPlanModel: null,
      })
    ).rejects.toBeInstanceOf(ModelPreferencesValidationError);
  });

  it("rejects a defaultModel that is not in enabledModels", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({
        enabledModels: ["anthropic/claude-haiku-4-5"],
        defaultModel: "anthropic/claude-opus-4-7",
        defaultPlanModel: null,
      })
    ).rejects.toThrow(/not in the enabled models list/);
  });

  it("rejects a defaultPlanModel that is not in enabledModels", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({
        enabledModels: ["anthropic/claude-haiku-4-5"],
        defaultModel: null,
        defaultPlanModel: "anthropic/claude-opus-4-7",
      })
    ).rejects.toThrow(/not in the enabled models list/);
  });

  it("rejects an invalid defaultModel id", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await expect(
      store.setPreferences({
        enabledModels: ["anthropic/claude-haiku-4-5"],
        defaultModel: "garbage",
        defaultPlanModel: null,
      })
    ).rejects.toThrow(/Invalid default model ID/);
  });

  it("getEnabledModels returns just the array for back-compat", async () => {
    const store = new ModelPreferencesStore(env.DB);
    await store.setPreferences({
      enabledModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"],
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultPlanModel: null,
    });
    expect(await store.getEnabledModels()).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
    ]);
  });
});
