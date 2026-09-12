import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { DEFAULT_ENABLED_MODELS } from "@open-inspect/shared/models";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

async function seedPreferences(enabledModels: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO model_preferences (id, enabled_models, updated_at) VALUES ('global', ?, ?)"
  )
    .bind(JSON.stringify(enabledModels), Date.now())
    .run();
}

async function getStoredModels(): Promise<unknown> {
  const row = await env.DB.prepare(
    "SELECT enabled_models FROM model_preferences WHERE id = 'global'"
  ).first<{ enabled_models: string }>();
  return row ? JSON.parse(row.enabled_models) : null;
}

async function getStoredRevision(): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT revision FROM model_preferences WHERE id = 'global'"
  ).first<{ revision: number }>();
  return row?.revision ?? null;
}

function patchPreferences(changes: Array<{ modelId: string; enabled: boolean }>) {
  return serviceFetch("https://test.local/model-preferences", {
    method: "PATCH",
    body: JSON.stringify({ changes }),
  });
}

describe("Model preferences API", () => {
  beforeEach(cleanD1Tables);

  it("rejects legacy PUT writes without replacing preferences", async () => {
    const stored = ["anthropic/claude-sonnet-4-6"];
    await seedPreferences(stored);
    const response = await serviceFetch("https://test.local/model-preferences", {
      method: "PUT",
      body: JSON.stringify({ enabledModels: ["openai/gpt-5.4"] }),
    });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: "PUT model preferences updates are no longer supported; use PATCH",
    });
    expect(await getStoredModels()).toEqual(stored);
    expect(await getStoredRevision()).toBe(1);
  });

  it("returns defaults when no preferences are stored", async () => {
    const response = await serviceFetch("https://test.local/model-preferences");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabledModels: DEFAULT_ENABLED_MODELS, revision: 0 });
  });

  it("filters removed models without changing the stored row", async () => {
    const stored = ["openai/gpt-5.2", "openai/gpt-5.4", "anthropic/claude-sonnet-4-6"];
    await seedPreferences(stored);

    const response = await serviceFetch("https://test.local/model-preferences");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabledModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
      revision: 1,
    });
    expect(await getStoredModels()).toEqual(stored);
  });

  it("normalizes and deduplicates stored legacy model IDs", async () => {
    await seedPreferences(["gpt-5.4", "openai/gpt-5.4", "claude-sonnet-4-6"]);

    const response = await serviceFetch("https://test.local/model-preferences");

    expect(await response.json()).toEqual({
      enabledModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
      revision: 1,
    });
  });

  it("returns defaults when all stored models have been removed", async () => {
    await seedPreferences(["openai/gpt-5.2", "unknown/model"]);

    const response = await serviceFetch("https://test.local/model-preferences");

    expect(await response.json()).toEqual({ enabledModels: DEFAULT_ENABLED_MODELS, revision: 1 });
  });

  it("returns defaults for a malformed stored value", async () => {
    await seedPreferences({ model: "openai/gpt-5.4" });

    const response = await serviceFetch("https://test.local/model-preferences");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabledModels: DEFAULT_ENABLED_MODELS, revision: 1 });
  });

  it("applies atomic model membership changes and increments the revision", async () => {
    await seedPreferences(["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"]);

    const response = await patchPreferences([
      { modelId: "openai/gpt-5.4", enabled: false },
      { modelId: "anthropic/claude-haiku-4-5", enabled: true },
    ]);

    const expected = ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"];
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabledModels: expected, revision: 2 });
    expect(await getStoredModels()).toEqual(expected);
    expect(await getStoredRevision()).toBe(2);
  });

  it("starts an atomic update from defaults when no row exists", async () => {
    const response = await patchPreferences([{ modelId: "opencode/kimi-k2.5", enabled: true }]);

    expect(response.status).toBe(200);
    expect(await getStoredModels()).toEqual([...DEFAULT_ENABLED_MODELS, "opencode/kimi-k2.5"]);
    expect(await getStoredRevision()).toBe(1);
  });

  it("gives an accepted no-op update a new revision", async () => {
    await seedPreferences(["openai/gpt-5.4"]);

    const response = await patchPreferences([{ modelId: "openai/gpt-5.4", enabled: true }]);

    expect(response.status).toBe(200);
    expect(await getStoredModels()).toEqual(["openai/gpt-5.4"]);
    expect(await getStoredRevision()).toBe(2);
  });

  it("rejects malformed PATCH JSON without replacing preferences", async () => {
    const stored = ["openai/gpt-5.4"];
    await seedPreferences(stored);

    const response = await serviceFetch("https://test.local/model-preferences", {
      method: "PATCH",
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await getStoredModels()).toEqual(stored);
    expect(await getStoredRevision()).toBe(1);
  });

  it("repairs malformed storage from defaults while applying an update", async () => {
    await seedPreferences({ model: "openai/gpt-5.4" });

    const response = await patchPreferences([{ modelId: "opencode/kimi-k2.5", enabled: true }]);

    expect(response.status).toBe(200);
    expect(await getStoredModels()).toEqual([...DEFAULT_ENABLED_MODELS, "opencode/kimi-k2.5"]);
  });

  it("rejects invalid, legacy, duplicate, and empty change lists atomically", async () => {
    const stored = ["openai/gpt-5.4"];
    await seedPreferences(stored);

    for (const body of [
      { changes: [] },
      { changes: [{ modelId: "gpt-5.4", enabled: true }] },
      { changes: [{ modelId: "unknown/model", enabled: true }] },
      {
        changes: [
          { modelId: "openai/gpt-5.4", enabled: true },
          { modelId: "openai/gpt-5.4", enabled: false },
        ],
      },
      { changes: [{ modelId: "openai/gpt-5.4", enabled: "yes" }] },
    ]) {
      const response = await serviceFetch("https://test.local/model-preferences", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await getStoredModels()).toEqual(stored);
      expect(await getStoredRevision()).toBe(1);
    }
  });

  it("rejects an update that would disable every model", async () => {
    await seedPreferences(["openai/gpt-5.4"]);

    const response = await patchPreferences([{ modelId: "openai/gpt-5.4", enabled: false }]);

    expect(response.status).toBe(400);
    expect(await getStoredModels()).toEqual(["openai/gpt-5.4"]);
    expect(await getStoredRevision()).toBe(1);
  });

  it("merges concurrent independent changes instead of losing one", async () => {
    await seedPreferences(["openai/gpt-5.4"]);

    const responses = await Promise.all([
      patchPreferences([{ modelId: "anthropic/claude-haiku-4-5", enabled: true }]),
      patchPreferences([{ modelId: "anthropic/claude-sonnet-4-6", enabled: true }]),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(new Set((await getStoredModels()) as string[])).toEqual(
      new Set(["openai/gpt-5.4", "anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"])
    );
    expect(await getStoredRevision()).toBe(3);
  });
});
