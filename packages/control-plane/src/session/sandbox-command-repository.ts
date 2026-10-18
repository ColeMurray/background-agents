import {
  sandboxExecutionCommandSchema,
  type SandboxExecutionCommand,
  type SandboxExecutionEvent,
} from "@open-inspect/shared";
import { z } from "zod";
import type { SqlStorage, TransactionSync } from "./sql-storage";

const MAX_PERSISTED_OUTPUT_BYTES = 1024 * 1024;

const commandStateSchema = z.enum([
  "queued",
  "dispatched",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "indeterminate",
]);
export type SandboxCommandState = z.infer<typeof commandStateSchema>;

const commandRowSchema = z.object({
  id: z.string(),
  operation_id: z.string(),
  request_json: z.string(),
  state: commandStateSchema,
  sandbox_id: z.string().nullable(),
  bridge_instance_id: z.string().nullable(),
  last_output_sequence: z.number(),
  output_bytes: z.number(),
  output_truncated: z.number(),
  exit_code: z.number().nullable(),
  signal: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.number(),
  dispatched_at: z.number().nullable(),
  deadline_at: z.number().nullable(),
  started_at: z.number().nullable(),
  completed_at: z.number().nullable(),
});

const outputRowSchema = z.object({
  sequence: z.number(),
  stream: z.enum(["stdout", "stderr"]),
  data: z.string(),
  created_at: z.number(),
});

type ExecuteCommand = Extract<SandboxExecutionCommand, { type: "command_execute" }>;
type OutputEvent = Extract<SandboxExecutionEvent, { type: "command_output" }>;
type CompletionEvent = Extract<SandboxExecutionEvent, { type: "command_completed" }>;

export interface SandboxCommandRecord {
  id: string;
  operationId: string;
  request: ExecuteCommand;
  state: SandboxCommandState;
  sandboxId: string | null;
  bridgeInstanceId: string | null;
  lastOutputSequence: number;
  outputBytes: number;
  outputTruncated: boolean;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  createdAt: number;
  dispatchedAt: number | null;
  deadlineAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  output: Array<{ sequence: number; stream: "stdout" | "stderr"; data: string; createdAt: number }>;
}

export class SandboxCommandConflictError extends Error {
  constructor(commandId: string) {
    super(`Sandbox command ${commandId} was already admitted with different input`);
    this.name = "SandboxCommandConflictError";
  }
}

export class SandboxCommandIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxCommandIntegrityError";
  }
}

function requestJson(command: ExecuteCommand): string {
  return JSON.stringify(command);
}

function terminalState(outcome: CompletionEvent["outcome"]): SandboxCommandState {
  return outcome === "succeeded" ? "succeeded" : outcome;
}

function isTerminal(state: SandboxCommandState): boolean {
  return ["succeeded", "failed", "cancelled", "timed_out", "indeterminate"].includes(state);
}

/** Durable command state owned by SessionDO, separate from the user timeline. */
export class SandboxCommandRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: TransactionSync
  ) {}

  admit(
    command: ExecuteCommand,
    operationId: string,
    now: number
  ): { kind: "created" | "duplicate"; command: SandboxCommandRecord } {
    const validated = sandboxExecutionCommandSchema.parse(command);
    if (validated.type !== "command_execute") {
      throw new TypeError("Only command_execute can be admitted");
    }
    const encoded = requestJson(validated);
    return this.transaction(() => {
      const existing = this.get(validated.commandId);
      if (existing) {
        if (existing.operationId !== operationId || requestJson(existing.request) !== encoded) {
          throw new SandboxCommandConflictError(validated.commandId);
        }
        return { kind: "duplicate", command: existing };
      }
      this.sql.exec(
        `INSERT INTO sandbox_commands
          (id, operation_id, request_json, state, created_at)
         VALUES (?, ?, ?, 'queued', ?)`,
        validated.commandId,
        operationId,
        encoded,
        now
      );
      return { kind: "created", command: this.require(validated.commandId) };
    });
  }

  get(commandId: string): SandboxCommandRecord | null {
    const raw = this.sql
      .exec(`SELECT * FROM sandbox_commands WHERE id = ?`, commandId)
      .toArray()[0];
    if (raw === undefined) return null;
    const row = commandRowSchema.safeParse(raw);
    if (!row.success) throw new SandboxCommandIntegrityError("Malformed sandbox command row");
    const parsedRequest = sandboxExecutionCommandSchema.safeParse(
      JSON.parse(row.data.request_json)
    );
    if (!parsedRequest.success || parsedRequest.data.type !== "command_execute") {
      throw new SandboxCommandIntegrityError("Malformed persisted sandbox command request");
    }
    const output = this.sql
      .exec(
        `SELECT sequence, stream, data, created_at
         FROM sandbox_command_output WHERE command_id = ? ORDER BY sequence`,
        commandId
      )
      .toArray()
      .map((value) => {
        const parsed = outputRowSchema.safeParse(value);
        if (!parsed.success) throw new SandboxCommandIntegrityError("Malformed command output row");
        return {
          sequence: parsed.data.sequence,
          stream: parsed.data.stream,
          data: parsed.data.data,
          createdAt: parsed.data.created_at,
        };
      });
    return {
      id: row.data.id,
      operationId: row.data.operation_id,
      request: parsedRequest.data,
      state: row.data.state,
      sandboxId: row.data.sandbox_id,
      bridgeInstanceId: row.data.bridge_instance_id,
      lastOutputSequence: row.data.last_output_sequence,
      outputBytes: row.data.output_bytes,
      outputTruncated: row.data.output_truncated === 1,
      exitCode: row.data.exit_code,
      signal: row.data.signal,
      error: row.data.error,
      createdAt: row.data.created_at,
      dispatchedAt: row.data.dispatched_at,
      deadlineAt: row.data.deadline_at,
      startedAt: row.data.started_at,
      completedAt: row.data.completed_at,
      output,
    };
  }

  markDispatched(
    commandId: string,
    sandboxId: string,
    bridgeInstanceId: string,
    now: number,
    deadlineAt: number
  ): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox_commands SET state = 'dispatched', sandbox_id = ?, bridge_instance_id = ?,
         dispatched_at = COALESCE(dispatched_at, ?), deadline_at = COALESCE(deadline_at, ?)
       WHERE id = ? AND state = 'queued'`,
      sandboxId,
      bridgeInstanceId,
      now,
      deadlineAt,
      commandId
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  recordStarted(commandId: string, now: number): boolean {
    return this.transition(commandId, ["queued", "dispatched"], "running", "started_at", now);
  }

  recordOutput(event: OutputEvent, now: number): "recorded" | "duplicate" | "truncated" {
    return this.transaction(() => {
      const command = this.require(event.commandId);
      if (isTerminal(command.state)) return "duplicate";
      if (!["dispatched", "running", "cancelling"].includes(command.state)) {
        throw new SandboxCommandIntegrityError(
          `Cannot record output while command is ${command.state}`
        );
      }
      const expected = command.lastOutputSequence + 1;
      if (event.sequence < expected) {
        const existing = command.output.find((chunk) => chunk.sequence === event.sequence);
        if (existing?.stream === event.stream && existing.data === event.data) return "duplicate";
        throw new SandboxCommandIntegrityError("Conflicting replayed command output");
      }
      if (event.sequence !== expected) {
        throw new SandboxCommandIntegrityError(
          `Command output sequence ${event.sequence} does not follow ${command.lastOutputSequence}`
        );
      }
      const bytes = new TextEncoder().encode(event.data).byteLength;
      if (command.outputBytes + bytes > MAX_PERSISTED_OUTPUT_BYTES) {
        this.sql.exec(
          `UPDATE sandbox_commands SET output_truncated = 1, last_output_sequence = ? WHERE id = ?`,
          event.sequence,
          event.commandId
        );
        return "truncated";
      }
      this.sql.exec(
        `INSERT INTO sandbox_command_output (command_id, sequence, stream, data, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        event.commandId,
        event.sequence,
        event.stream,
        event.data,
        now
      );
      this.sql.exec(
        `UPDATE sandbox_commands
         SET state = CASE WHEN state = 'dispatched' THEN 'running' ELSE state END,
             last_output_sequence = ?, output_bytes = output_bytes + ?
         WHERE id = ?`,
        event.sequence,
        bytes,
        event.commandId
      );
      return "recorded";
    });
  }

  requestCancellation(commandId: string, now: number): SandboxCommandState {
    return this.transaction(() => {
      const command = this.require(commandId);
      if (isTerminal(command.state) || command.state === "cancelling") return command.state;
      const next = command.state === "queued" ? "cancelled" : "cancelling";
      this.sql.exec(
        `UPDATE sandbox_commands SET state = ?, completed_at = ? WHERE id = ?`,
        next,
        next === "cancelled" ? now : null,
        commandId
      );
      return next;
    });
  }

  complete(event: CompletionEvent, now: number): boolean {
    return this.transaction(() => {
      const command = this.require(event.commandId);
      const state = terminalState(event.outcome);
      if (isTerminal(command.state)) {
        if (
          command.state === state &&
          command.exitCode === event.exitCode &&
          command.signal === event.signal
        ) {
          return false;
        }
        throw new SandboxCommandIntegrityError("Conflicting terminal command result");
      }
      if (event.lastSequence !== command.lastOutputSequence) {
        throw new SandboxCommandIntegrityError(
          "Command completion does not match persisted output"
        );
      }
      this.sql.exec(
        `UPDATE sandbox_commands
         SET state = ?, exit_code = ?, signal = ?, error = ?, completed_at = ?
             , output_truncated = CASE WHEN ? = 1 THEN 1 ELSE output_truncated END
         WHERE id = ?`,
        state,
        event.exitCode,
        event.signal,
        event.error ?? null,
        now,
        event.outputTruncated ? 1 : 0,
        event.commandId
      );
      return true;
    });
  }

  markIndeterminate(commandId: string, error: string, now: number): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox_commands SET state = 'indeterminate', error = ?, completed_at = ?
       WHERE id = ? AND state IN ('dispatched', 'running', 'cancelling')`,
      error,
      now,
      commandId
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  claimExpired(now: number): string[] {
    return this.transaction(() => {
      const ids = this.sql
        .exec(
          `SELECT id FROM sandbox_commands
           WHERE state IN ('dispatched', 'running') AND deadline_at IS NOT NULL AND deadline_at <= ?
           ORDER BY deadline_at, id`,
          now
        )
        .toArray()
        .map((raw) => z.object({ id: z.string() }).parse(raw).id);
      for (const id of ids) {
        this.sql.exec(
          `UPDATE sandbox_commands SET state = 'cancelling', error = 'Command deadline exceeded'
           WHERE id = ? AND state IN ('dispatched', 'running')`,
          id
        );
      }
      return ids;
    });
  }

  getNextDeadline(): number | null {
    const row = z.object({ deadline: z.number().nullable() }).parse(
      this.sql
        .exec(
          `SELECT MIN(deadline_at) AS deadline FROM sandbox_commands
             WHERE state IN ('dispatched', 'running')`
        )
        .one()
    );
    return row.deadline;
  }

  recoveryCommands(
    sandboxId: string,
    bridgeInstanceId: string,
    now: number
  ): SandboxExecutionCommand[] {
    return this.transaction(() => {
      const commands = this.sql
        .exec(
          `SELECT id FROM sandbox_commands
           WHERE state IN ('queued', 'dispatched', 'running', 'cancelling')
           ORDER BY created_at, id`
        )
        .toArray()
        .map((raw) => z.object({ id: z.string() }).parse(raw).id)
        .map((id) => this.require(id));
      const recoverable: SandboxExecutionCommand[] = [];
      for (const command of commands) {
        if (command.state === "queued") {
          recoverable.push(command.request);
          continue;
        }
        if (command.sandboxId !== sandboxId || command.bridgeInstanceId !== bridgeInstanceId) {
          this.sql.exec(
            `UPDATE sandbox_commands
             SET state = 'indeterminate',
                 error = 'Sandbox generation was replaced before command completion',
                 completed_at = ?
             WHERE id = ? AND state IN ('dispatched', 'running', 'cancelling')`,
            now,
            command.id
          );
          continue;
        }
        if (command.state === "cancelling") {
          recoverable.push({ type: "command_cancel", commandId: command.id });
          continue;
        }
        recoverable.push({
          type: "command_replay",
          commandId: command.id,
          afterSequence: command.lastOutputSequence,
        });
      }
      return recoverable;
    });
  }

  private require(commandId: string): SandboxCommandRecord {
    const command = this.get(commandId);
    if (!command) throw new SandboxCommandIntegrityError(`Unknown sandbox command ${commandId}`);
    return command;
  }

  private transition(
    commandId: string,
    from: SandboxCommandState[],
    to: SandboxCommandState,
    timestampColumn: "dispatched_at" | "started_at",
    now: number
  ): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const result = this.sql.exec(
      `UPDATE sandbox_commands SET state = ?, ${timestampColumn} = COALESCE(${timestampColumn}, ?)
       WHERE id = ? AND state IN (${placeholders})`,
      to,
      now,
      commandId,
      ...from
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }
}
