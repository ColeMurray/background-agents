import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createFauxCodexProvider } from "./faux-codex-provider";
import type { PiSessionDO } from "../../src/cloudflare/pi-durable-object";
import { initSession, queryDO, serviceFetch, seedActiveUser } from "./helpers";
import { PI_MODEL_PROVIDER_ID, piProviderFactories } from "../../src/pi/provider-factories";
import { cleanD1Tables } from "./cleanup";
import { SessionInternalPaths } from "../../src/session/contracts";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";

/**
 * One Pi session, end to end, locally.
 *
 * Create, prompt, a tool call, the completion event, the archive, and the
 * export — in that order, against a real Durable Object in Miniflare. This is
 * the run the canary documents describe, made repeatable.
 *
 * The model is stood in for: the faux provider answers at the session's own
 * model name, so the session's model resolution, the harness's provider
 * lookup and the pricing are all the real ones.
 */
describe("a Pi session, end to end", () => {
  beforeEach(cleanD1Tables);

  it("creates, runs a turn with a tool call, completes, archives, and exports", async () => {
    // 1. Create. The session needs a provider account, because a Durable
    // Object harness may only run on a connected person's subscription.
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO model_preferences (id, enabled_models, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET enabled_models = excluded.enabled_models"
    )
      .bind("global", JSON.stringify(["openai/gpt-5.6-sol"]), now)
      .run();
    await env.DB.prepare(
      `INSERT INTO model_provider_accounts
         (id, provider, display_name, external_account_id, status, created_at, updated_at)
       VALUES (?, 'openai', 'OpenAI', 'acct', 'active', ?, ?)`
    )
      .bind("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", now, now)
      .run();
    await new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!).create({
      providerAccountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      provider: "openai",
      credentialSchemaVersion: 1,
      payload: {
        refreshToken: "openai-refresh-secret",
        accessToken: "openai-access-secret",
        accessTokenExpiresAt: now + 365 * 24 * 60 * 60 * 1000,
      },
      accessTokenExpiresAt: now + 365 * 24 * 60 * 60 * 1000,
      now,
    });
    // The turn's author must be a user the workspace knows: the turn
    // authority reads D1 again at every action.
    await seedActiveUser("user-1");

    // The faux serves the model through the seam, and it is registered before
    // the session exists: the session's own initialization opens the Pi Durable
    // Object, and the harness installs its provider at that moment.
    const faux = createFauxCodexProvider({
      models: [
        {
          id: "gpt-5.6-sol",
          name: "Faux gpt-5.6-sol",
          cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
        },
      ],
      responses: [
        fauxAssistantMessage(fauxToolCall("read", { path: "/workspace/missing.txt" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("there are no other agents"),
      ],
    });
    piProviderFactories.register(PI_MODEL_PROVIDER_ID, () => faux.provider);
    const session = await initSession({
      title: "pi-e2e",
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
      providerAuth: [
        {
          provider: "openai",
          authMode: "provider_account",
          providerAccountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          selectionSource: "explicit",
        },
        { provider: "xai", authMode: "api_key", selectionSource: "explicit" },
        { provider: "anthropic", authMode: "api_key", selectionSource: "explicit" },
      ],
    });
    const sessionStub = env.SESSION.getByName(session.sessionName);
    const piStub = env.PI_SESSION ? env.PI_SESSION.getByName(session.sessionName) : undefined;
    if (!piStub) throw new Error("PI_SESSION test binding is missing");

    // Open the harness before the prompt, as the session's own initialization
    // does, so the provider installed at open is the faux's.
    await runInDurableObject(piStub as unknown as DurableObjectStub, async (instance) => {
      const pi = instance as unknown as PiSessionDO;
      await (await pi.harness.pi()).root(BACKGROUND_CONTEXT);
    });

    // 2. Prompt.
    const prompted = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.prompt}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "write the notes",
          authorId: "user-1",
          source: "web",
        }),
      })
    );
    expect(prompted.status).toBe(200);
    const { messageId } = (await prompted.json()) as { messageId: string };

    // 3 and 4. The turn's completion, in the session's own timeline — the
    // rows the export reads. The tool call the model made is proven by the
    // projection test, which drives the same relay.
    await vi.waitFor(
      async () => {
        const events = await queryDO<{ type: string }>(
          sessionStub,
          "SELECT type FROM events WHERE message_id = ? ORDER BY timeline_sequence",
          messageId
        );
        const types = events.map((event) => event.type);
        expect(types).toContain("execution_complete");
      },
      { timeout: 20_000, interval: 250 }
    );

    // 5. Archive.
    const archived = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.archive}`, { method: "POST" })
    );
    expect(archived.status).toBeLessThan(300);
    await expect(
      env.DB.prepare("SELECT status FROM sessions WHERE id = ?")
        .bind(session.sessionName)
        .first<{ status: string }>()
    ).resolves.toEqual({ status: "durable_archived" });

    // 6. Export. SessionDO's projection is the canonical exported transcript.
    const exported = await serviceFetch("https://cp.test/sessions/export?include=events");
    expect(exported.status).toBe(200);
    const body = await exported.text();
    const lines = body
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const sessionLine = lines.find((line) => line.id === session.sessionName);
    expect(sessionLine).toMatchObject({
      type: "session",
      harness: "pi",
    });
    expect(sessionLine).not.toHaveProperty("harnessState");
    // The export carries the session's events inside the session's line.
    const exportedEvents = (sessionLine?.events ?? []) as { type: string }[];
    expect(exportedEvents.map((event) => event.type)).toContain("execution_complete");
    // And the tool call the model made: the step is visible in the export.
    expect(exportedEvents.map((event) => event.type)).toContain("tool_call");
  }, 30_000);
});
