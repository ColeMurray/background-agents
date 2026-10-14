import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import {
  resolveHarnessSelection,
  validateHarnessAutomationAuth,
} from "../../src/harness-admission";
import { cleanD1Tables } from "./cleanup";
import { resolveSessionProviderAuth } from "../../src/session/provider-account-resolution";
import { initNamedSession, queryDO } from "./helpers";

describe("harness policy with real D1 and Durable Object storage", () => {
  beforeEach(cleanD1Tables);

  async function setEnabledModels(models: string[]) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO model_preferences (id, enabled_models, updated_at) VALUES ('global', ?, ?)"
    )
      .bind(JSON.stringify(models), Date.now())
      .run();
  }

  it("resolves native enabled defaults without changing legacy defaults", async () => {
    await setEnabledModels([DEFAULT_MODEL, "openai/gpt-5.6-sol"]);
    await expect(resolveHarnessSelection(env.DB, {}, { harness: "codex" })).resolves.toEqual({
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "low",
    });
    await expect(resolveHarnessSelection(env.DB, {}, { harness: "opencode" })).resolves.toEqual({
      model: DEFAULT_MODEL,
      reasoningEffort: null,
    });
  });

  it("accepts native API-key routing when no connected-account default exists", async () => {
    await expect(
      validateHarnessAutomationAuth(env.DB, "codex", "openai/gpt-5.6-sol", {})
    ).resolves.toBeUndefined();
    await expect(
      validateHarnessAutomationAuth(env.DB, "codex", "openai/gpt-5.6-sol", {
        openai: { mode: "api_key" },
        anthropic: { mode: "provider_account", accountId: "unreachable-stale-account" },
      })
    ).resolves.toBeUndefined();
    await expect(
      validateHarnessAutomationAuth(env.DB, "opencode", DEFAULT_MODEL, {})
    ).resolves.toBeUndefined();
  });

  it("stores the admitted native model and effort unchanged at the internal boundary", async () => {
    const providerAuth = await resolveSessionProviderAuth(env.DB, {
      harness: "codex",
      unattended: false,
      explicit: { openai: { mode: "api_key" } },
    });
    const { stub } = await initNamedSession(`harness-policy-${crypto.randomUUID()}`, {
      harness: "codex",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "max",
      providerAuth,
    });
    expect(await queryDO(stub, "SELECT harness, model, reasoning_effort FROM session")).toEqual([
      { harness: "codex", model: "openai/gpt-5.6-sol", reasoning_effort: "max" },
    ]);
  });

  it("rejects a prompt without inserting a message after its native model is disabled", async () => {
    await setEnabledModels([DEFAULT_MODEL, "openai/gpt-5.6-sol"]);
    const providerAuth = await resolveSessionProviderAuth(env.DB, {
      harness: "codex",
      unattended: false,
      explicit: { openai: { mode: "api_key" } },
    });
    const { stub } = await initNamedSession(`harness-disable-${crypto.randomUUID()}`, {
      harness: "codex",
      model: "openai/gpt-5.6-sol",
      providerAuth,
    });
    await setEnabledModels([DEFAULT_MODEL]);
    const response = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Must not run", authorId: "user-1", source: "web" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("not enabled") });
    expect(await queryDO(stub, "SELECT id FROM messages")).toEqual([]);
  });
});
