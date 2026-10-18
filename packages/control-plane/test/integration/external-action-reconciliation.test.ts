import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { initSession, queryDO } from "./helpers";
import { componentsOf, runInSessionDO } from "./session-do-access";
import { z } from "zod";

it("reconciles an accepted external action from a reconstructed SessionDO alarm", async () => {
  const { sessionName, stub } = await initSession({
    sessionName: `external-action-recovery-${crypto.randomUUID()}`,
    harness: "pi",
    model: "openai/gpt-5.6-sol",
    repoOwner: null,
    repoName: null,
    repoId: null,
  });
  let actionId = "";
  await runInSessionDO(stub, async (instance, state) => {
    const components = componentsOf(instance);
    components.externalActionDefinitions.register(
      fakeDefinition({
        execute: vi.fn(async () => ({
          kind: "accepted",
          providerReference: "provider-operation-1",
        })),
        status: vi.fn(async () => ({ kind: "unknown" })),
      })
    );
    const action = await components.externalActionGateway.prepare("session", "message-1", {
      toolCallId: "call-1",
      idempotencyKey: "pi:message-1:call-1",
      provider: "fake",
      action: "publish_comment",
      summary: "Publish review comment",
      target: { repository: "acme/widgets", issue: 42 },
      arguments: { body: "Looks good" },
    });
    actionId = action.id;
    components.externalActionGateway.approve(action.id, {
      source: "human",
      actorId: "user-1",
      grantId: null,
    });
    expect(
      (
        await components.externalActionGateway.execute(
          action.id,
          components.externalActionDefinitions.executorFor("fake", "publish_comment")!
        )
      ).state
    ).toBe("executing");
    state.storage.sql.exec(
      "UPDATE external_actions SET updated_at = 0, lease_expires_at = NULL WHERE id = ?",
      action.id
    );
  });

  await expect(
    runInSessionDO(stub, (_instance: SessionDO, state) => state.abort("force reconstruction"))
  ).rejects.toThrow();
  const restored = env.SESSION.get(env.SESSION.idFromName(sessionName));
  await runInSessionDO(restored, (instance) => {
    componentsOf(instance).externalActionDefinitions.register(
      fakeDefinition({
        execute: vi.fn(async () => ({ kind: "rejected", error: "must not redispatch" })),
        status: vi.fn(async () => ({
          kind: "succeeded",
          publicResult: { publicationId: "comment-7" },
        })),
      })
    );
  });
  await runInSessionDO(restored, (_instance, state) => {
    const deadline = Date.now() - 1_000;
    state.storage.sql.exec(
      `INSERT INTO session_alarm_state (singleton, pending_deadline, cancelled)
       VALUES (1, ?, 0)
       ON CONFLICT(singleton) DO UPDATE SET pending_deadline = excluded.pending_deadline, cancelled = 0`,
      deadline
    );
    return state.storage.setAlarm(deadline);
  });

  await expect(runInSessionDO(restored, (instance) => instance.alarm())).resolves.toBeUndefined();
  await expect(
    queryDO<{ state: string; public_result_json: string | null }>(
      restored,
      "SELECT state, public_result_json FROM external_actions WHERE id = ?",
      actionId
    )
  ).resolves.toEqual([
    {
      state: "succeeded",
      public_result_json: JSON.stringify({ publicationId: "comment-7" }),
    },
  ]);
  await expect(
    env.DB.prepare(
      `SELECT action, resource_id, operation_result
       FROM authorization_audit_events
       WHERE action = 'external_action.approved' AND resource_id = ?`
    )
      .bind(actionId)
      .first()
  ).resolves.toEqual({
    action: "external_action.approved",
    resource_id: actionId,
    operation_result: "applied",
  });
});

function fakeDefinition(executor: {
  execute: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
}) {
  return {
    provider: "fake",
    action: "publish_comment",
    requestSchema: z.object({
      target: z.object({ repository: z.string(), issue: z.number() }),
      arguments: z.object({ body: z.string() }),
    }),
    publicResultSchema: z.object({ publicationId: z.string() }) as never,
    executor: executor as never,
  };
}
