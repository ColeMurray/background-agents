import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import {
  SandboxCommandConflictError,
  SandboxCommandQuotaError,
  SandboxCommandRepository,
} from "./sandbox-command-repository";

const execute = {
  type: "command_execute" as const,
  effect: "sandbox_execution" as const,
  commandId: "cmd-1",
  purpose: "test" as const,
  argv: ["npm", "test"],
  cwd: "/workspace/repo",
  timeoutMs: 30_000,
};

const authority = (commandId = "cmd-1") => ({
  fingerprint: `fingerprint-${commandId}`,
  actorKind: "user" as const,
  actorId: "user-1",
  approvalRevision: 1,
  credentialProfile: "execution-ws-v1",
  egressProfile: "package-install-v1",
  taskId: 7,
  toolCallId: `call-${commandId}`,
});

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

    expect(commands.admit(execute, "pi-operation-1", authority(), 100)).toMatchObject({
      kind: "created",
      command: {
        id: "cmd-1",
        state: "queued",
        operationId: "pi-operation-1",
        authority: authority(),
      },
    });
    expect(commands.admit(execute, "pi-operation-1", authority(), 200)).toMatchObject({
      kind: "duplicate",
      command: { id: "cmd-1", createdAt: 100 },
    });
    expect(() =>
      commands.admit(
        { ...execute, argv: ["npm", "run", "build"] },
        "pi-operation-1",
        authority(),
        300
      )
    ).toThrow(SandboxCommandConflictError);
    expect(() =>
      commands.admit(
        execute,
        "pi-operation-1",
        { ...authority(), fingerprint: "different-review" },
        400
      )
    ).toThrow(SandboxCommandConflictError);
  });

  it("records monotonic output exactly once and settles terminal state", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", authority(), 100);

    expect(commands.markDispatchAttempt("cmd-1", "sandbox-1", "bridge-1", 110, 30_110)).toBe(true);
    expect(commands.recordAccepted("cmd-1", 115)).toBe(true);
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
      acceptedAt: 115,
    });
  });

  it("turns cancellation into a durable recovery command", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", authority(), 100);
    commands.markDispatchAttempt("cmd-1", "sandbox-1", "bridge-1", 110, 30_110);
    commands.recordStarted("cmd-1", 120);

    expect(commands.requestCancellation("cmd-1", 130)).toBe("cancelling");
    expect(commands.recoveryCommands("sandbox-1", "bridge-1", 140)).toEqual([
      { type: "command_cancel", commandId: "cmd-1" },
    ]);
  });

  it("replays queued commands and running commands from the last persisted sequence", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", authority(), 100);
    commands.admit({ ...execute, commandId: "cmd-2" }, "pi-operation-2", authority("cmd-2"), 101);
    commands.markDispatchAttempt("cmd-2", "sandbox-1", "bridge-1", 110, 30_110);
    commands.recordStarted("cmd-2", 120);

    expect(commands.recoveryCommands("sandbox-1", "bridge-1", 130)).toEqual([
      execute,
      { type: "command_replay", commandId: "cmd-2", afterSequence: -1 },
    ]);
  });

  it("replays an ambiguously sent command on the same bridge identity", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", authority(), 100);
    commands.markDispatchAttempt("cmd-1", "sandbox-1", "bridge-1", 110, 30_110);

    expect(commands.recoveryCommands("sandbox-1", "bridge-1", 120)).toEqual([execute]);
  });

  it("marks commands from a replaced sandbox generation indeterminate", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", authority(), 100);
    commands.markDispatchAttempt("cmd-1", "sandbox-old", "bridge-old", 110, 30_110);
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
    commands.admit(execute, "pi-operation-1", authority(), 100);
    commands.markDispatchAttempt("cmd-1", "sandbox-1", "bridge-old", 110, 30_110);
    commands.recordStarted("cmd-1", 120);

    expect(commands.recoveryCommands("sandbox-1", "bridge-new", 130)).toEqual([]);
    expect(commands.get("cmd-1")?.state).toBe("indeterminate");
  });

  it("claims expired commands from the shared session alarm deadline", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", authority(), 100);
    commands.markDispatchAttempt("cmd-1", "sandbox-1", "bridge-1", 110, 500);

    expect(commands.getNextDeadline()).toBe(500);
    expect(commands.claimExpired(499)).toEqual([]);
    expect(commands.claimExpired(500)).toEqual(["cmd-1"]);
    expect(commands.get("cmd-1")).toMatchObject({
      state: "cancelling",
      error: "Command deadline exceeded",
    });
    expect(commands.getNextDeadline()).toBe(2_110);
  });

  it("bounds dispatch retries and exposes an unacknowledged start for escalation", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", authority(), 100);
    for (const now of [110, 2_110, 4_110]) {
      expect(commands.markDispatchAttempt("cmd-1", "sandbox-1", "bridge-1", now, 900_100)).toBe(
        true
      );
    }
    expect(commands.markDispatchAttempt("cmd-1", "sandbox-1", "bridge-1", 6_110, 900_100)).toBe(
      false
    );
    expect(commands.claimDispatchExhaustions(6_109)).toEqual([]);
    expect(commands.claimDispatchExhaustions(6_110)).toEqual(["cmd-1"]);
  });

  it("retries cancellation until grace expiry", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", authority(), 100);
    commands.markDispatchAttempt("cmd-1", "sandbox-1", "bridge-1", 110, 900_100);
    commands.recordStarted("cmd-1", 120);
    commands.requestCancellation("cmd-1", 130);
    expect(commands.claimDueCancellationRetries(2_109)).toEqual([]);
    expect(commands.claimDueCancellationRetries(2_110)).toEqual(["cmd-1"]);
    commands.recordCancelAttempt("cmd-1", 2_110);
    expect(commands.claimCancellationEscalations(10_129)).toEqual([]);
    expect(commands.claimCancellationEscalations(10_130)).toEqual(["cmd-1"]);
  });

  it("keeps replay gaps indeterminate and acknowledges late completion idempotently", () => {
    const commands = repository();
    commands.admit(execute, "pi-operation-1", authority(), 100);
    commands.markDispatchAttempt("cmd-1", "sandbox-1", "bridge-1", 110, 900_100);
    commands.recordStarted("cmd-1", 120);
    expect(commands.recordReplayGap("cmd-1", "history unavailable", 130)).toBe(true);
    expect(
      commands.complete(
        {
          type: "command_completed",
          commandId: "cmd-1",
          outcome: "succeeded",
          exitCode: 0,
          signal: null,
          lastSequence: -1,
          sandboxId: "sandbox-1",
          timestamp: 1,
        },
        140
      )
    ).toBe(false);
    expect(commands.get("cmd-1")).toMatchObject({
      state: "indeterminate",
      replayGap: true,
      lateCompletionAt: 140,
    });
  });

  it("enforces session queue and operation command quotas", () => {
    const commands = repository();
    for (let index = 1; index <= 4; index += 1) {
      const id = `cmd-${index}`;
      commands.admit({ ...execute, commandId: id }, `operation-${index}`, authority(id), index);
    }
    expect(() =>
      commands.admit({ ...execute, commandId: "cmd-5" }, "operation-5", authority("cmd-5"), 5)
    ).toThrow(SandboxCommandQuotaError);

    const operationCommands = repository();
    for (let index = 1; index <= 8; index += 1) {
      const id = `cmd-${index}`;
      operationCommands.admit({ ...execute, commandId: id }, "one-operation", authority(id), index);
      operationCommands.requestCancellation(id, index + 100);
    }
    expect(() =>
      operationCommands.admit(
        { ...execute, commandId: "cmd-9" },
        "one-operation",
        authority("cmd-9"),
        9
      )
    ).toThrow(SandboxCommandQuotaError);
  });

  it("allows only one dispatched command per session", () => {
    const commands = repository();
    commands.admit(execute, "operation-1", authority(), 100);
    commands.admit({ ...execute, commandId: "cmd-2" }, "operation-2", authority("cmd-2"), 101);
    expect(commands.markDispatchAttempt("cmd-1", "sandbox-1", "bridge-1", 110, 900_100)).toBe(true);
    expect(commands.markDispatchAttempt("cmd-2", "sandbox-1", "bridge-1", 111, 900_101)).toBe(
      false
    );
  });

  it("bounds persisted output and completion errors", () => {
    const commands = repository();
    commands.admit(execute, "operation-1", authority(), 100);
    commands.markDispatchAttempt("cmd-1", "sandbox-1", "bridge-1", 110, 900_100);
    commands.recordStarted("cmd-1", 120);
    const chunk = "x".repeat(64 * 1024);
    for (let sequence = 0; sequence < 4; sequence += 1) {
      expect(
        commands.recordOutput(
          {
            type: "command_output",
            commandId: "cmd-1",
            sequence,
            stream: "stdout",
            data: chunk,
            sandboxId: "sandbox-1",
            timestamp: 1,
          },
          130 + sequence
        )
      ).toBe("recorded");
    }
    expect(
      commands.recordOutput(
        {
          type: "command_output",
          commandId: "cmd-1",
          sequence: 4,
          stream: "stdout",
          data: "overflow",
          sandboxId: "sandbox-1",
          timestamp: 1,
        },
        140
      )
    ).toBe("truncated");
    commands.complete(
      {
        type: "command_completed",
        commandId: "cmd-1",
        outcome: "failed",
        exitCode: 1,
        signal: null,
        lastSequence: 4,
        error: "e".repeat(4096),
        sandboxId: "sandbox-1",
        timestamp: 1,
      },
      150
    );
    expect(commands.get("cmd-1")).toMatchObject({
      outputBytes: 256 * 1024,
      outputTruncated: true,
    });
    expect(commands.outputPage("cmd-1", -1, 64 * 1024).chunks).toHaveLength(1);
  });

  it("prunes only terminal metadata after bounded retention", () => {
    const commands = repository();
    commands.admit(execute, "operation-1", authority(), 100);
    commands.requestCancellation("cmd-1", 101);
    commands.admit(
      { ...execute, commandId: "cmd-active" },
      "operation-active",
      authority("cmd-active"),
      102
    );

    commands.prune(8 * 24 * 60 * 60 * 1_000);

    expect(commands.get("cmd-1")).toBeNull();
    expect(commands.get("cmd-active")?.state).toBe("queued");
  });
});
