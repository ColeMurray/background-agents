import { describe, expect, it } from "vitest";
import {
  sandboxExecutionCommandSchema,
  sandboxExecutionEventSchema,
  sandboxRuntimeModeSchema,
} from "./sandbox-execution";

describe("sandbox execution protocol", () => {
  it("defaults the runtime to the existing agent mode", () => {
    expect(sandboxRuntimeModeSchema.parse(undefined)).toBe("agent");
    expect(sandboxRuntimeModeSchema.parse("execution")).toBe("execution");
    expect(sandboxRuntimeModeSchema.safeParse("build").success).toBe(false);
  });

  it("accepts an argv command without an environment or shell string", () => {
    expect(
      sandboxExecutionCommandSchema.parse({
        type: "command_execute",
        effect: "sandbox_execution",
        commandId: "cmd-1",
        purpose: "test",
        argv: ["npm", "test", "--", "unit"],
        cwd: "/workspace/repo",
        timeoutMs: 30_000,
      })
    ).toEqual({
      type: "command_execute",
      effect: "sandbox_execution",
      commandId: "cmd-1",
      purpose: "test",
      argv: ["npm", "test", "--", "unit"],
      cwd: "/workspace/repo",
      timeoutMs: 30_000,
    });
    expect(
      sandboxExecutionCommandSchema.safeParse({
        type: "command_execute",
        effect: "sandbox_execution",
        commandId: "cmd-1",
        purpose: "shell",
        command: "printenv",
        argv: ["printenv"],
        env: { TOKEN: "secret" },
      }).success
    ).toBe(false);
  });

  it("rejects empty argv, workspace escapes, and unbounded timeouts", () => {
    const base = {
      type: "command_execute",
      effect: "sandbox_execution",
      commandId: "cmd-1",
      purpose: "build",
      argv: ["npm", "run", "build"],
    };
    expect(sandboxExecutionCommandSchema.safeParse({ ...base, argv: [] }).success).toBe(false);
    expect(sandboxExecutionCommandSchema.safeParse({ ...base, cwd: "/etc" }).success).toBe(false);
    expect(
      sandboxExecutionCommandSchema.safeParse({ ...base, timeoutMs: 24 * 60 * 60 * 1_000 }).success
    ).toBe(false);
  });

  it("accepts cancellation and sequence-based replay commands", () => {
    expect(
      sandboxExecutionCommandSchema.parse({ type: "command_cancel", commandId: "cmd-1" })
    ).toEqual({ type: "command_cancel", commandId: "cmd-1" });
    expect(
      sandboxExecutionCommandSchema.parse({
        type: "command_replay",
        commandId: "cmd-1",
        afterSequence: 7,
      })
    ).toEqual({ type: "command_replay", commandId: "cmd-1", afterSequence: 7 });
  });

  it("validates sequenced output and terminal outcomes", () => {
    expect(
      sandboxExecutionEventSchema.parse({
        type: "command_output",
        commandId: "cmd-1",
        sequence: 2,
        stream: "stderr",
        data: "failed\n",
        sandboxId: "sandbox-1",
        timestamp: 1,
      })
    ).toMatchObject({ type: "command_output", sequence: 2, stream: "stderr" });
    expect(
      sandboxExecutionEventSchema.parse({
        type: "command_completed",
        commandId: "cmd-1",
        outcome: "failed",
        exitCode: 1,
        signal: null,
        lastSequence: 2,
        sandboxId: "sandbox-1",
        timestamp: 2,
        ackId: "command_completed:cmd-1",
      })
    ).toMatchObject({ type: "command_completed", outcome: "failed", exitCode: 1 });
  });

  it("represents replay gaps and output truncation explicitly", () => {
    expect(
      sandboxExecutionEventSchema.parse({
        type: "command_replay_gap",
        commandId: "cmd-1",
        requestedAfterSequence: 3,
        firstAvailableSequence: null,
        lastSequence: -1,
        reason: "unknown_command",
        sandboxId: "sandbox-1",
        timestamp: 1,
      })
    ).toMatchObject({ type: "command_replay_gap", reason: "unknown_command" });
    expect(
      sandboxExecutionEventSchema.parse({
        type: "command_completed",
        commandId: "cmd-1",
        outcome: "succeeded",
        exitCode: 0,
        signal: null,
        lastSequence: 2,
        outputTruncated: true,
        sandboxId: "sandbox-1",
        timestamp: 2,
      })
    ).toMatchObject({ outputTruncated: true });
  });
});
