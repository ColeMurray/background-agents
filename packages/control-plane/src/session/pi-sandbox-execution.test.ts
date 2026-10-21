import { describe, expect, it, vi } from "vitest";
import { PiSandboxExecutionCoordinator } from "./pi-sandbox-execution";
import type { SandboxCommandAuthority, SandboxCommandRecord } from "./sandbox-command-repository";

const command = {
  type: "command_execute" as const,
  effect: "sandbox_execution" as const,
  commandId: "cmd-1",
  purpose: "test" as const,
  argv: ["npm", "test"],
};
const authority: SandboxCommandAuthority = {
  fingerprint: "fingerprint",
  actorKind: "user",
  actorId: "user-1",
  approvalRevision: 1,
  credentialProfile: "execution-ws-v1",
  egressProfile: "package-install-v1",
  taskId: 7,
  toolCallId: "call-1",
};

function record(state: SandboxCommandRecord["state"] = "queued"): SandboxCommandRecord {
  return {
    id: command.commandId,
    operationId: "operation-1",
    request: command,
    authority,
    state,
    sandboxId: null,
    bridgeInstanceId: null,
    lastOutputSequence: -1,
    outputBytes: 0,
    outputTruncated: false,
    exitCode: null,
    signal: null,
    error: null,
    createdAt: 100,
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

function fixture(options: { fenced?: boolean; sandbox?: Record<string, unknown> | null } = {}) {
  let sandbox: {
    status: string;
    runtime_mode?: "agent" | "execution";
    modal_sandbox_id?: string | null;
    execution_bridge_id?: string | null;
  } | null =
    options.sandbox === undefined
      ? null
      : (options.sandbox as {
          status: string;
          runtime_mode?: "agent" | "execution";
          modal_sandbox_id?: string | null;
          execution_bridge_id?: string | null;
        } | null);
  const commands = {
    admit: vi.fn(() => ({ kind: "created" as const, command: record() })),
    markDispatchAttempt: vi.fn(() => true),
    requestCancellation: vi.fn(() => "cancelling" as const),
    requestOperationCancellation: vi.fn<() => string[]>(() => []),
    recordCancelAttempt: vi.fn(() => true),
    markIndeterminate: vi.fn(() => true),
    get: vi.fn<() => SandboxCommandRecord | null>(() => record()),
    listOperation: vi.fn(() => []),
    nextQueued: vi.fn(() => null),
    recoveryCommands: vi.fn(() => [command]),
    claimExpired: vi.fn(() => []),
    claimDueDispatchRetries: vi.fn<() => (typeof command)[]>(() => []),
    claimDispatchExhaustions: vi.fn(() => []),
    claimDueCancellationRetries: vi.fn<() => string[]>(() => []),
    claimCancellationEscalations: vi.fn<() => string[]>(() => []),
    getNextDeadline: vi.fn<() => number | null>(() => null),
    prune: vi.fn(),
  };
  const sandboxes = {
    getSandbox: vi.fn(() => sandbox),
    createSandbox: vi.fn((data) => {
      sandbox = { ...data, runtime_mode: data.runtimeMode, modal_sandbox_id: null };
    }),
  };
  const lifecycle = {
    spawnSandbox: vi.fn(async () => undefined),
    replaceExecutionSandbox: vi.fn(async () => undefined),
  };
  const sockets = { sendToSandbox: vi.fn(() => true) };
  const alarmScheduler = { schedule: vi.fn(async () => undefined) };
  const coordinator = new PiSandboxExecutionCoordinator({
    commands,
    sandboxes,
    lifecycle,
    sockets,
    alarmScheduler,
    getSession: () => ({ id: "session-1", harness: "pi" }),
    isFenced: () => options.fenced ?? false,
    generateId: () => "sandbox-row-1",
    now: () => 100,
  });
  return { coordinator, commands, sandboxes, lifecycle, sockets, alarmScheduler };
}

describe("PiSandboxExecutionCoordinator", () => {
  it("does not admit commands after preservation fences the sandbox", async () => {
    const h = fixture({ fenced: true });

    await expect(h.coordinator.submit(command, "operation-1", authority)).rejects.toThrow(
      /preservation/i
    );
    expect(h.commands.admit).not.toHaveBeenCalled();
  });

  it("creates the dormant sandbox row lazily and provisions execution mode", async () => {
    const h = fixture();

    await h.coordinator.submit(command, "operation-1", authority);

    expect(h.sandboxes.createSandbox).toHaveBeenCalledWith({
      id: "sandbox-row-1",
      status: "pending",
      gitSyncStatus: "pending",
      createdAt: 100,
      runtimeMode: "execution",
    });
    expect(h.lifecycle.spawnSandbox).toHaveBeenCalledExactlyOnceWith("spawn", "execution");
    expect(h.sockets.sendToSandbox).not.toHaveBeenCalled();
  });

  it("dispatches immediately to a ready execution sandbox", async () => {
    const h = fixture({
      sandbox: {
        status: "ready",
        runtime_mode: "execution",
        modal_sandbox_id: "sandbox-1",
        execution_bridge_id: "bridge-1",
      },
    });

    await h.coordinator.submit(command, "operation-1", authority);

    expect(h.sockets.sendToSandbox).toHaveBeenCalledExactlyOnceWith(command);
    expect(h.commands.markDispatchAttempt).toHaveBeenCalledExactlyOnceWith(
      "cmd-1",
      "sandbox-1",
      "bridge-1",
      100,
      900_100
    );
    expect(h.commands.markDispatchAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      h.sockets.sendToSandbox.mock.invocationCallOrder[0]
    );
    expect(h.lifecycle.spawnSandbox).not.toHaveBeenCalled();
  });

  it("replays durable command state whenever the execution bridge becomes ready", async () => {
    const h = fixture({
      sandbox: {
        status: "ready",
        runtime_mode: "execution",
        modal_sandbox_id: "sandbox-1",
        execution_bridge_id: "bridge-1",
      },
    });

    await h.coordinator.onSandboxReady();

    expect(h.sockets.sendToSandbox).toHaveBeenCalledExactlyOnceWith(command);
    expect(h.commands.recoveryCommands).toHaveBeenCalledExactlyOnceWith(
      "sandbox-1",
      "bridge-1",
      100
    );
    expect(h.commands.markDispatchAttempt).toHaveBeenCalledExactlyOnceWith(
      "cmd-1",
      "sandbox-1",
      "bridge-1",
      100,
      900_100
    );
  });

  it("uses the existing session alarm scheduler for command deadlines", async () => {
    const h = fixture({
      sandbox: {
        status: "ready",
        runtime_mode: "execution",
        modal_sandbox_id: "sandbox-1",
        execution_bridge_id: "bridge-1",
      },
    });
    h.commands.getNextDeadline.mockReturnValue(600);

    await h.coordinator.submit({ ...command, timeoutMs: 500 }, "operation-1", authority);

    expect(h.commands.markDispatchAttempt).toHaveBeenCalledWith(
      "cmd-1",
      "sandbox-1",
      "bridge-1",
      100,
      600
    );
    expect(h.alarmScheduler.schedule).toHaveBeenCalledWith(600);
  });

  it("persists cancellation before asking the bridge to terminate the process group", () => {
    const h = fixture({
      sandbox: {
        status: "ready",
        runtime_mode: "execution",
        modal_sandbox_id: "sandbox-1",
        execution_bridge_id: "bridge-1",
      },
    });

    expect(h.coordinator.cancel("cmd-1")).toBe("cancelling");

    expect(h.commands.requestCancellation).toHaveBeenCalledExactlyOnceWith("cmd-1", 100);
    expect(h.commands.recordCancelAttempt).toHaveBeenCalledExactlyOnceWith("cmd-1", 100);
    expect(h.sockets.sendToSandbox).toHaveBeenCalledExactlyOnceWith({
      type: "command_cancel",
      commandId: "cmd-1",
    });
  });

  it("redrives a failed pre-start send with the same command id", async () => {
    const h = fixture({
      sandbox: {
        status: "ready",
        runtime_mode: "execution",
        modal_sandbox_id: "sandbox-1",
        execution_bridge_id: "bridge-1",
      },
    });
    h.sockets.sendToSandbox.mockReturnValue(false);
    h.commands.claimDueDispatchRetries.mockReturnValue([command]);

    await h.coordinator.submit(command, "operation-1", authority);
    await h.coordinator.handleAlarm();

    expect(h.sockets.sendToSandbox).toHaveBeenNthCalledWith(1, command);
    expect(h.sockets.sendToSandbox).toHaveBeenNthCalledWith(2, command);
    expect(h.commands.markDispatchAttempt).toHaveBeenCalledTimes(2);
  });

  it("retries failed cancellation delivery before escalating an uninterruptible command", async () => {
    const h = fixture({
      sandbox: {
        status: "ready",
        runtime_mode: "execution",
        modal_sandbox_id: "sandbox-1",
        execution_bridge_id: "bridge-1",
      },
    });
    h.sockets.sendToSandbox.mockReturnValue(false);
    h.commands.claimDueCancellationRetries.mockReturnValue(["cmd-1"]);
    h.commands.claimCancellationEscalations.mockReturnValue(["cmd-1"]);

    h.coordinator.cancel("cmd-1");
    await h.coordinator.handleAlarm();

    expect(h.commands.recordCancelAttempt).toHaveBeenCalledTimes(2);
    expect(h.commands.markIndeterminate).toHaveBeenCalledWith(
      "cmd-1",
      expect.stringMatching(/grace expired/i),
      100
    );
    expect(h.lifecycle.replaceExecutionSandbox).toHaveBeenCalledWith(
      "command_cancellation_timeout"
    );
  });

  it("durably cancels every active command when its Pi operation ends", () => {
    const h = fixture();
    h.commands.requestOperationCancellation.mockReturnValue(["cmd-1"]);
    h.commands.get.mockReturnValue(record("cancelling"));

    expect(h.coordinator.cancelOperation("operation-1")).toEqual(["cancelling"]);

    expect(h.commands.requestOperationCancellation).toHaveBeenCalledWith("operation-1", 100);
    expect(h.sockets.sendToSandbox).toHaveBeenCalledWith({
      type: "command_cancel",
      commandId: "cmd-1",
    });
  });
});
