import { describe, expect, it, vi } from "vitest";
import { SandboxCommandEventHandler } from "./command.handler";

describe("SandboxCommandEventHandler", () => {
  it.each([
    {
      event: {
        type: "command_replay_gap" as const,
        commandId: "cmd-1",
        requestedAfterSequence: 0,
        firstAvailableSequence: null,
        lastSequence: -1,
        reason: "unknown_command" as const,
        sandboxId: "sandbox-1",
        timestamp: 1,
      },
      method: "recordReplayGap" as const,
      args: ["cmd-1", "Command output replay gap: unknown_command", 100] as const,
    },
    {
      event: {
        type: "command_accepted" as const,
        commandId: "cmd-1",
        sandboxId: "sandbox-1",
        timestamp: 1,
      },
      method: "recordAccepted" as const,
      args: ["cmd-1", 100] as const,
    },
    {
      event: {
        type: "command_started" as const,
        commandId: "cmd-1",
        sandboxId: "sandbox-1",
        timestamp: 1,
      },
      method: "recordStarted" as const,
      args: ["cmd-1", 100] as const,
    },
    {
      event: {
        type: "command_output" as const,
        commandId: "cmd-1",
        sequence: 0,
        stream: "stdout" as const,
        data: "ok\n",
        sandboxId: "sandbox-1",
        timestamp: 1,
      },
      method: "recordOutput" as const,
      args: null,
    },
    {
      event: {
        type: "command_completed" as const,
        commandId: "cmd-1",
        outcome: "succeeded" as const,
        exitCode: 0,
        signal: null,
        lastSequence: 0,
        sandboxId: "sandbox-1",
        timestamp: 1,
      },
      method: "complete" as const,
      args: null,
    },
  ])("persists $event.type", ({ event, method, args }) => {
    const repository = {
      recordStarted: vi.fn(),
      recordAccepted: vi.fn(),
      recordOutput: vi.fn(),
      complete: vi.fn(),
      recordReplayGap: vi.fn(),
    };
    const handler = new SandboxCommandEventHandler(repository, () => 100);

    handler.handle(event);

    expect(repository[method]).toHaveBeenCalledExactlyOnceWith(...(args ?? [event, 100]));
  });
});
