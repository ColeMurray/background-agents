import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortAllDurableObjects,
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { verifyCallbackSignature } from "@open-inspect/shared/auth";
import type { SessionCallbackJob } from "@open-inspect/shared/types/session-callback-jobs";
import worker from "../../src/index";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import type { FetchClient } from "../../src/platform-ports";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO, seedMessage } from "./helpers";
import { runInSessionDO } from "./session-do-access";
import { jobQueueName } from "../../src/cloudflare/job-queue";

describe("session callback Queue integration", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it("delivers an accepted completion after the producing actor is evicted", async () => {
    const queueSend = vi.spyOn(env.SESSION_CALLBACK_QUEUE!, "send");
    const { stub } = await initSession();
    expect(
      await runInSessionDO(stub, (instance) => {
        const bindings = (instance as unknown as { env: Record<string, unknown> }).env;
        return [
          "SLACK_BOT",
          "LINEAR_BOT",
          "SERVICE_AUTH_SECRET_SLACK_BOT",
          "SERVICE_AUTH_SECRET_LINEAR_BOT",
        ].some((key) => key in bindings);
      })
    ).toBe(false);
    const [{ id: participantId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(stub, {
      id: "message-1",
      authorId: participantId,
      content: "Test prompt",
      source: "slack",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });
    await queryDO(
      stub,
      "UPDATE messages SET callback_context = ? WHERE id = ?",
      JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "123.45",
        repoFullName: "acme/web-app",
        model: "anthropic/claude-haiku-4-5",
      }),
      "message-1"
    );

    const completion = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId: "message-1",
        success: true,
        sandboxId: "sandbox-1",
        timestamp: Date.now() / 1000,
      }),
    });
    expect(completion.status).toBe(200);
    await vi.waitFor(() => expect(queueSend).toHaveBeenCalledOnce());
    await queueSend.mock.results[0].value;
    const persistedJob = queueSend.mock.calls[0][0] as SessionCallbackJob;

    await abortAllDurableObjects();

    const batch = createMessageBatch(jobQueueName("session.callback", env.DEPLOYMENT_NAME), [
      {
        id: "callback-message-1",
        timestamp: new Date(),
        attempts: 1,
        body: persistedJob,
      },
    ]);
    const fetch = vi.fn<FetchClient["fetch"]>().mockResolvedValue(new Response("ok"));
    const consumerEnv = {
      ...env,
      SLACK_BOT: { fetch },
      SERVICE_AUTH_SECRET_SLACK_BOT: "test-service-secret-slack-bot",
    } as unknown as WorkerBindings;

    const ctx = createExecutionContext();
    await worker.queue(batch, consumerEnv);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["callback-message-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      sessionId: expect.any(String),
      messageId: "message-1",
      success: true,
      timestamp: persistedJob.payload.timestamp,
    });
    expect(await verifyCallbackSignature(body, "test-service-secret-slack-bot")).toBe(true);
  });
});
