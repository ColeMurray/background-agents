import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import {
  resolveHarnessSelection,
  validateHarnessAutomationAuth,
} from "../../src/harness-admission";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { GlobalSecretsStore } from "../../src/db/global-secrets";
import { cleanD1Tables } from "./cleanup";
import { resolveSessionProviderAuth } from "../../src/session/provider-account-resolution";
import { DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS } from "@open-inspect/shared/types/automations";
import {
  closeWebSocket,
  collectMessages,
  initNamedSession,
  openSandboxWs,
  queryDO,
  seedSandboxAuth,
  serviceFetch,
} from "./helpers";

const BROWSER_USER_ID = "11111111111111111111111111111111";
const SANDBOX_ID = "harness-selection-sandbox";
const SANDBOX_TOKEN = "harness-selection-sandbox-token";

function codexAutomation(id: string): AutomationRow {
  return {
    id,
    owner_team_id: null,
    name: id,
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_once_at: null,
    schedule_tz: "UTC",
    harness: "codex",
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    model: "openai/gpt-5.6-sol",
    reasoning_effort: "max",
    enabled: 1,
    max_concurrent_runs: DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: BROWSER_USER_ID,
    user_id: BROWSER_USER_ID,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
}

async function updateAutomation(id: string, body: Record<string, unknown>): Promise<Response> {
  const seeded = await serviceFetch("https://cp.test/me/authorization", {
    initialUserRole: "member",
  });
  expect(seeded.status).toBe(200);
  return serviceFetch(`https://cp.test/automations/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    initialUserRole: "member",
  });
}

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
    await expect(resolveHarnessSelection(env.DB, { harness: "codex" })).resolves.toEqual({
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "low",
    });
    await expect(resolveHarnessSelection(env.DB, { harness: "opencode" })).resolves.toEqual({
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

  describe("automation updates", () => {
    const store = () => new AutomationStore(env.DB);

    it("gives a model-only change the new model's default instead of an unsupported inherited effort", async () => {
      await setEnabledModels([DEFAULT_MODEL, "openai/gpt-5.6-sol", "openai/gpt-5.5"]);
      await store().create(codexAutomation("codex-model-only"));
      const response = await updateAutomation("codex-model-only", { model: "openai/gpt-5.5" });
      expect(response.status).toBe(200);
      expect(await store().getById("codex-model-only")).toMatchObject({
        model: "openai/gpt-5.5",
        reasoning_effort: "medium",
      });
    });

    it("persists a valid effort when only the harness changes", async () => {
      await setEnabledModels([DEFAULT_MODEL, "openai/gpt-5.6-sol"]);
      await store().create(codexAutomation("codex-to-opencode"));
      const response = await updateAutomation("codex-to-opencode", { harness: "opencode" });
      expect(response.status).toBe(200);
      expect(await store().getById("codex-to-opencode")).toMatchObject({
        harness: "opencode",
        reasoning_effort: null,
      });
    });

    it("does not revalidate execution for a rename that resubmits unchanged settings", async () => {
      await setEnabledModels([DEFAULT_MODEL, "openai/gpt-5.6-sol"]);
      await store().create(codexAutomation("codex-rename"));
      await setEnabledModels([DEFAULT_MODEL]);
      const response = await updateAutomation("codex-rename", {
        name: "Renamed",
        harness: "codex",
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "max",
      });
      expect(response.status).toBe(200);
      expect((await store().getById("codex-rename"))?.name).toBe("Renamed");
    });
  });

  describe("prompts", () => {
    async function codexSession(name: string) {
      await new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY as string).setSecrets({
        OPENAI_API_KEY: "openai-key",
      });
      const providerAuth = await resolveSessionProviderAuth(env.DB, {
        harness: "codex",
        unattended: false,
        explicit: { openai: { mode: "api_key" } },
      });
      return initNamedSession(`${name}-${crypto.randomUUID()}`, {
        harness: "codex",
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "max",
        providerAuth,
      });
    }

    function prompt(stub: DurableObjectStub, body: Record<string, unknown>) {
      return stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authorId: "user-1", source: "web", ...body }),
      });
    }

    it("dispatches a model override with the override model's default effort", async () => {
      await setEnabledModels([DEFAULT_MODEL, "openai/gpt-5.6-sol", "openai/gpt-5.5"]);
      const { stub, sessionName } = await codexSession("prompt-override");
      await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
      const { ws } = await openSandboxWs(sessionName, {
        authToken: SANDBOX_TOKEN,
        sandboxId: SANDBOX_ID,
      });
      expect(ws).not.toBeNull();
      ws!.accept();

      try {
        const dispatched = collectMessages(ws!, {
          until: (message) => message.type === "prompt",
        });
        const response = await prompt(stub, { content: "Use 5.5", model: "openai/gpt-5.5" });
        expect(response.status).toBe(200);
        expect(await dispatched).toContainEqual(
          expect.objectContaining({
            type: "prompt",
            model: "openai/gpt-5.5",
            reasoningEffort: "medium",
          })
        );
        expect(await queryDO(stub, "SELECT model, reasoning_effort, status FROM messages")).toEqual(
          [{ model: "openai/gpt-5.5", reasoning_effort: null, status: "processing" }]
        );
      } finally {
        await closeWebSocket(ws!, { bestEffort: true });
      }
    });

    it("returns the original message for an identical retry after the model is disabled", async () => {
      await setEnabledModels([DEFAULT_MODEL, "openai/gpt-5.6-sol"]);
      const { stub } = await codexSession("prompt-retry");
      const first = await prompt(stub, { content: "Once", clientRequestId: "req-1" });
      expect(first.status).toBe(200);
      const { messageId } = (await first.json()) as { messageId: string };
      await setEnabledModels([DEFAULT_MODEL]);
      const retry = await prompt(stub, { content: "Once", clientRequestId: "req-1" });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ messageId });
      expect(await queryDO(stub, "SELECT id FROM messages")).toEqual([{ id: messageId }]);
    });
  });
});
