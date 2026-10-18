import { describe, expect, it, vi } from "vitest";
import { PiSandboxExecutionCoordinator } from "./pi-sandbox-execution";

const command = {
  type: "command_execute" as const,
  effect: "sandbox_execution" as const,
  commandId: "cmd-1",
  purpose: "test" as const,
  argv: ["npm", "test"],
};

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
    admit: vi.fn(() => ({ kind: "created" as const, command: { state: "queued" as const } })),
    markDispatched: vi.fn(() => true),
    requestCancellation: vi.fn(() => "cancelling" as const),
    recoveryCommands: vi.fn(() => [command]),
    claimExpired: vi.fn(() => []),
    getNextDeadline: vi.fn<() => number | null>(() => null),
  };
  const sandboxes = {
    getSandbox: vi.fn(() => sandbox),
    createSandbox: vi.fn((data) => {
      sandbox = { ...data, runtime_mode: data.runtimeMode, modal_sandbox_id: null };
    }),
  };
  const lifecycle = { spawnSandbox: vi.fn(async () => undefined) };
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

    await expect(h.coordinator.submit(command, "operation-1")).rejects.toThrow(/preservation/i);
    expect(h.commands.admit).not.toHaveBeenCalled();
  });

  it("creates the dormant sandbox row lazily and provisions execution mode", async () => {
    const h = fixture();

    await h.coordinator.submit(command, "operation-1");

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

    await h.coordinator.submit(command, "operation-1");

    expect(h.sockets.sendToSandbox).toHaveBeenCalledExactlyOnceWith(command);
    expect(h.commands.markDispatched).toHaveBeenCalledExactlyOnceWith(
      "cmd-1",
      "sandbox-1",
      "bridge-1",
      100,
      3_600_100
    );
    expect(h.commands.markDispatched.mock.invocationCallOrder[0]).toBeLessThan(
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
    expect(h.commands.markDispatched).toHaveBeenCalledExactlyOnceWith(
      "cmd-1",
      "sandbox-1",
      "bridge-1",
      100,
      3_600_100
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

    await h.coordinator.submit({ ...command, timeoutMs: 500 }, "operation-1");

    expect(h.commands.markDispatched).toHaveBeenCalledWith(
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
    expect(h.sockets.sendToSandbox).toHaveBeenCalledExactlyOnceWith({
      type: "command_cancel",
      commandId: "cmd-1",
    });
  });
});
