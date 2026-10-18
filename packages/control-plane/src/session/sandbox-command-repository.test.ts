import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import {
  SandboxCommandConflictError,
  SandboxCommandRepository,
} from "./sandbox-command-repository";

const execute = {
  type: "command_execute" as const,
  policyClass: "sandbox_execution" as const,
  commandId: "cmd-1",
  purpose: "test" as const,
  argv: ["npm", "test"],
  cwd: "/workspace/repo",
  timeoutMs: 30_000,
};

describe("SandboxCommandRepository", () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function repository() {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const { sql, transactionSync } = createNodeSqlStorage(db);
    initSchema(sql);
    return new SandboxCommandRepository(sql, transactionSync);
  }

  it("admits a command idempotently but rejects a changed payload", () => {
    const commands = repository();

    expect(commands.admit(execute, "pi-operation-1", 100)).toMatchObject({
      kind: "created",
      command: { id: "cmd-1", state: "queued", operationId: "pi-operation-1" },
    });
    expect(commands.admit(execute, "pi-operation-1", 200)).toMatchObject({
      kind: "duplicate",
      command: { id: "cmd-1", createdAt: 100 },
    });
    expect(() =>
      commands.admit({ ...execute, argv: ["npm", "run", "build"] }, "pi-operation-1", 300)
    ).toThrow(SandboxCommandConflictError);
  });

  it("records monotonic output exactly once and settles terminal state", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", 100);

    expect(commands.markDispatched("cmd-1", "sandbox-1", "bridge-1", 110, 30_110)).toBe(true);
    expect(commands.recordStarted("cmd-1", 120)).toBe(true);
    expect(
      commands.recordOutput(
        {
          type: "command_output",
          commandId: "cmd-1",
          sequence: 0,
          stream: "stdout",
          data: "ok\n",
          sandboxId: "sandbox-1",
          timestamp: 0.13,
        },
        130
      )
    ).toBe("recorded");
    expect(
      commands.recordOutput(
        {
          type: "command_output",
          commandId: "cmd-1",
          sequence: 0,
          stream: "stdout",
          data: "ok\n",
          sandboxId: "sandbox-1",
          timestamp: 0.13,
        },
        131
      )
    ).toBe("duplicate");
    expect(() =>
      commands.recordOutput(
        {
          type: "command_output",
          commandId: "cmd-1",
          sequence: 2,
          stream: "stderr",
          data: "gap",
          sandboxId: "sandbox-1",
          timestamp: 0.14,
        },
        140
      )
    ).toThrow(/sequence/i);

    expect(
      commands.complete(
        {
          type: "command_completed",
          commandId: "cmd-1",
          outcome: "succeeded",
          exitCode: 0,
          signal: null,
          lastSequence: 0,
          sandboxId: "sandbox-1",
          timestamp: 0.15,
        },
        150
      )
    ).toBe(true);
    expect(commands.get("cmd-1")).toMatchObject({
      state: "succeeded",
      exitCode: 0,
      lastOutputSequence: 0,
      output: [{ sequence: 0, stream: "stdout", data: "ok\n" }],
    });
  });

  it("turns cancellation into a durable recovery command", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", 100);
    commands.markDispatched("cmd-1", "sandbox-1", "bridge-1", 110, 30_110);
    commands.recordStarted("cmd-1", 120);

    expect(commands.requestCancellation("cmd-1", 130)).toBe("cancelling");
    expect(commands.recoveryCommands("sandbox-1", "bridge-1", 140)).toEqual([
      { type: "command_cancel", commandId: "cmd-1" },
    ]);
  });

  it("replays queued commands and running commands from the last persisted sequence", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", 100);
    commands.admit({ ...execute, commandId: "cmd-2" }, "pi-operation-2", 101);
    commands.markDispatched("cmd-2", "sandbox-1", "bridge-1", 110, 30_110);
    commands.recordStarted("cmd-2", 120);

    expect(commands.recoveryCommands("sandbox-1", "bridge-1", 130)).toEqual([
      execute,
      { type: "command_replay", commandId: "cmd-2", afterSequence: -1 },
    ]);
  });

  it("marks commands from a replaced sandbox generation indeterminate", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", 100);
    commands.markDispatched("cmd-1", "sandbox-old", "bridge-old", 110, 30_110);
    commands.recordStarted("cmd-1", 120);

    expect(commands.recoveryCommands("sandbox-new", "bridge-new", 130)).toEqual([]);
    expect(commands.get("cmd-1")).toMatchObject({
      state: "indeterminate",
      error: "Sandbox generation was replaced before command completion",
      completedAt: 130,
    });
  });

  it("marks commands from a restarted bridge process indeterminate", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", 100);
    commands.markDispatched("cmd-1", "sandbox-1", "bridge-old", 110, 30_110);
    commands.recordStarted("cmd-1", 120);

    expect(commands.recoveryCommands("sandbox-1", "bridge-new", 130)).toEqual([]);
    expect(commands.get("cmd-1")?.state).toBe("indeterminate");
  });

  it("claims expired commands from the shared session alarm deadline", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", 100);
    commands.markDispatched("cmd-1", "sandbox-1", "bridge-1", 110, 500);

    expect(commands.getNextDeadline()).toBe(500);
    expect(commands.claimExpired(499)).toEqual([]);
    expect(commands.claimExpired(500)).toEqual(["cmd-1"]);
    expect(commands.get("cmd-1")).toMatchObject({
      state: "cancelling",
      error: "Command deadline exceeded",
    });
    expect(commands.getNextDeadline()).toBeNull();
  });
});
