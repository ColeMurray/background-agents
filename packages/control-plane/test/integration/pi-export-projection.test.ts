import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createFauxCodexProvider } from "./faux-codex-provider";
import type { PiSessionDO } from "../../src/cloudflare/pi-durable-object";
import { initSession, queryDO, seedActiveUser } from "./helpers";
import { PI_MODEL_PROVIDER_ID, piProviderFactories } from "../../src/pi/provider-factories";
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
        fauxAssistantMessage(fauxToolCall("subagent", { task: "inspect independently" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(fauxToolCall("read", { path: "/workspace/missing.txt" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("child answer"),
        fauxAssistantMessage("parent answer"),
        fauxAssistantMessage("summary"),
      ],
    });
    piProviderFactories.register(PI_MODEL_PROVIDER_ID, () => faux.provider);
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
      // A control keeps the conversation's model, so the conversation is
      // given the faux's.
      const root = await (await pi.harness.pi()).root(BACKGROUND_CONTEXT);
      await root.configure(
        { model: { provider: PI_MODEL_PROVIDER_ID, modelId: "gpt-5.6-sol" } },
        BACKGROUND_CONTEXT
      );
    });

    // The session runs the turn.
    const response = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.prompt}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authorId: "user-1",
          canonicalUserId: "user-1",
          source: "web",
          clientRequestId: "projection-1",
          content: "write the notes",
        }),
      })
    );
    expect(response.status).toBe(200);
    const { messageId } = await response.json<{ messageId: string }>();
    await vi.waitFor(
      async () => {
        await expect(
          queryDO(sessionStub, "SELECT status FROM messages WHERE id = ?", messageId)
        ).resolves.toEqual([{ status: "completed" }]);
      },
      { timeout: 10_000 }
    );

    // The session's own events: the tool call and the terminal completion.
    // These are exactly the rows the export reads.
    const events = await queryDO<{ type: string; data: string; timeline_sequence: number }>(
      sessionStub,
      "SELECT type, data, timeline_sequence FROM events WHERE message_id = ? ORDER BY timeline_sequence",
      messageId
    );
    const types = events.map((event) => event.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("execution_complete");
    const rootTasks = events.filter((event) => {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      return data.type === "tool_call" && data.tool === "task" && data.isSubtask !== true;
    });
    expect(rootTasks).toHaveLength(1);
    const rootTask = JSON.parse(rootTasks[0]!.data) as Record<string, unknown>;
    expect(rootTask).toMatchObject({
      callId: expect.any(String),
      childSessionId: expect.any(String),
    });
    expect(
      events.some((event) => {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        return data.type === "tool_call" && data.tool === "subagent" && data.isSubtask !== true;
      })
    ).toBe(false);
    const childRead = events.find((event) => {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      return data.type === "tool_call" && data.tool === "read" && data.isSubtask === true;
    });
    expect(childRead).toBeDefined();
    expect(JSON.parse(childRead!.data)).toMatchObject({
      isSubtask: true,
      taskCallId: rootTask.callId,
      childSessionId: rootTask.childSessionId,
    });
    const childUsage = await queryDO<{
      id: string;
      is_subtask: number;
      child_session_id: string;
      task_call_id: string;
    }>(
      sessionStub,
      "SELECT id, is_subtask, child_session_id, task_call_id FROM step_usage WHERE message_id = ? AND is_subtask = 1",
      messageId
    );
    expect(childUsage.length).toBeGreaterThan(0);
    expect(new Set(childUsage.map((usage) => usage.id)).size).toBe(childUsage.length);
    expect(childUsage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          child_session_id: rootTask.childSessionId,
          task_call_id: rootTask.callId,
        }),
      ])
    );
    const terminal = events.find((event) => event.type === "execution_complete");
    expect(childRead!.timeline_sequence).toBeLessThan(terminal!.timeline_sequence);
    await expect(
      runInDurableObject(piStub as unknown as DurableObjectStub, (instance) =>
        (instance as unknown as PiSessionDO).control({
          sessionId: session.sessionName,
          requestId: "late-child-message",
          action: "send",
          conversationId: Number(childUsage[0]!.child_session_id),
          content: "this must not reopen a finished child",
        })
      )
    ).rejects.toThrow("Task-owned Pi conversation is no longer active");

    const compactResponse = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.piControl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId: "user-1",
          canonicalUserId: "user-1",
          source: "web",
          control: {
            sessionId: session.sessionName,
            requestId: "compact-projection-1",
            action: "compact",
            instructions: "retain decisions",
          },
        }),
      })
    );
    expect(compactResponse.status).toBe(202);
    await vi.waitFor(
      async () => {
        await expect(
          queryDO(
            sessionStub,
            "SELECT status FROM messages WHERE id = ?",
            "pi-control:compact-projection-1"
          )
        ).resolves.toEqual([{ status: "completed" }]);
      },
      { timeout: 10_000 }
    );
    const compactEvents = await queryDO<{ type: string }>(
      sessionStub,
      "SELECT type FROM events WHERE message_id = ? ORDER BY timeline_sequence",
      "pi-control:compact-projection-1"
    );
    const compactTypes = compactEvents.map((event) => event.type);
    expect(compactTypes.filter((type) => type === "context_compacted")).toHaveLength(1);
    expect(compactTypes.indexOf("context_compacted")).toBeLessThan(
      compactTypes.indexOf("execution_complete")
    );
    const compactUsage = await queryDO<{ created_at: number; message_cost_usd: number }>(
      sessionStub,
      "SELECT created_at, message_cost_usd FROM step_usage WHERE message_id = ?",
      "pi-control:compact-projection-1"
    );
    expect(compactUsage).toHaveLength(1);
    const compactTerminal = await queryDO<{ created_at: number }>(
      sessionStub,
      "SELECT created_at FROM events WHERE message_id = ? AND type = 'execution_complete'",
      "pi-control:compact-projection-1"
    );
    expect(compactUsage[0]!.created_at).toBeLessThanOrEqual(compactTerminal[0]!.created_at);
  });
});
