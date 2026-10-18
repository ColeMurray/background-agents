import { describe, expect, it, vi } from "vitest";
import { PiSandboxExecutionHandler } from "./pi-sandbox-execution.handler";

const execute = {
  type: "command_execute",
  effect: "sandbox_execution",
  commandId: "cmd-1",
  purpose: "test",
  argv: ["npm", "test"],
};

function fixture(processingId: string | null = "operation-1") {
  const execution = {
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(() => "cancelling" as const),
  };
  const commands = { get: vi.fn(() => ({ operationId: "operation-1" })) };
  return {
    handler: new PiSandboxExecutionHandler({
      execution,
      commands,
      getProcessingMessageId: () => processingId,
    }),
    execution,
  };
}

function request(body: unknown, operationId = "operation-1") {
  return new Request("http://internal/internal/pi-sandbox-command", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pi-Operation-ID": operationId,
    },
    body: JSON.stringify(body),
  });
}

describe("PiSandboxExecutionHandler", () => {
  it("submits only for the currently processing Pi operation", async () => {
    const h = fixture();

    const response = await h.handler.handle(request(execute));

    expect(response.status).toBe(202);
    expect(h.execution.submit).toHaveBeenCalledExactlyOnceWith(execute, "operation-1");
  });

  it.each([null, "another-operation"])(
    "rejects when the active operation is %s",
    async (processingId) => {
      const h = fixture(processingId);

      const response = await h.handler.handle(request(execute));

      expect(response.status).toBe(409);
      expect(h.execution.submit).not.toHaveBeenCalled();
    }
  );

  it("rejects replay commands from the Pi-side boundary", async () => {
    const h = fixture();

    const response = await h.handler.handle(
      request({ type: "command_replay", commandId: "cmd-1", afterSequence: -1 })
    );

    expect(response.status).toBe(400);
  });

  it("cancels only a command owned by the active operation", async () => {
    const h = fixture();

    const response = await h.handler.handle(
      request({ type: "command_cancel", commandId: "cmd-1" })
    );

    expect(response.status).toBe(202);
    expect(h.execution.cancel).toHaveBeenCalledExactlyOnceWith("cmd-1");
  });
});
