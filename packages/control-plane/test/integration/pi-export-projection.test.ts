import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { PiSessionDO } from "../../src/cloudflare/pi-durable-object";
import { initSession, queryDO, seedActiveUser } from "./helpers";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import { cleanD1Tables } from "./cleanup";
import { SessionInternalPaths } from "../../src/session/contracts";

/**
 * The export must be able to see the session.
 *
 * A Pi session keeps its own durable record in its own Durable Object, and the
 * export says plainly that the record itself is not in the export. What the
 * export *does* carry is the session's projection of it: the messages and the
 * events the session recorded while the turn ran.
 *
 * So the question this test answers is the one that matters: **does every
 * user-visible step of a Pi turn reach the session's own events?** If a step
 * stayed inside the Pi Durable Object, the export would look complete and
 * omit it — the failure the reference model calls a transcript export cannot
 * see.
 */
describe("the Pi projection the export reads", () => {
  beforeEach(cleanD1Tables);

  it("puts a Pi turn's tool call and its completion in the session's events", async () => {
    // A Durable Object harness may only run on a connected person's
    // subscription, so the session needs a provider account before it can
    // run a turn.
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

    const session = await initSession({
      title: "pi-projection",
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

    // The Pi runtime answers with one tool call and one answer.
    //
    // The faux provider answers at the session's own model name, so the
    // session's model resolution, the harness's provider, and the turn all
    // agree on which model is running.
    await runInDurableObject(piStub as unknown as DurableObjectStub, async (instance) => {
      const pi = instance as unknown as PiSessionDO;
      // Opening the harness installs the codex provider; the faux provider
      // must be the one that answers, so it is installed afterwards.
      await (await pi.harness.pi()).root(BACKGROUND_CONTEXT);
      const faux = fauxProvider({
        provider: "openai",
        models: [
          {
            id: "gpt-5.6-sol",
            name: "Faux gpt-5.6-sol",
            cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
          },
        ],
      });
      (pi as unknown as { models: MutableModels }).models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write", { path: "notes.txt", content: "hello" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("the notes are written"),
      ]);
    });

    // The session runs the turn.
    const response = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.piControl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId: "user-1",
          source: "web",
          control: {
            sessionId: session.sessionName,
            requestId: "projection-1",
            action: "send",
            content: "write the notes",
          },
        }),
      })
    );
    expect(response.status).toBe(202);
    await vi.waitFor(async () => {
      await expect(
        queryDO(
          sessionStub,
          "SELECT state, error_code FROM pi_control_receipts WHERE request_id = ?",
          "projection-1"
        )
      ).resolves.toEqual([{ state: "completed", error_code: null }]);
    });

    // The session's own events: the tool call and the terminal completion.
    // These are exactly the rows the export reads.
    const events = await queryDO<{ type: string }>(
      sessionStub,
      "SELECT type FROM events WHERE message_id = ? ORDER BY timeline_sequence",
      "pi-control:projection-1"
    );
    const types = events.map((event) => event.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("execution_complete");
  });
});
