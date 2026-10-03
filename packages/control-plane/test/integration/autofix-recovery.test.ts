import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  githubAutofixSessionResponseSchema,
  type GitHubAutofixSessionCommand,
} from "@open-inspect/shared";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { createDurableObjectSessionPlatform } from "../../src/cloudflare/session-platform";
import { GlobalSecretsStore } from "../../src/db/global-secrets";
import { SessionStatusProjectionStore } from "../../src/db/session-status-projection-store";
import type { SessionWebSocket } from "../../src/platform-ports";
import { ModalSandboxProvider } from "../../src/sandbox/providers/modal-provider";
import { SANDBOX_RUNTIME_VERSION } from "../../src/sandbox/runtime-manifest";
import { createSessionRuntime } from "../../src/session/components";
import { SessionInternalPaths } from "../../src/session/contracts";
import { SandboxPromptBlockedError } from "../../src/session/message-queue";
import { MessageRepository } from "../../src/session/message-repository";
import {
  SandboxShutdownRepository,
  type ShutdownRecord,
} from "../../src/session/sandbox-shutdown-repository";
import type { SandboxCommand } from "../../src/session/types";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth } from "./helpers";
import { runInSessionDO, type SessionDOInternals } from "./session-do-access";

beforeEach(async () => {
  await cleanD1Tables();
  await new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!).setSecrets({
    ANTHROPIC_API_KEY: "test-anthropic-key",
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanD1Tables();
});

function feedback(
  reviewId: number,
  attemptLimit = 10
): Extract<GitHubAutofixSessionCommand, { type: "enqueue_feedback" }> {
  return {
    type: "enqueue_feedback",
    feedbackKey: `github:review:${reviewId}`,
    pullRequest: { repositoryId: "12345", number: 1, artifactId: "pull-request" },
    prompt: `Address review ${reviewId}`,
    author: { id: "7", login: "reviewer" },
    origin: {
      kind: "review",
      authorType: "human",
      feedbackUrl: `https://github.com/acme/web-app/pull/1#pullrequestreview-${reviewId}`,
    },
    attemptLimit,
  };
}

async function recoverySession() {
  const { stub } = await initNamedSession(`autofix-recovery-${crypto.randomUUID()}`, {
    model: "anthropic/claude-haiku-4-5",
  });
  await seedSandboxAuth(stub, {
    authToken: "autofix-recovery-token",
    sandboxId: "interrupted-restore",
    status: "connecting",
  });
  return stub;
}

/** Rebuild the assembled runtime over real DO SQLite; only provider I/O and socket hosting are fake. */
function recoveryHarness(
  instance: SessionDO,
  state: DurableObjectState,
  overrides: Partial<ShutdownRecord> = {},
  pendingUserPrompt = false
) {
  const create = vi
    .spyOn(ModalSandboxProvider.prototype, "createSandbox")
    .mockImplementation(async (config) => ({
      sandboxId: config.sandboxId,
      providerObjectId: "fresh-source",
      createdAt: Date.now(),
      lifetime: { kind: "none", observedAtMs: Date.now() },
    }));
  const restore = vi
    .spyOn(ModalSandboxProvider.prototype, "restoreFromSnapshot")
    .mockImplementation(async (config) => ({
      success: true,
      sandboxId: config.sandboxId,
      providerObjectId: "restored-source",
      lifetime: { kind: "none", observedAtMs: Date.now() },
    }));
  const capture = vi
    .spyOn(ModalSandboxProvider.prototype, "takeSnapshot")
    .mockResolvedValue({ success: true, imageId: "retry-snapshot" });
  const stop = vi
    .spyOn(ModalSandboxProvider.prototype, "stopSandbox")
    .mockResolvedValue({ success: true });
  const background: Promise<unknown>[] = [];
  const sockets = new Map<SessionWebSocket, string[]>();
  const commands: SandboxCommand[] = [];
  const platform = createDurableObjectSessionPlatform(state, env.DB);
  platform.sockets = {
    adopt: (socket, tags) => {
      sockets.set(socket, tags);
    },
    tags: (socket) => sockets.get(socket) ?? [],
    sockets: (tag) =>
      [...sockets].filter(([, tags]) => !tag || tags.includes(tag)).map(([socket]) => socket),
    setAutoResponse: () => undefined,
  };
  platform.createBackgroundTasks = () => ({
    submit: (task) => {
      background.push(task());
    },
  });
  const build = () =>
    createSessionRuntime(platform, {
      ...(instance as unknown as SessionDOInternals).appEnv,
      SANDBOX_PROVIDER: "modal",
    });
  const initial = build();
  const sandbox = initial.internals.sandboxRepository.getSandbox()!;
  const sql = state.storage.sql;
  sql.exec(
    "UPDATE sandbox SET modal_object_id = ?, runtime_version = ?, spawn_failure_count = 0, fenced = 0, startup_rejected = 0",
    "held-source",
    SANDBOX_RUNTIME_VERSION
  );
  sql.exec("UPDATE session SET status = 'active'");
  if (pendingUserPrompt) {
    sql.exec(
      "INSERT INTO messages (id, author_id, content, source, status, created_at) SELECT ?, id, ?, 'web', 'pending', ? FROM participants LIMIT 1",
      "queued-user",
      "Continue the user's work",
      Date.now() - 1_000
    );
  }
  const shutdown = new SandboxShutdownRepository(sql);
  shutdown.write({
    phase: "running",
    generation: { sandboxId: sandbox.modal_sandbox_id!, createdAt: sandbox.created_at },
    provider: "modal",
    providerObjectId: "held-source",
    sourceRetired: false,
    lifetimeKind: "none",
    expiresAtMs: null,
    drainAtMs: null,
    generationReady: false,
    lifecyclePolicy: "confirmed",
    restoreInvoked: true,
    receipt: {
      kind: "snapshot",
      artifactId: "saved-snapshot",
      provider: "modal",
      runtimeVersion: SANDBOX_RUNTIME_VERSION,
      savedAtMs: Date.now(),
    },
    ...overrides,
  });
  const runtime = build();
  const { messageQueue, lifecycleManager, sandboxRepository, wsManager, sandboxEventProcessor } =
    runtime.internals;
  const prompts = () => commands.filter((command) => command.type === "prompt");
  const rows = () =>
    sql.exec("SELECT id, status FROM messages ORDER BY created_at, rowid").toArray();
  const settle = async () => {
    while (background.length) await Promise.all(background.splice(0));
  };
  const autofix = async (command: GitHubAutofixSessionCommand, target = runtime) => {
    const response = await target.server.onRequest(
      new Request(`http://internal${SessionInternalPaths.autofix}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      })
    );
    expect(response.status).toBe(200);
    return githubAutofixSessionResponseSchema.parse(await response.json());
  };
  const enqueue = async (command: ReturnType<typeof feedback>) => {
    const result = await autofix(command);
    expect(result).toEqual({ kind: "enqueued", messageId: expect.any(String) });
    if (result.kind !== "enqueued") throw new Error("Expected admitted feedback");
    await settle();
    return result.messageId;
  };
  const ready = async () => {
    const socket = {
      readyState: 1,
      send: (data: string | ArrayBuffer | ArrayBufferView) => {
        commands.push(JSON.parse(String(data)) as SandboxCommand);
      },
      close: () => {
        socket.readyState = 3;
      },
    };
    const current = sandboxRepository.getSandbox()!;
    wsManager.acceptAndSetSandboxSocket(socket, current.modal_sandbox_id!);
    await sandboxEventProcessor.processSandboxEvent({
      type: "ready",
      sandboxId: current.modal_sandbox_id!,
      timestamp: Date.now() / 1_000,
      harness: "opencode",
      runtimeVersion: SANDBOX_RUNTIME_VERSION,
      preservationProtocolVersion: 1,
    });
    await settle();
    expect(prompts()).toEqual([]);
    await sandboxEventProcessor.processSandboxEvent({
      type: "sandbox_generation_ready",
      generation: { sandboxId: current.modal_sandbox_id!, createdAt: current.created_at },
      sandboxId: current.modal_sandbox_id!,
      timestamp: Date.now() / 1_000,
    });
    await settle();
  };
  const complete = async (messageId: string) => {
    await sandboxEventProcessor.processSandboxEvent({
      type: "execution_complete",
      messageId,
      success: true,
      sandboxId: sandboxRepository.getSandbox()!.modal_sandbox_id!,
      timestamp: Date.now() / 1_000,
    });
    await settle();
  };
  return {
    runtime,
    messageQueue,
    lifecycleManager,
    shutdown,
    create,
    restore,
    capture,
    stop,
    prompts,
    rows,
    settle,
    autofix,
    enqueue,
    ready,
    complete,
    restart: build,
  };
}

describe("Autofix feedback across sandbox recovery", () => {
  it.each(["running", "restoring"] as const)(
    "queues feedback behind an interrupted %s restore and drains in arrival order without redelivery",
    async (phase) => {
      const stub = await recoverySession();
      await runInSessionDO(stub, async (instance, state) => {
        const h = recoveryHarness(instance, state, { phase }, true);
        expect(h.shutdown.read()).toMatchObject({ phase, restoreInvoked: true });
        expect(h.lifecycleManager.mayProcessQueuedWork()).toBe(false);
        expect(h.shutdown.read()).toMatchObject({ phase: "unknown", restoreInvoked: true });
        expect(h.rows()).toEqual([{ id: "queued-user", status: "pending" }]);

        const first = await h.enqueue(feedback(1));
        const second = await h.enqueue(feedback(2));
        expect(first).not.toBe(second);
        await expect(h.autofix(feedback(1))).resolves.toEqual({
          kind: "duplicate",
          messageId: first,
        });
        await h.messageQueue.processMessageQueue();
        await h.settle();
        const ids = ["queued-user", first, second];
        expect(h.rows()).toEqual(ids.map((id) => ({ id, status: "pending" })));
        expect(h.prompts()).toEqual([]);
        expect(h.create).not.toHaveBeenCalled();
        expect(h.restore).not.toHaveBeenCalled();
        expect(h.stop).not.toHaveBeenCalled();

        await h.lifecycleManager.recoverShutdown("restore_saved");
        await h.settle();
        expect(h.restore).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ snapshotImageId: "saved-snapshot" })
        );
        expect(h.create).not.toHaveBeenCalled();
        expect(h.rows()).toEqual(ids.map((id) => ({ id, status: "pending" })));
        expect(h.prompts()).toEqual([]);
        await h.ready();
        expect(h.prompts().map((prompt) => prompt.messageId)).toEqual(ids.slice(0, 1));
        await h.complete(ids[0]);
        expect(h.prompts().map((prompt) => prompt.messageId)).toEqual(ids.slice(0, 2));
        await h.complete(ids[1]);
        expect(h.prompts().map((prompt) => prompt.messageId)).toEqual(ids);
        await h.complete(ids[2]);
        expect(h.rows()).toEqual(ids.map((id) => ({ id, status: "completed" })));
        expect(h.prompts().map((prompt) => prompt.messageId)).toEqual(ids);
        expect(h.restore).toHaveBeenCalledOnce();
        expect(h.create).not.toHaveBeenCalled();
      });
    }
  );

  it("dispatches held feedback after discard creates a fresh sandbox rather than restoring", async () => {
    const stub = await recoverySession();
    await runInSessionDO(stub, async (instance, state) => {
      const h = recoveryHarness(instance, state);
      state.storage.sql.exec("UPDATE session SET status = 'failed'");
      const [{ session_name: sessionName }] = state.storage.sql
        .exec("SELECT session_name FROM session")
        .toArray();
      await env.DB.prepare("UPDATE sessions SET status = 'failed' WHERE id = ?")
        .bind(sessionName)
        .run();
      const projection = vi
        .spyOn(SessionStatusProjectionStore.prototype, "project")
        .mockRejectedValueOnce(new Error("D1 temporarily unavailable"));
      const messageId = await h.enqueue(feedback(1));
      expect(state.storage.sql.exec("SELECT status FROM session").one()).toMatchObject({
        status: "active",
      });
      expect(
        await env.DB.prepare("SELECT status FROM sessions WHERE id = ?").bind(sessionName).first()
      ).toMatchObject({ status: "failed" });
      await expect(h.autofix(feedback(1))).resolves.toEqual({
        kind: "duplicate",
        messageId,
      });
      expect(projection).toHaveBeenCalledTimes(2);
      expect(
        await env.DB.prepare("SELECT status FROM sessions WHERE id = ?").bind(sessionName).first()
      ).toMatchObject({ status: "active" });
      expect(h.rows()).toEqual([{ id: messageId, status: "pending" }]);
      expect(h.prompts()).toEqual([]);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.restore).not.toHaveBeenCalled();
      await h.lifecycleManager.recoverShutdown("discard");
      await h.settle();
      expect(h.create).toHaveBeenCalledOnce();
      expect(h.restore).not.toHaveBeenCalled();
      expect(h.shutdown.read()?.receipt).toBeUndefined();
      expect(h.rows()).toEqual([{ id: messageId, status: "pending" }]);
      expect(h.prompts()).toEqual([]);
      await h.ready();
      expect(h.prompts().map((prompt) => prompt.messageId)).toEqual([messageId]);
      await h.complete(messageId);
      expect(h.rows()).toEqual([{ id: messageId, status: "completed" }]);
      expect(h.restore).not.toHaveBeenCalled();
    });
  });

  it("repairs local and index status through HTTP lookup after admission is interrupted", async () => {
    const stub = await recoverySession();
    await runInSessionDO(stub, async (instance, state) => {
      const h = recoveryHarness(instance, state);
      const sql = state.storage.sql;
      sql.exec("UPDATE session SET status = 'failed'");
      const [{ session_name: sessionName }] = sql
        .exec("SELECT session_name FROM session")
        .toArray();
      await env.DB.prepare("UPDATE sessions SET status = 'failed' WHERE id = ?")
        .bind(sessionName)
        .run();
      const admit = MessageRepository.prototype.admitAutofixMessage;
      vi.spyOn(MessageRepository.prototype, "admitAutofixMessage").mockImplementationOnce(function (
        this: MessageRepository,
        data
      ) {
        admit.call(this, data);
        throw new Error("Interrupted after admission committed");
      });
      const command = feedback(1);
      await expect(h.autofix(command)).rejects.toThrow("Interrupted after admission committed");
      expect(h.rows()).toEqual([{ id: expect.any(String), status: "pending" }]);
      const [{ id: messageId }] = h.rows();
      expect(sql.exec("SELECT status FROM session").one()).toMatchObject({ status: "failed" });
      expect(
        await env.DB.prepare("SELECT status FROM sessions WHERE id = ?").bind(sessionName).first()
      ).toMatchObject({ status: "failed" });

      await expect(
        h.autofix({ type: "lookup_feedback", feedbackKey: command.feedbackKey }, h.restart())
      ).resolves.toEqual({ kind: "found", messageId });
      await h.settle();
      expect(sql.exec("SELECT status FROM session").one()).toMatchObject({ status: "active" });
      expect(
        await env.DB.prepare("SELECT status FROM sessions WHERE id = ?").bind(sessionName).first()
      ).toMatchObject({ status: "active" });
      expect(h.rows()).toEqual([{ id: messageId, status: "pending" }]);
      expect(h.prompts()).toEqual([]);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.restore).not.toHaveBeenCalled();
    });
  });

  it("rejects an invalid Autofix HTTP command before persisting feedback", async () => {
    const stub = await recoverySession();
    await runInSessionDO(stub, async (instance, state) => {
      const h = recoveryHarness(instance, state);
      const response = await h.runtime.server.onRequest(
        new Request(`http://internal${SessionInternalPaths.autofix}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...feedback(1), prompt: "" }),
        })
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid Autofix command" });
      expect(h.rows()).toEqual([]);
    });
  });

  it("runs held feedback after a successful eligible capture retry without another recovery request", async () => {
    const stub = await recoverySession();
    await runInSessionDO(stub, async (instance, state) => {
      const now = Date.now();
      const h = recoveryHarness(instance, state, {
        phase: "unknown",
        restoreInvoked: false,
        receipt: undefined,
        continuationPaused: false,
        captureFailure: true,
        reason: "inactivity_timeout",
        operationId: "failed-capture",
        stopByMs: now - 1_000,
        captureByMs: now + 240_000,
        retireByMs: now + 270_000,
      });
      expect(h.lifecycleManager.shutdownSnapshot()?.availableRecoveryActions).toContain("retry");
      const messageId = await h.enqueue(feedback(1));
      expect(h.prompts()).toEqual([]);
      await h.lifecycleManager.recoverShutdown("retry");
      await h.settle();
      expect(h.capture).toHaveBeenCalledOnce();
      expect(h.shutdown.read()).not.toMatchObject({ continuationPaused: true });
      expect(h.restore).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ snapshotImageId: "retry-snapshot" })
      );
      expect(h.create).not.toHaveBeenCalled();
      expect(h.rows()).toEqual([{ id: messageId, status: "pending" }]);
      expect(h.prompts()).toEqual([]);
      await h.ready();
      expect(h.prompts().map((prompt) => prompt.messageId)).toEqual([messageId]);
      await h.complete(messageId);
      expect(h.rows()).toEqual([{ id: messageId, status: "completed" }]);
    });
  });

  it("retains feedback during a provider mismatch with no currently available recovery action", async () => {
    const stub = await recoverySession();
    await runInSessionDO(stub, async (instance, state) => {
      const h = recoveryHarness(instance, state, { phase: "unknown", provider: "modal-vm" });
      expect(h.lifecycleManager.shutdownSnapshot()).toMatchObject({
        phase: "unknown",
        availableRecoveryActions: [],
        discardAvailable: false,
      });
      const messageId = await h.enqueue(feedback(1));
      await h.messageQueue.processMessageQueue();
      await h.settle();
      expect(h.rows()).toEqual([{ id: messageId, status: "pending" }]);
      expect(h.prompts()).toEqual([]);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.restore).not.toHaveBeenCalled();
      expect(h.stop).not.toHaveBeenCalled();
    });
  });

  it("queues feedback when an in-flight discard temporarily exposes no recovery actions", async () => {
    const stub = await recoverySession();
    await runInSessionDO(stub, async (instance, state) => {
      const h = recoveryHarness(instance, state);
      let confirmStop!: () => void;
      h.stop.mockReturnValueOnce(
        new Promise((resolve) => {
          confirmStop = () => resolve({ success: true });
        })
      );
      const discard = h.lifecycleManager.recoverShutdown("discard");
      try {
        await vi.waitFor(() => expect(h.stop).toHaveBeenCalledOnce());
        expect(h.lifecycleManager.shutdownSnapshot()).toMatchObject({
          phase: "unknown",
          availableRecoveryActions: [],
          discardAvailable: false,
        });
        const messageId = await h.enqueue(feedback(1));
        expect(h.rows()).toEqual([{ id: messageId, status: "pending" }]);
        expect(h.prompts()).toEqual([]);
        expect(h.create).not.toHaveBeenCalled();
        expect(h.restore).not.toHaveBeenCalled();

        confirmStop();
        await discard;
        await h.settle();
        expect(h.create).toHaveBeenCalledOnce();
        expect(h.restore).not.toHaveBeenCalled();
        await h.ready();
        expect(h.prompts().map((prompt) => prompt.messageId)).toEqual([messageId]);
        await h.complete(messageId);
        expect(h.rows()).toEqual([{ id: messageId, status: "completed" }]);
      } finally {
        confirmStop();
        await discard;
        await h.settle();
      }
    });
  });

  it("still blocks a user API prompt with SandboxPromptBlockedError and HTTP 409 under the real hold", async () => {
    const stub = await recoverySession();
    await runInSessionDO(stub, async (instance, state) => {
      const h = recoveryHarness(instance, state);
      const prompt = { content: "New user work", authorId: "user-1", source: "web" as const };
      await expect(h.messageQueue.enqueuePromptFromApi(prompt)).rejects.toBeInstanceOf(
        SandboxPromptBlockedError
      );
      const response = await h.runtime.server.onRequest(
        new Request(`http://internal${SessionInternalPaths.prompt}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prompt),
        })
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: "SANDBOX_RECOVERY_REQUIRED" });
      expect(h.rows()).toEqual([]);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.restore).not.toHaveBeenCalled();
    });
  });

  it("counts pending feedback admitted during the hold against the rolling attempt limit", async () => {
    const stub = await recoverySession();
    await runInSessionDO(stub, async (instance, state) => {
      const h = recoveryHarness(instance, state);
      const first = await h.enqueue(feedback(1, 2));
      const second = await h.enqueue(feedback(2, 2));
      await expect(h.autofix(feedback(3, 2))).resolves.toEqual({
        kind: "rejected",
        reason: "attempt_limit",
      });
      await expect(h.autofix(feedback(1, 2))).resolves.toEqual({
        kind: "duplicate",
        messageId: first,
      });
      await h.settle();
      expect(h.rows()).toEqual([first, second].map((id) => ({ id, status: "pending" })));
      expect(h.prompts()).toEqual([]);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.restore).not.toHaveBeenCalled();
    });
  });
});
