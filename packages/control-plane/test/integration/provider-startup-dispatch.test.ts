import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModalSandboxProvider } from "../../src/sandbox/providers/modal-provider";
import type { CreateSandboxResult } from "../../src/sandbox/provider";
import { componentsOf, runInSessionDO } from "./session-do-access";
import { cleanD1Tables } from "./cleanup";
import { collectMessages, initNamedSession, openSandboxWs, queryDO, seedMessage } from "./helpers";

describe("provider startup dispatch boundary", () => {
  const sockets: WebSocket[] = [];
  beforeEach(cleanD1Tables);
  afterEach(() => {
    vi.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.close();
  });

  it("closes an early-connected late-create failure and dispatches the waiting turn", async () => {
    let rejectCreate!: (error: Error) => void;
    const createResult = new Promise<CreateSandboxResult>((_resolve, reject) => {
      rejectCreate = reject;
    });
    const create = vi
      .spyOn(ModalSandboxProvider.prototype, "createSandbox")
      .mockReturnValue(createResult);
    const name = `late-provider-startup-${crypto.randomUUID()}`;
    try {
      const { stub } = await initNamedSession(name);
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      const config = create.mock.calls[0][0];
      const [participant] = await queryDO<{ id: string }>(
        stub,
        "SELECT id FROM participants LIMIT 1"
      );
      await seedMessage(stub, {
        id: "waiting-for-provider",
        authorId: participant.id,
        content: "Run after the provider startup resolves",
        source: "web",
        status: "pending",
        createdAt: Date.now(),
      });
      const { ws, response } = await openSandboxWs(name, {
        sandboxId: config.sandboxId,
        authToken: config.sandboxAuthToken,
      });
      expect(response.status).toBe(101);
      if (!ws) throw new Error("Expected authenticated sandbox WebSocket");
      ws.accept();
      sockets.push(ws);
      await runInSessionDO(stub, async (instance, state) => {
        // Exercise the upgraded-runtime queue, not the legacy admission exception.
        state.storage.sql.exec(
          "UPDATE sandbox SET runtime_capabilities = ?",
          JSON.stringify(["execution-deadline-v1", "stop-confirmation-v1"])
        );
        await componentsOf(instance).messageQueue.processMessageQueue();
        expect(
          state.storage.sql.exec("SELECT status, provider_execution_expiry_kind FROM sandbox").one()
        ).toEqual({ status: "ready", provider_execution_expiry_kind: null });
        expect(
          state.storage.sql
            .exec("SELECT status, started_at FROM messages WHERE id = 'waiting-for-provider'")
            .one()
        ).toEqual({ status: "pending", started_at: null });
      });
      const dispatched = collectMessages(ws, {
        until: (message) =>
          message.type === "prompt" && message.messageId === "waiting-for-provider",
      });
      rejectCreate(new Error("Late provider response failed after bridge authentication"));
      expect(await dispatched).toContainEqual(
        expect.objectContaining({
          type: "prompt",
          messageId: "waiting-for-provider",
          executionDeadlineMs: expect.any(Number),
        })
      );
      expect(
        await queryDO(stub, "SELECT status, provider_execution_expiry_kind FROM sandbox")
      ).toEqual([{ status: "ready", provider_execution_expiry_kind: "unknown" }]);
      expect(
        await queryDO(stub, "SELECT status FROM messages WHERE id = 'waiting-for-provider'")
      ).toEqual([{ status: "processing" }]);
      expect(create).toHaveBeenCalledOnce();
    } finally {
      rejectCreate(new Error("Test cleanup"));
    }
  });
});
