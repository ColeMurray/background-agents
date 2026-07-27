import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { DEFAULT_ENABLED_MODELS } from "@open-inspect/shared";
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

describe("Model preferences API", () => {
  beforeEach(cleanD1Tables);

  it("returns defaults when no preferences are stored", async () => {
    const response = await serviceFetch("https://test.local/model-preferences");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabledModels: DEFAULT_ENABLED_MODELS });
  });

  it("filters removed models without changing the stored row", async () => {
    const stored = ["openai/gpt-5.2", "openai/gpt-5.4", "anthropic/claude-sonnet-4-6"];
    await seedPreferences(stored);

    const response = await serviceFetch("https://test.local/model-preferences");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabledModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
    });
    expect(await getStoredModels()).toEqual(stored);
  });

  it("normalizes and deduplicates stored legacy model IDs", async () => {
    await seedPreferences(["gpt-5.4", "openai/gpt-5.4", "claude-sonnet-4-6"]);

    const response = await serviceFetch("https://test.local/model-preferences");

    expect(await response.json()).toEqual({
      enabledModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
    });
  });

  it("returns defaults when all stored models have been removed", async () => {
    await seedPreferences(["openai/gpt-5.2", "unknown/model"]);

    const response = await serviceFetch("https://test.local/model-preferences");

    expect(await response.json()).toEqual({ enabledModels: DEFAULT_ENABLED_MODELS });
  });

  it("returns defaults for a malformed stored value", async () => {
    await seedPreferences({ model: "openai/gpt-5.4" });

    const response = await serviceFetch("https://test.local/model-preferences");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabledModels: DEFAULT_ENABLED_MODELS });
  });

  it("normalizes, deduplicates, and replaces preferences on PUT", async () => {
    await seedPreferences(["anthropic/claude-sonnet-4-6"]);
    const response = await serviceFetch("https://test.local/model-preferences", {
      method: "PUT",
      body: JSON.stringify({
        enabledModels: ["gpt-5.4", "openai/gpt-5.4", "claude-sonnet-4-6"],
      }),
    });

    const expected = ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"];
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "updated", enabledModels: expected });
    expect(await getStoredModels()).toEqual(expected);
  });

  it("rejects invalid models atomically", async () => {
    const stored = ["anthropic/claude-sonnet-4-6"];
    await seedPreferences(stored);
    const response = await serviceFetch("https://test.local/model-preferences", {
      method: "PUT",
      body: JSON.stringify({ enabledModels: ["openai/gpt-5.4", "openai/gpt-5.2"] }),
    });

    expect(response.status).toBe(400);
    expect(await getStoredModels()).toEqual(stored);
  });

  it("rejects non-string model IDs", async () => {
    const response = await serviceFetch("https://test.local/model-preferences", {
      method: "PUT",
      body: JSON.stringify({ enabledModels: ["openai/gpt-5.4", null] }),
    });

    expect(response.status).toBe(400);
  });
});
