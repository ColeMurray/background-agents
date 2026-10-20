import { describe, expect, it, vi } from "vitest";
import type { SandboxCommandRecord } from "../../sandbox-command-repository";
import { PiSandboxExecutionHandler } from "./pi-sandbox-execution.handler";

const execute = {
  type: "command_execute" as const,
  effect: "sandbox_execution" as const,
  commandId: "cmd-1",
  purpose: "test" as const,
  argv: ["npm", "test"],
};

function record(): SandboxCommandRecord {
  return {
    id: "cmd-1",
    operationId: "operation-1",
    request: execute,
    authority: null,
    state: "queued",
    sandboxId: null,
    bridgeInstanceId: null,
    lastOutputSequence: -1,
    outputBytes: 0,
    outputTruncated: false,
    exitCode: null,
    signal: null,
    error: null,
    createdAt: 1,
    dispatchedAt: null,
    dispatchAttempts: 0,
    lastDispatchAt: null,
    acceptedAt: null,
    deadlineAt: null,
    startedAt: null,
    cancelRequestedAt: null,
    cancelDeadlineAt: null,
    cancelAttempts: 0,
    replayGap: false,
    lateCompletionAt: null,
    metadataExpiresAt: null,
    completedAt: null,
    output: [],
  };
}

function fixture(
  processingId: string | null = "operation-1",
  options: {
    sessionCapability?: "off" | "read_only" | "enabled";
    liveMode?: "off" | "read_only" | "enabled";
  } = {}
) {
  const execution = {
    submit: vi.fn(async () => record()),
    cancel: vi.fn(() => "cancelling" as const),
    cancelOperation: vi.fn(() => []),
  };
  const commands = {
    get: vi.fn(() => record()),
    outputPage: vi.fn(() => ({ chunks: [], nextSequence: null })),
  };
  return {
    handler: new PiSandboxExecutionHandler({
      execution,
      commands,
      getProcessingMessageId: () => processingId,
      getOperationActor: () => ({ kind: "user", id: "user-1" }),
      sessionCapability: () => options.sessionCapability ?? "enabled",
      liveMode: () => options.liveMode ?? "enabled",
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

const submit = {
  action: "submit",
  command: execute,
  taskId: 7,
  toolCallId: "call-1",
  approvalRevision: 1,
};

describe("PiSandboxExecutionHandler", () => {
  it("submits immutable authority for the currently processing Pi operation", async () => {
    const h = fixture();

    const response = await h.handler.handle(request(submit));

    expect(response.status).toBe(202);
    expect(h.execution.submit).toHaveBeenCalledExactlyOnceWith(
      execute,
      "operation-1",
      expect.objectContaining({
        actorKind: "user",
        actorId: "user-1",
        approvalRevision: 1,
        credentialProfile: "execution-ws-v1",
        egressProfile: "package-install-v1",
        taskId: 7,
        toolCallId: "call-1",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
  });

  it("refuses a new submission when the deployment has denied execution", async () => {
    const h = fixture("operation-1", { liveMode: "off" });

    const response = await h.handler.handle(request(submit));

    expect(response.status).toBe(403);
    expect(h.execution.submit).not.toHaveBeenCalled();
  });

  it("refuses a new submission when the session never had the capability", async () => {
    const h = fixture("operation-1", { sessionCapability: "off" });

    const response = await h.handler.handle(request(submit));

    expect(response.status).toBe(403);
    expect(h.execution.submit).not.toHaveBeenCalled();
  });

  it("keeps an admitted command reachable when the deployment denies execution", async () => {
    const h = fixture("operation-1", { liveMode: "off" });

    const response = await h.handler.handle(
      request({ action: "status", commandId: "cmd-1", afterSequence: -1 })
    );

    expect(response.status).toBe(200);
  });

  it.each([null, "another-operation"])(
    "rejects submission when the active operation is %s",
    async (processingId) => {
      const h = fixture(processingId);
      const response = await h.handler.handle(request(submit));
      expect(response.status).toBe(409);
      expect(h.execution.submit).not.toHaveBeenCalled();
    }
  );

  it("rejects replay commands from the Pi-side boundary", async () => {
    const h = fixture();
    const response = await h.handler.handle(
      request({
        ...submit,
        command: { type: "command_replay", commandId: "cmd-1", afterSequence: -1 },
      })
    );
    expect(response.status).toBe(400);
  });

  it("cancels only a command owned by the attributed operation", async () => {
    const h = fixture();
    const response = await h.handler.handle(request({ action: "cancel", commandId: "cmd-1" }));
    expect(response.status).toBe(200);
    expect(h.execution.cancel).toHaveBeenCalledExactlyOnceWith("cmd-1");
  });
});
