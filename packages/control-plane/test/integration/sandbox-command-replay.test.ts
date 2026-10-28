import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxCommand } from "../../src/session/types";
import { SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS } from "../../src/session/websocket-manager";
import { cleanD1Tables } from "./cleanup";
import {
  closeWebSocket,
  collectMessages,
  initNamedSession,
  openClientWs,
  openSandboxWs,
  queryDO,
  seedMessage,
  seedSandboxAuth,
} from "./helpers";
import { componentsOf, runInSessionDO } from "./session-do-access";

const SANDBOX_AUTH = { authToken: "command-replay-token", sandboxId: "sb-command-replay" };
const NO_COMMAND_WINDOW_MS = 150;
const PUSH_SPEC = {
  remoteUrl: "https://test-token@example.com/acme/web-app.git",
  redactedRemoteUrl: "https://***@example.com/acme/web-app.git",
  refspec: "HEAD:refs/heads/feature/replay",
  targetBranch: "feature/replay",
  repoOwner: "acme",
  repoName: "web-app",
  force: false,
};
type ReplayCommand = Extract<SandboxCommand, { type: "prompt" | "push" | "stop" }>;

describe("Sandbox command replay through the live session runtime", () => {
  const sockets: WebSocket[] = [];

  beforeEach(cleanD1Tables);
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const ws of sockets.splice(0)) {
      await closeWebSocket(ws, { bestEffort: true });
    }
  });

  async function connect(sessionName: string): Promise<WebSocket> {
    const { ws, response } = await openSandboxWs(sessionName, SANDBOX_AUTH);
    expect(response.status).toBe(101);
    if (!ws) throw new Error("Sandbox upgrade returned no WebSocket");
    ws.accept();
    sockets.push(ws);
    return ws;
  }

  async function ready(
    stub: DurableObjectStub,
    ws: WebSocket,
    bridgeInstanceId = "bridge-1",
    supportsStopConfirmation = true
  ): Promise<void> {
    const [{ count }] = await queryDO<{ count: number }>(
      stub,
      "SELECT COUNT(*) AS count FROM events WHERE type = 'ready'"
    );
    ws.send(
      JSON.stringify({
        type: "ready",
        sandboxId: SANDBOX_AUTH.sandboxId,
        commandAckVersion: 1,
        bridgeInstanceId,
        stopConfirmationVersion: supportsStopConfirmation ? 1 : undefined,
        timestamp: Date.now() / 1000,
      })
    );
    await vi.waitFor(async () => {
      expect(
        await queryDO<{ count: number }>(
          stub,
          "SELECT COUNT(*) AS count FROM events WHERE type = 'ready'"
        )
      ).toEqual([{ count: count + 1 }]);
      expect(
        await queryDO<{ supported: number }>(stub, "SELECT supported FROM sandbox_command_protocol")
      ).toEqual([{ supported: 1 }]);
    });
  }

  async function setup() {
    const sessionName = `command-replay-${crypto.randomUUID()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuth(stub, { ...SANDBOX_AUTH, status: "connecting" });
    const ws = await connect(sessionName);
    await ready(stub, ws);
    return { sessionName, stub, ws };
  }

  it.each(["before", "after"] as const)(
    "keeps a fresh reconnect open when a heartbeat arrives %s ready",
    async (order) => {
      const { sessionName, stub } = await setup();
      const replacement = await connect(sessionName);
      const previousHeartbeat = Date.now() - 1000;
      await runInSessionDO(stub, (instance, state) => {
        state.storage.sql.exec("UPDATE sandbox SET last_heartbeat = ?", previousHeartbeat);
        vi.spyOn(componentsOf(instance).wsManager, "close");
      });
      if (order === "after") await ready(stub, replacement);
      replacement.send(
        JSON.stringify({
          type: "heartbeat",
          sandboxId: SANDBOX_AUTH.sandboxId,
          timestamp: Date.now(),
        })
      );
      await vi.waitFor(async () => {
        const [sandbox] = await queryDO<{ last_heartbeat: number }>(
          stub,
          "SELECT last_heartbeat FROM sandbox"
        );
        expect(sandbox.last_heartbeat).toBeGreaterThan(previousHeartbeat);
      });
      await runInSessionDO(stub, (instance) => {
        const manager = componentsOf(instance).wsManager;
        expect(manager.close).not.toHaveBeenCalled();
        expect(manager.getSandboxSocket()).not.toBeNull();
      });
      if (order === "before") await ready(stub, replacement);
      await runInSessionDO(stub, (instance) => {
        expect(componentsOf(instance).wsManager.close).not.toHaveBeenCalled();
      });
    }
  );

  async function dropFirstCommand(stub: DurableObjectStub, type: ReplayCommand["type"]) {
    const dropped: ReplayCommand[] = [];
    await runInSessionDO(stub, (instance) => {
      const { wsManager } = componentsOf(instance);
      const send = wsManager.send.bind(wsManager);
      vi.spyOn(wsManager, "send").mockImplementation((ws, payload) => {
        const command = (
          typeof payload === "string" ? JSON.parse(payload) : payload
        ) as ReplayCommand;
        if (command.type === type && dropped.length === 0) {
          // Model a successful local send whose frame never reaches the bridge.
          dropped.push(command);
          return true;
        }
        return send(ws, payload);
      });
    });
    return dropped;
  }

  async function enqueuePrompt(stub: DurableObjectStub): Promise<string> {
    const response = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Execute this prompt once",
        authorId: "user-1",
        source: "web",
      }),
    });
    expect(response.status).toBe(200);
    const { messageId } = await response.json<{ messageId: string }>();
    expect(messageId).toEqual(expect.any(String));
    return messageId;
  }

  async function acknowledge(stub: DurableObjectStub, ws: WebSocket, commandId: string) {
    ws.send(JSON.stringify({ type: "command_ack", commandId, timestamp: Date.now() / 1000 }));
    await vi.waitFor(async () => {
      expect(
        await queryDO(
          stub,
          "SELECT command_id FROM sandbox_command_outbox WHERE command_id = ?",
          commandId
        )
      ).toEqual([]);
    });
  }

  it.each(["prompt", "push", "stop"] as const)(
    "replays a silently lost %s with the same commandId, then stops replaying after command_ack",
    async (type) => {
      const { sessionName, stub, ws } = await setup();
      const dropped = await dropFirstCommand(stub, type);
      const firstDelivery = collectMessages(ws, { timeoutMs: NO_COMMAND_WINDOW_MS });
      let messageId: string | undefined;
      let pushResult: { success: boolean; error?: string } | undefined;
      try {
        if (type === "prompt") {
          messageId = await enqueuePrompt(stub);
        } else if (type === "push") {
          await runInSessionDO(stub, (instance, state) => {
            // A spending limit stops new prompts, not publication of existing work.
            state.storage.sql.exec("UPDATE session SET budget_exhausted = 1");
            // Returning/awaiting this promise would block the test before the
            // replacement socket can deliver the terminal push event.
            state.waitUntil(
              componentsOf(instance)
                .pushService.pushBranchToRemote(PUSH_SPEC)
                .then((result) => {
                  pushResult = result;
                })
            );
          });
        } else {
          const [{ id: authorId }] = await queryDO<{ id: string }>(
            stub,
            "SELECT id FROM participants WHERE user_id = 'user-1'"
          );
          messageId = "message-stop-replay";
          await seedMessage(stub, {
            id: messageId,
            authorId,
            content: "Stop this execution",
            source: "web",
            status: "processing",
            createdAt: Date.now() - 1000,
            startedAt: Date.now() - 500,
          });
          const response = await stub.fetch("http://internal/internal/stop", { method: "POST" });
          expect(response.status).toBe(200);
        }

        await vi.waitFor(() => expect(dropped).toHaveLength(1));
        const command = dropped[0];
        expect(command.commandId).toEqual(expect.any(String));
        const commandId = command.commandId!;
        expect((await firstDelivery).filter((message) => message.type === type)).toEqual([]);
        expect(
          await queryDO<{ command_id: string; command_type: string }>(
            stub,
            "SELECT command_id, command_type FROM sandbox_command_outbox"
          )
        ).toEqual([{ command_id: commandId, command_type: type }]);

        const replacement = await connect(sessionName);
        const replay = collectMessages(replacement, {
          until: (message) => message.type === type,
        });
        await ready(stub, replacement);
        expect((await replay).filter((message) => message.type === type)).toEqual([command]);
        await acknowledge(stub, replacement, commandId);

        // ACK means receipt, not completion: keep the prompt/push/stop live
        // while proving that a further reconnect does not replay it.
        const reconnected = await connect(sessionName);
        const afterAck = collectMessages(reconnected, { timeoutMs: NO_COMMAND_WINDOW_MS });
        await ready(stub, reconnected);
        expect((await afterAck).filter((message) => message.type === type)).toEqual([]);

        if (type === "push") {
          expect(pushResult).toBeUndefined();
          reconnected.send(
            JSON.stringify({
              type: "push_complete",
              commandId,
              branchName: PUSH_SPEC.targetBranch,
              repoOwner: PUSH_SPEC.repoOwner,
              repoName: PUSH_SPEC.repoName,
              sandboxId: SANDBOX_AUTH.sandboxId,
              timestamp: Date.now() / 1000,
            })
          );
          await vi.waitFor(() => expect(pushResult).toEqual({ success: true }));
        } else {
          expect(
            await queryDO<{ status: string }>(
              stub,
              "SELECT status FROM messages WHERE id = ?",
              messageId!
            )
          ).toEqual([{ status: type === "prompt" ? "processing" : "failed" }]);
          const eventType = type === "prompt" ? "user_message" : "execution_complete";
          expect(
            await queryDO<{ id: string }>(
              stub,
              "SELECT id FROM events WHERE type = ? AND message_id = ?",
              eventType,
              messageId!
            )
          ).toEqual([{ id: `${eventType}:${messageId}` }]);
        }
      } finally {
        if (type === "push" && pushResult === undefined) {
          // Do not leave the push timeout/waitUntil alive if an assertion fails.
          await runInSessionDO(stub, (instance) => {
            componentsOf(instance).pushService.settlePush({
              type: "push_error",
              branchName: PUSH_SPEC.targetBranch,
              repoOwner: PUSH_SPEC.repoOwner,
              repoName: PUSH_SPEC.repoName,
              error: "Test cleanup",
              timestamp: Date.now() / 1000,
            });
          });
          await vi.waitFor(() => expect(pushResult).toBeDefined());
        }
      }
    }
  );

  it("holds a new prompt pending with reconnecting UI status until a fresh heartbeat", async () => {
    const { sessionName, stub, ws } = await setup();
    const { ws: clientWs } = await openClientWs(sessionName, { subscribe: true });
    sockets.push(clientWs);
    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE sandbox SET last_heartbeat = ?", Date.now() - 46_000);
    });

    const staleDelivery = collectMessages(ws, { timeoutMs: NO_COMMAND_WINDOW_MS });
    const reconnecting = collectMessages(clientWs, {
      until: (message) =>
        message.type === "sandbox_status" && message.connectionStatus === "reconnecting",
    });
    const messageId = await enqueuePrompt(stub);
    expect(await reconnecting).toContainEqual({
      type: "sandbox_status",
      status: "ready",
      connectionStatus: "reconnecting",
    });
    expect((await staleDelivery).filter((message) => message.type === "prompt")).toEqual([]);
    expect(
      await queryDO<{ status: string; started_at: number | null }>(
        stub,
        "SELECT status, started_at FROM messages WHERE id = ?",
        messageId
      )
    ).toEqual([{ status: "pending", started_at: null }]);
    expect(await queryDO(stub, "SELECT command_id FROM sandbox_command_outbox")).toEqual([]);
    expect(
      await queryDO(stub, "SELECT id FROM events WHERE id = ?", `user_message:${messageId}`)
    ).toEqual([]);

    const delivery = collectMessages(ws, { until: (message) => message.type === "prompt" });
    const connected = collectMessages(clientWs, {
      until: (message) =>
        message.type === "sandbox_status" && message.connectionStatus === "connected",
    });
    ws.send(
      JSON.stringify({
        type: "heartbeat",
        sandboxId: SANDBOX_AUTH.sandboxId,
        timestamp: Date.now() / 1000,
      })
    );
    const commands = (await delivery).filter((message) => message.type === "prompt");
    expect(commands).toEqual([
      expect.objectContaining({
        messageId,
        commandId: expect.any(String),
        content: "Execute this prompt once",
      }),
    ]);
    expect(await connected).toContainEqual({
      type: "sandbox_status",
      status: "ready",
      connectionStatus: "connected",
    });
    await acknowledge(stub, ws, commands[0].commandId as string);
    expect(await queryDO(stub, "SELECT status FROM messages WHERE id = ?", messageId)).toEqual([
      { status: "processing" },
    ]);
    expect(
      await queryDO(
        stub,
        "SELECT id FROM events WHERE type = 'user_message' AND message_id = ?",
        messageId
      )
    ).toEqual([{ id: `user_message:${messageId}` }]);
  });

  it.each(["stop", "cancel"] as const)(
    "delivers %s through the attached lifecycle socket before boot readiness",
    async (action) => {
      const { stub, ws } = await setup();
      const messageId = "booting-message";
      const [{ id: authorId }] = await queryDO<{ id: string }>(
        stub,
        "SELECT id FROM participants WHERE user_id = 'user-1'"
      );
      await seedMessage(stub, {
        id: messageId,
        authorId,
        content: "Held during boot",
        source: "web",
        status: "processing",
        createdAt: Date.now(),
        startedAt: Date.now(),
      });
      await runInSessionDO(stub, (instance, state) => {
        state.storage.sql.exec(
          "UPDATE sandbox SET status = 'connecting', last_heartbeat = ?",
          Date.now()
        );
        state.storage.sql.exec("DELETE FROM sandbox_command_protocol");
        const components = componentsOf(instance);
        expect(components.wsManager.getSandboxSocket()).not.toBeNull();
        expect(components.wsManager.getSandboxCommandTarget().kind).toBe("booting");
        vi.spyOn(components.lifecycleManager, "terminateUnresponsiveSandbox").mockResolvedValue();
      });
      const delivered = collectMessages(ws, { until: (message) => message.type === "stop" });
      if (action === "stop") {
        expect((await stub.fetch("http://internal/internal/stop", { method: "POST" })).status).toBe(
          200
        );
      } else {
        await runInSessionDO(stub, (instance) =>
          componentsOf(instance).messageQueue.cancelExecution()
        );
      }
      const command = (await delivered).find((message) => message.type === "stop")!;
      expect(command).toMatchObject({ type: "stop", messageId, commandId: expect.any(String) });
      await acknowledge(stub, ws, command.commandId as string);
      await runInSessionDO(stub, (instance, state) => {
        expect(
          componentsOf(instance).lifecycleManager.terminateUnresponsiveSandbox
        ).not.toHaveBeenCalled();
        state.storage.sql.exec(
          "UPDATE messages SET stop_confirmation_deadline = NULL WHERE id = ?",
          messageId
        );
      });
    }
  );

  it("does not replay an old generation's command even when the sandbox ID is reused", async () => {
    const { sessionName, stub } = await setup();
    const dropped = await dropFirstCommand(stub, "prompt");
    const messageId = await enqueuePrompt(stub);
    await vi.waitFor(() => expect(dropped).toHaveLength(1));
    expect(await queryDO(stub, "SELECT command_id FROM sandbox_command_outbox")).toEqual([
      { command_id: dropped[0].commandId },
    ]);

    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox SET created_at = created_at + 1, status = 'connecting'"
      );
    });
    const replacement = await connect(sessionName);
    const delivery = collectMessages(replacement, { timeoutMs: NO_COMMAND_WINDOW_MS });
    await ready(stub, replacement);
    expect((await delivery).filter((message) => message.type === "prompt")).toEqual([]);
    await vi.waitFor(async () => {
      expect(await queryDO(stub, "SELECT command_id FROM sandbox_command_outbox")).toEqual([]);
    });
    // Keep the message otherwise replayable: generation, not completion, fences it.
    expect(await queryDO(stub, "SELECT status FROM messages WHERE id = ?", messageId)).toEqual([
      { status: "processing" },
    ]);
  });

  it("fails uncertain delivery instead of replaying into a restarted bridge in the same sandbox", async () => {
    const { sessionName, stub } = await setup();
    const dropped = await dropFirstCommand(stub, "prompt");
    const messageId = await enqueuePrompt(stub);
    await vi.waitFor(() => expect(dropped).toHaveLength(1));
    await runInSessionDO(stub, (instance) => {
      const components = componentsOf(instance);
      vi.spyOn(components.lifecycleManager, "terminateFailedSandbox").mockImplementation(
        async () => {
          components.sandboxRepository.updateSandboxStatus("failed");
          return "sandbox_failed";
        }
      );
    });
    const replacement = await connect(sessionName);
    const frames = collectMessages(replacement, { timeoutMs: NO_COMMAND_WINDOW_MS });
    await ready(stub, replacement, "restarted-bridge-2");
    await vi.waitFor(async () =>
      expect(
        await queryDO(stub, "SELECT status, error_message FROM messages WHERE id = ?", messageId)
      ).toEqual([
        {
          status: "failed",
          error_message: expect.stringContaining("execution state is uncertain"),
        },
      ])
    );
    expect((await frames).filter((event) => event.type === "prompt")).toEqual([]);
    expect(await queryDO(stub, "SELECT command_id FROM sandbox_command_outbox")).toEqual([]);
    await runInSessionDO(stub, (instance) =>
      expect(
        componentsOf(instance).lifecycleManager.terminateFailedSandbox
      ).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Sandbox bridge restarted"))
    );
  });

  it.each([true, false])(
    "keeps the stop fence and final cost until containment confirmation (receipt ACK: %s)",
    async (receiptAck) => {
      const { stub, ws } = await setup();
      const firstDelivery = collectMessages(ws, { until: (message) => message.type === "prompt" });
      const firstId = await enqueuePrompt(stub);
      const first = (await firstDelivery).find((message) => message.type === "prompt")!;
      await acknowledge(stub, ws, first.commandId as string);
      const nextId = await enqueuePrompt(stub);
      const stopDelivery = collectMessages(ws, { until: (message) => message.type === "stop" });
      expect((await stub.fetch("http://internal/internal/stop", { method: "POST" })).status).toBe(
        200
      );
      const stop = (await stopDelivery).find((message) => message.type === "stop")!;
      if (receiptAck) await acknowledge(stub, ws, stop.commandId as string);
      const terminalAck = collectMessages(ws, {
        until: (message) => message.type === "ack" && message.ackId === "terminal-ack",
      });
      ws.send(
        JSON.stringify({
          type: "execution_complete",
          messageId: firstId,
          sandboxId: SANDBOX_AUTH.sandboxId,
          success: true,
          messageCostUsd: 1.25,
          timestamp: Date.now(),
          ackId: "terminal-ack",
        })
      );
      await terminalAck;
      expect(
        await queryDO(
          stub,
          "SELECT stop_confirmation_deadline, reported_cost_usd FROM messages WHERE id = ?",
          firstId
        )
      ).toEqual([{ stop_confirmation_deadline: expect.any(Number), reported_cost_usd: 1.25 }]);
      expect(await queryDO(stub, "SELECT status FROM messages WHERE id = ?", nextId)).toEqual([
        { status: "pending" },
      ]);
      const resumed = collectMessages(ws, {
        until: (message) => message.type === "prompt" && message.messageId === nextId,
      });
      const confirmation = {
        type: "stop_confirmed",
        messageId: firstId,
        commandId: stop.commandId,
        timestamp: Date.now(),
        ackId: "stop-confirmed-ack",
      };
      ws.send(JSON.stringify(confirmation));
      expect(await resumed).toContainEqual(
        expect.objectContaining({ type: "prompt", messageId: nextId })
      );
      expect(
        await queryDO(
          stub,
          "SELECT stop_confirmation_deadline, reported_cost_usd FROM messages WHERE id = ?",
          firstId
        )
      ).toEqual([{ stop_confirmation_deadline: null, reported_cost_usd: 1.25 }]);
      expect(
        await queryDO(
          stub,
          "SELECT command_id FROM sandbox_command_outbox WHERE command_type = 'stop'"
        )
      ).toEqual([]);
      ws.send(JSON.stringify(confirmation));
      expect(await queryDO(stub, "SELECT status FROM messages WHERE id = ?", nextId)).toEqual([
        { status: "processing" },
      ]);
    }
  );

  it.each(["surviving", "reconnecting", "known-v1", "legacy"] as const)(
    "resolves a pre-ready stop against its delivery protocol (%s)",
    async (rollout) => {
      const { sessionName, stub, ws: original } = await setup();
      let ws = original;
      const firstDelivery = collectMessages(ws, { until: (message) => message.type === "prompt" });
      const firstId = await enqueuePrompt(stub);
      const first = (await firstDelivery).find((message) => message.type === "prompt")!;
      await acknowledge(stub, ws, first.commandId as string);
      const nextId = await enqueuePrompt(stub);
      if (rollout !== "known-v1") {
        await runInSessionDO(stub, (_instance, state) =>
          state.storage.sql.exec("DELETE FROM sandbox_command_protocol")
        );
      }
      if (rollout === "reconnecting" || rollout === "known-v1") ws = await connect(sessionName);
      const stopDelivery = collectMessages(ws, { until: (message) => message.type === "stop" });
      expect((await stub.fetch("http://internal/internal/stop", { method: "POST" })).status).toBe(
        200
      );
      expect(
        await queryDO(
          stub,
          "SELECT stop_confirmation_requires_ack FROM messages WHERE id = ?",
          firstId
        )
      ).toEqual([{ stop_confirmation_requires_ack: 2 }]);
      const explicit = rollout !== "legacy";
      await ready(stub, ws, "bridge-1", explicit);
      const stop = (await stopDelivery).find((message) => message.type === "stop")!;
      expect(stop).toMatchObject({ type: "stop", messageId: firstId });
      expect(
        await queryDO(
          stub,
          "SELECT stop_confirmation_requires_ack FROM messages WHERE id = ?",
          firstId
        )
      ).toEqual([{ stop_confirmation_requires_ack: explicit ? 1 : 0 }]);
      await acknowledge(stub, ws, stop.commandId as string);
      const completionAck = collectMessages(ws, {
        until: (message) => message.type === "ack" && message.ackId === "rollout-completion",
      });
      ws.send(
        JSON.stringify({
          type: "execution_complete",
          messageId: firstId,
          success: false,
          sandboxId: SANDBOX_AUTH.sandboxId,
          timestamp: Date.now(),
          ackId: "rollout-completion",
        })
      );
      const frames = await completionAck;
      if (explicit) {
        expect(frames.filter((message) => message.type === "prompt")).toEqual([]);
        expect(
          await queryDO(
            stub,
            "SELECT stop_confirmation_deadline FROM messages WHERE id = ?",
            firstId
          )
        ).toEqual([{ stop_confirmation_deadline: expect.any(Number) }]);
        expect(await queryDO(stub, "SELECT status FROM messages WHERE id = ?", nextId)).toEqual([
          { status: "pending" },
        ]);
        const resumed = collectMessages(ws, {
          until: (message) => message.type === "prompt" && message.messageId === nextId,
        });
        ws.send(
          JSON.stringify({
            type: "stop_confirmed",
            messageId: firstId,
            commandId: stop.commandId,
            timestamp: Date.now(),
            ackId: "rollout-confirmation",
          })
        );
        await resumed;
      }
      expect(
        await queryDO(stub, "SELECT stop_confirmation_deadline FROM messages WHERE id = ?", firstId)
      ).toEqual([{ stop_confirmation_deadline: null }]);
      expect(await queryDO(stub, "SELECT status FROM messages WHERE id = ?", nextId)).toEqual([
        { status: "processing" },
      ]);
    }
  );

  it.each([true, false])(
    "resolves a receipt-ACKed boot stop when readiness identifies its policy (explicit: %s)",
    async (explicit) => {
      const { stub, ws } = await setup();
      const delivery = collectMessages(ws, { until: (message) => message.type === "prompt" });
      const messageId = await enqueuePrompt(stub);
      const prompt = (await delivery).find((message) => message.type === "prompt")!;
      await acknowledge(stub, ws, prompt.commandId as string);
      await runInSessionDO(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE sandbox SET status = 'connecting'");
        state.storage.sql.exec("DELETE FROM sandbox_command_protocol");
      });
      const stopped = collectMessages(ws, { until: (message) => message.type === "stop" });
      expect((await stub.fetch("http://internal/internal/stop", { method: "POST" })).status).toBe(
        200
      );
      const stop = (await stopped).find((message) => message.type === "stop")!;
      await acknowledge(stub, ws, stop.commandId as string);
      expect(
        await queryDO(
          stub,
          "SELECT stop_confirmation_requires_ack FROM messages WHERE id = ?",
          messageId
        )
      ).toEqual([{ stop_confirmation_requires_ack: 2 }]);
      await ready(stub, ws, "bridge-1", explicit);
      expect(
        await queryDO(
          stub,
          "SELECT stop_confirmation_requires_ack FROM messages WHERE id = ?",
          messageId
        )
      ).toEqual([{ stop_confirmation_requires_ack: explicit ? 1 : 0 }]);
      const completed = collectMessages(ws, {
        until: (message) => message.type === "ack" && message.ackId === "boot-completion",
      });
      ws.send(
        JSON.stringify({
          type: "execution_complete",
          sandboxId: SANDBOX_AUTH.sandboxId,
          messageId,
          success: false,
          timestamp: Date.now(),
          ackId: "boot-completion",
        })
      );
      await completed;
      expect(
        await queryDO(
          stub,
          "SELECT stop_confirmation_deadline FROM messages WHERE id = ?",
          messageId
        )
      ).toEqual([{ stop_confirmation_deadline: explicit ? expect.any(Number) : null }]);
      if (explicit) {
        const confirmed = collectMessages(ws, {
          until: (message) => message.type === "ack" && message.ackId === "boot-confirmed",
        });
        ws.send(
          JSON.stringify({
            type: "stop_confirmed",
            messageId,
            commandId: stop.commandId,
            timestamp: Date.now(),
            ackId: "boot-confirmed",
          })
        );
        await confirmed;
      }
    }
  );

  it.each(["idle", "processing"] as const)(
    "publishes reconnecting at the heartbeat deadline for an %s session without a new prompt",
    async (mode) => {
      const { sessionName, stub, ws } = await setup();
      const { ws: clientWs } = await openClientWs(sessionName, { subscribe: true });
      sockets.push(clientWs);
      if (mode === "processing") {
        const [{ id: authorId }] = await queryDO<{ id: string }>(
          stub,
          "SELECT id FROM participants WHERE user_id = 'user-1'"
        );
        await seedMessage(stub, {
          id: "quiet-prompt",
          authorId,
          content: "A quiet running prompt",
          source: "web",
          status: "processing",
          createdAt: Date.now(),
          startedAt: Date.now(),
        });
      }
      const [{ last_heartbeat: heartbeat }] = await queryDO<{ last_heartbeat: number }>(
        stub,
        "SELECT last_heartbeat FROM sandbox"
      );
      const deadline = heartbeat + SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS;
      await runInSessionDO(stub, async (instance, state) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(deadline - 1);
        const send = vi.spyOn(componentsOf(instance).wsManager, "send");
        try {
          await instance.alarm();
          expect(await state.storage.getAlarm()).toBe(deadline);
          expect(send).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: "sandbox_status", connectionStatus: "reconnecting" })
          );
        } finally {
          send.mockRestore();
          clock.mockRestore();
        }
      });

      const reconnecting = collectMessages(clientWs, {
        until: (message) =>
          message.type === "sandbox_status" && message.connectionStatus === "reconnecting",
      });
      await runInSessionDO(stub, async (instance) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(deadline);
        try {
          await instance.alarm();
        } finally {
          clock.mockRestore();
        }
      });
      expect(await reconnecting).toContainEqual({
        type: "sandbox_status",
        status: "ready",
        connectionStatus: "reconnecting",
      });
      expect(await queryDO(stub, "SELECT status FROM sandbox")).toEqual([{ status: "ready" }]);
      expect(await queryDO(stub, "SELECT status FROM messages")).toEqual(
        mode === "processing" ? [{ status: "processing" }] : []
      );

      const connected = collectMessages(clientWs, {
        until: (message) =>
          message.type === "sandbox_status" && message.connectionStatus === "connected",
      });
      ws.send(
        JSON.stringify({
          type: "heartbeat",
          sandboxId: SANDBOX_AUTH.sandboxId,
          timestamp: Date.now(),
        })
      );
      expect(await connected).toContainEqual({
        type: "sandbox_status",
        status: "ready",
        connectionStatus: "connected",
      });
    }
  );
});
