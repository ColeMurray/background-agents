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
      `UPDATE external_actions
       SET updated_at = 0, lease_expires_at = NULL, reconcile_after = 0 WHERE id = ?`,
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
  let restoredAlarm: number | null = null;
  for (let attempt = 0; attempt < 20 && restoredAlarm === null; attempt++) {
    restoredAlarm = await runInSessionDO(restored, (_instance, state) => state.storage.getAlarm());
    if (restoredAlarm === null) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(restoredAlarm).not.toBeNull();

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

it("backs off and rearms when a provider definition is removed before reconstruction", async () => {
  const { sessionName, stub } = await initSession({
    sessionName: `external-action-missing-provider-${crypto.randomUUID()}`,
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
          providerReference: "provider-operation-missing",
        })),
        status: vi.fn(async () => ({ kind: "unknown" })),
      })
    );
    const action = await components.externalActionGateway.prepare(
      "session",
      "message-missing",
      {
        toolCallId: "call-missing",
        idempotencyKey: "pi:message-missing:call-missing",
        provider: "fake",
        action: "publish_comment",
        summary: "Publish review comment",
        target: { repository: "acme/widgets", issue: 42 },
        arguments: { body: "Looks good" },
      },
      {
        source: "automation_grant",
        actorId: "executor-1",
        grantId: "grant-1",
      }
    );
    actionId = action.id;
    await components.externalActionGateway.execute(
      action.id,
      components.externalActionDefinitions.executorFor("fake", "publish_comment")!
    );
    state.storage.sql.exec(
      "UPDATE external_actions SET reconcile_after = 0 WHERE id = ?",
      action.id
    );
  });

  await expect(
    runInSessionDO(stub, (_instance: SessionDO, state) => state.abort("force reconstruction"))
  ).rejects.toThrow();
  const restored = env.SESSION.get(env.SESSION.idFromName(sessionName));
  // Initializing the replacement with an empty definition registry must still
  // derive and schedule the authoritative ledger deadline.
  await runInSessionDO(restored, (instance) => componentsOf(instance));
  const restoredAlarm = await waitForAlarm(restored);
  expect(restoredAlarm).not.toBeNull();

  await runInSessionDO(restored, (instance) => instance.alarm());
  const rows = await queryDO<{
    state: string;
    reconciliation_attempts: number;
    reconcile_after: number | null;
  }>(
    restored,
    `SELECT state, reconciliation_attempts, reconcile_after
     FROM external_actions WHERE id = ?`,
    actionId
  );
  expect(rows[0]).toMatchObject({ state: "indeterminate", reconciliation_attempts: 1 });
  expect(rows[0]!.reconcile_after).toBeGreaterThan(Date.now());
  await expect(
    queryDO<{ pending_deadline: number | null }>(
      restored,
      "SELECT pending_deadline FROM session_alarm_state WHERE singleton = 1"
    )
  ).resolves.toEqual([{ pending_deadline: rows[0]!.reconcile_after }]);
});

it("rehydrates an indeterminate action deadline without persisted alarm state", async () => {
  const { sessionName, stub } = await initSession({
    sessionName: `external-action-indeterminate-${crypto.randomUUID()}`,
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
        execute: vi.fn(async () => {
          throw new Error("connection reset after provider admission");
        }),
        status: vi.fn(async () => ({ kind: "unknown" })),
      })
    );
    const action = await components.externalActionGateway.prepare(
      "session",
      "message-indeterminate",
      {
        toolCallId: "call-indeterminate",
        idempotencyKey: "pi:message-indeterminate:call-indeterminate",
        provider: "fake",
        action: "publish_comment",
        summary: "Publish review comment",
        target: { repository: "acme/widgets", issue: 42 },
        arguments: { body: "Looks good" },
      },
      {
        source: "automation_grant",
        actorId: "executor-1",
        grantId: "grant-1",
      }
    );
    actionId = action.id;
    expect(
      (
        await components.externalActionGateway.execute(
          action.id,
          components.externalActionDefinitions.executorFor("fake", "publish_comment")!
        )
      ).state
    ).toBe("indeterminate");
    state.storage.sql.exec(
      "UPDATE external_actions SET reconcile_after = 0 WHERE id = ?",
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
          publicResult: { publicationId: "comment-indeterminate" },
        })),
      })
    );
  });
  expect(await waitForAlarm(restored)).not.toBeNull();
  await runInSessionDO(restored, (instance) => instance.alarm());
  await expect(
    queryDO<{ state: string }>(
      restored,
      "SELECT state FROM external_actions WHERE id = ?",
      actionId
    )
  ).resolves.toEqual([{ state: "succeeded" }]);
});

it("rehydrates a committed audit outbox without persisted alarm state", async () => {
  const { sessionName, stub } = await initSession({
    sessionName: `external-action-outbox-${crypto.randomUUID()}`,
    harness: "pi",
    model: "openai/gpt-5.6-sol",
    repoOwner: null,
    repoName: null,
    repoId: null,
  });
  let actionId = "";
  await runInSessionDO(stub, async (instance) => {
    const gateway = componentsOf(instance).externalActionGateway;
    const action = await gateway.prepare("session", "message-outbox", {
      toolCallId: "call-outbox",
      idempotencyKey: "pi:message-outbox:call-outbox",
      provider: "fake",
      action: "publish_comment",
      summary: "Publish review comment",
      target: { repository: "acme/widgets", issue: 42 },
      arguments: { body: "Looks good" },
    });
    actionId = action.id;
    gateway.approve(action.id, {
      source: "human",
      actorId: "user-1",
      grantId: null,
      requestId: "request-outbox",
    });
  });

  await expect(
    runInSessionDO(stub, (_instance: SessionDO, state) => state.abort("force reconstruction"))
  ).rejects.toThrow();
  const restored = env.SESSION.get(env.SESSION.idFromName(sessionName));
  await runInSessionDO(restored, (instance) => componentsOf(instance));
  expect(await waitForAlarm(restored)).not.toBeNull();
  await runInSessionDO(restored, (instance) => instance.alarm());
  await expect(
    env.DB.prepare(
      `SELECT request_id FROM authorization_audit_events
       WHERE action = 'external_action.approved' AND resource_id = ?`
    )
      .bind(actionId)
      .first()
  ).resolves.toEqual({ request_id: "request-outbox" });
  await expect(queryDO(restored, "SELECT * FROM external_action_audit_outbox")).resolves.toEqual(
    []
  );
});

async function waitForAlarm(stub: DurableObjectStub): Promise<number | null> {
  let alarm: number | null = null;
  for (let attempt = 0; attempt < 20 && alarm === null; attempt++) {
    alarm = await runInSessionDO(stub, (_instance, state) => state.storage.getAlarm());
    if (alarm === null) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return alarm;
}

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
