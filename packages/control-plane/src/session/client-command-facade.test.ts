import { describe, expect, it, vi } from "vitest";
import type { ShutdownRecoveryAction } from "@open-inspect/shared/types/sandbox-shutdown";
import { SessionClientCommandFacade } from "./client-command-facade";
import type { ClientInfo } from "../types";
import type { SessionWebSocket } from "../platform-ports";
import type { SessionMessageQueue } from "./message-queue";
import type { SessionWebSocketManager } from "./websocket-manager";
import {
  BudgetExhaustedError,
  HarnessModelIncompatibleError,
  PromptQueueFullError,
  PromptRequestConflictError,
  SandboxPromptBlockedError,
  SessionNotPromptableError,
  type SessionPromptAdmission,
} from "./prompt-admission";
import { SessionAttachmentError } from "./session-attachment-resolver";

function createFacade(recover?: (action: ShutdownRecoveryAction) => Promise<void>) {
  const admission = {
    enqueueFromWeb: vi.fn<SessionPromptAdmission["enqueueFromWeb"]>(async () => ({
      messageId: "msg-1",
      position: 1,
      deduplicated: false,
    })),
  };
  const prompts = {
    processMessageQueue: vi.fn<SessionMessageQueue["processMessageQueue"]>(),
    cancelQueuedPrompt: vi.fn<SessionMessageQueue["cancelQueuedPrompt"]>(async (_, notify) => {
      notify();
      return true;
    }),
  };
  const sockets = { send: vi.fn<SessionWebSocketManager["send"]>(() => true) };
  const facade = new SessionClientCommandFacade(
    {} as never,
    prompts as unknown as SessionMessageQueue,
    admission as unknown as SessionPromptAdmission,
    sockets as unknown as SessionWebSocketManager,
    vi.fn(async () => {}),
    {} as never,
    {} as never,
    recover
  );
  return { facade, admission, prompts, sockets };
}

describe("SessionClientCommandFacade", () => {
  it("rejects shutdown recovery when no handler is configured", async () => {
    await expect(createFacade().facade.recoverShutdown("retry")).rejects.toThrow(
      "Shutdown recovery is not configured"
    );
  });

  it("delegates shutdown recovery to the configured handler", async () => {
    const recover = vi.fn(async () => {});

    await createFacade(recover).facade.recoverShutdown("restore_saved");

    expect(recover).toHaveBeenCalledWith("restore_saved");
  });

  it("propagates configured shutdown recovery failures", async () => {
    const recover = vi.fn(async () => {
      throw new Error("retry failed");
    });

    await expect(createFacade(recover).facade.recoverShutdown("retry")).rejects.toThrow(
      "retry failed"
    );
  });

  const connection = {} as SessionWebSocket;
  const client = { participantId: "part-1", userId: "user-1", name: "User" } as ClientInfo;
  const message = { type: "prompt", content: "Continue", clientRequestId: "request-1" } as const;

  it.each([
    [new SessionAttachmentError("Invalid upload"), "INVALID_ATTACHMENTS"],
    [new SessionNotPromptableError("cancelled"), "SESSION_NOT_PROMPTABLE"],
    [new SandboxPromptBlockedError("Recover first"), "SANDBOX_RECOVERY_REQUIRED"],
    [new PromptQueueFullError(), "PROMPT_QUEUE_FULL"],
    [new PromptRequestConflictError(), "PROMPT_REQUEST_CONFLICT"],
    [new BudgetExhaustedError(), "BUDGET_EXHAUSTED"],
    [new HarnessModelIncompatibleError("Incompatible model"), "HARNESS_MODEL_INCOMPATIBLE"],
  ] as const)("translates %s into a correlated %s response", async (error, code) => {
    const h = createFacade();
    h.admission.enqueueFromWeb.mockRejectedValue(error);

    await h.facade.submitPrompt(connection, client, message);

    expect(h.sockets.send).toHaveBeenCalledExactlyOnceWith(connection, {
      type: "error",
      code,
      message: error.message,
      clientRequestId: "request-1",
    });
    expect(h.prompts.processMessageQueue).not.toHaveBeenCalled();
  });

  it("propagates unexpected admission failures without a protocol acknowledgement", async () => {
    const h = createFacade();
    h.admission.enqueueFromWeb.mockRejectedValue(new Error("Storage unavailable"));

    await expect(h.facade.submitPrompt(connection, client, message)).rejects.toThrow(
      "Storage unavailable"
    );

    expect(h.sockets.send).not.toHaveBeenCalled();
    expect(h.prompts.processMessageQueue).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "acknowledges receipt before dispatch, deduplicated=%s",
    async (deduplicated) => {
      const h = createFacade();
      h.admission.enqueueFromWeb.mockResolvedValue({
        messageId: "msg-1",
        position: null,
        deduplicated,
      });

      await h.facade.submitPrompt(connection, client, message);

      expect(h.admission.enqueueFromWeb).toHaveBeenCalledWith(client, message);
      expect(h.sockets.send).toHaveBeenCalledExactlyOnceWith(connection, {
        type: "prompt_queued",
        clientRequestId: "request-1",
        messageId: "msg-1",
        position: null,
      });
      expect(h.sockets.send.mock.invocationCallOrder[0]).toBeLessThan(
        h.prompts.processMessageQueue.mock.invocationCallOrder[0]
      );
    }
  );

  it("does not translate dispatch failures into admission errors after acknowledging", async () => {
    const h = createFacade();
    h.prompts.processMessageQueue.mockRejectedValue(new BudgetExhaustedError());

    await expect(h.facade.submitPrompt(connection, client, message)).rejects.toThrow(
      BudgetExhaustedError
    );

    expect(h.sockets.send).toHaveBeenCalledOnce();
    expect(h.sockets.send.mock.calls[0][1]).toMatchObject({ type: "prompt_queued" });
  });

  it.each([false, true])("translates cancellation result, cancelled=%s", async (cancelled) => {
    const h = createFacade();
    h.prompts.cancelQueuedPrompt.mockImplementation(async (_, notify) => {
      expect(h.sockets.send).not.toHaveBeenCalled();
      if (cancelled) notify();
      return cancelled;
    });

    await h.facade.cancelPrompt(connection, {
      type: "cancel_prompt",
      messageId: "msg-1",
      clientRequestId: "request-1",
    });

    expect(h.prompts.cancelQueuedPrompt).toHaveBeenCalledWith("msg-1", expect.any(Function));
    expect(h.sockets.send).toHaveBeenCalledExactlyOnceWith(
      connection,
      cancelled
        ? {
            type: "prompt_cancelled",
            clientRequestId: "request-1",
            messageId: "msg-1",
          }
        : {
            type: "error",
            code: "PROMPT_NOT_CANCELLABLE",
            message: "This prompt is no longer pending and cannot be removed",
            clientRequestId: "request-1",
          }
    );
  });
});
