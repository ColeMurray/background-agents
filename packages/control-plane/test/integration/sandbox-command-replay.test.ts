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

  async function ready(stub: DurableObjectStub, ws: WebSocket): Promise<void> {
    const [{ count }] = await queryDO<{ count: number }>(
      stub,
      "SELECT COUNT(*) AS count FROM events WHERE type = 'ready'"
    );
    ws.send(
      JSON.stringify({
        type: "ready",
        sandboxId: SANDBOX_AUTH.sandboxId,
        commandAckVersion: 1,
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
        message.type === "sandbox_connection" && message.status === "reconnecting",
    });
    const messageId = await enqueuePrompt(stub);
    expect(await reconnecting).toContainEqual({
      type: "sandbox_connection",
      status: "reconnecting",
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
      until: (message) => message.type === "sandbox_connection" && message.status === "connected",
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
    expect(await connected).toContainEqual({ type: "sandbox_connection", status: "connected" });
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
      const beforeDeadline = collectMessages(clientWs, { timeoutMs: NO_COMMAND_WINDOW_MS });
      await runInSessionDO(stub, async (instance, state) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(deadline - 1);
        try {
          await instance.alarm();
          expect(await state.storage.getAlarm()).toBe(deadline);
        } finally {
          clock.mockRestore();
        }
      });
      expect(
        (await beforeDeadline).filter(
          (message) => message.type === "sandbox_connection" && message.status === "reconnecting"
        )
      ).toEqual([]);

      const reconnecting = collectMessages(clientWs, {
        until: (message) =>
          message.type === "sandbox_connection" && message.status === "reconnecting",
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
        type: "sandbox_connection",
        status: "reconnecting",
      });
      expect(await queryDO(stub, "SELECT status FROM sandbox")).toEqual([{ status: "ready" }]);
      expect(await queryDO(stub, "SELECT status FROM messages")).toEqual(
        mode === "processing" ? [{ status: "processing" }] : []
      );

      const connected = collectMessages(clientWs, {
        until: (message) => message.type === "sandbox_connection" && message.status === "connected",
      });
      ws.send(
        JSON.stringify({
          type: "heartbeat",
          sandboxId: SANDBOX_AUTH.sandboxId,
          timestamp: Date.now(),
        })
      );
      expect(await connected).toContainEqual({ type: "sandbox_connection", status: "connected" });
    }
  );
});
