import {
  MAX_PERSISTED_SANDBOX_COMMAND_OUTPUT_BYTES,
  MAX_PERSISTED_SANDBOX_OPERATION_OUTPUT_BYTES,
  MAX_QUEUED_SANDBOX_COMMANDS_PER_SESSION,
  MAX_SANDBOX_COMMANDS_PER_OPERATION,
  sandboxExecutionCommandSchema,
  type SandboxExecutionCommand,
  type SandboxExecutionEvent,
} from "@open-inspect/shared";
import { z } from "zod";
import type { SqlStorage, TransactionSync } from "./sql-storage";

export const SANDBOX_COMMAND_DISPATCH_RETRY_MS = 2_000;
export const SANDBOX_COMMAND_CANCEL_RETRY_MS = 2_000;
export const SANDBOX_COMMAND_CANCEL_GRACE_MS = 10_000;
export const SANDBOX_COMMAND_MAX_DISPATCH_ATTEMPTS = 3;
export const SANDBOX_COMMAND_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const SANDBOX_COMMAND_MAX_RETAINED = 256;
const MAX_COMPLETION_ERROR_BYTES = 4_096;

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
  request_fingerprint: z.string().nullable(),
  actor_kind: z.string().nullable(),
  actor_id: z.string().nullable(),
  approval_revision: z.number().nullable(),
  credential_profile: z.string().nullable(),
  egress_profile: z.string().nullable(),
  task_id: z.number().nullable(),
  tool_call_id: z.string().nullable(),
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
  dispatch_attempts: z.number(),
  last_dispatch_at: z.number().nullable(),
  accepted_at: z.number().nullable(),
  deadline_at: z.number().nullable(),
  started_at: z.number().nullable(),
  cancel_requested_at: z.number().nullable(),
  cancel_deadline_at: z.number().nullable(),
  cancel_attempts: z.number(),
  replay_gap: z.number(),
  late_completion_at: z.number().nullable(),
  metadata_expires_at: z.number().nullable(),
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

export interface SandboxCommandAuthority {
  fingerprint: string;
  actorKind: "user" | "service";
  actorId: string;
  approvalRevision: number;
  credentialProfile: string;
  egressProfile: string;
  taskId: number;
  toolCallId: string;
}

export interface SandboxCommandRecord {
  id: string;
  operationId: string;
  request: ExecuteCommand;
  authority: SandboxCommandAuthority | null;
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
  dispatchAttempts: number;
  lastDispatchAt: number | null;
  acceptedAt: number | null;
  deadlineAt: number | null;
  startedAt: number | null;
  cancelRequestedAt: number | null;
  cancelDeadlineAt: number | null;
  cancelAttempts: number;
  replayGap: boolean;
  lateCompletionAt: number | null;
  metadataExpiresAt: number | null;
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

export class SandboxCommandQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxCommandQuotaError";
  }
}

function requestJson(command: ExecuteCommand): string {
  return JSON.stringify(command);
}

function readCount(result: ReturnType<SqlStorage["exec"]>): number {
  return readNumber(result, "count");
}

function readNumber(result: ReturnType<SqlStorage["exec"]>, column: string): number {
  const row = z.record(z.string(), z.unknown()).safeParse(result.one());
  const value = row.success ? row.data[column] : undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SandboxCommandIntegrityError(`Malformed sandbox command ${column}`);
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
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
    authority: SandboxCommandAuthority,
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
        if (
          existing.operationId !== operationId ||
          requestJson(existing.request) !== encoded ||
          existing.authority?.fingerprint !== authority.fingerprint
        ) {
          throw new SandboxCommandConflictError(validated.commandId);
        }
        return { kind: "duplicate", command: existing };
      }
      const operationCount = readCount(
        this.sql.exec(
          "SELECT COUNT(*) AS count FROM sandbox_commands WHERE operation_id = ?",
          operationId
        )
      );
      if (operationCount >= MAX_SANDBOX_COMMANDS_PER_OPERATION) {
        throw new SandboxCommandQuotaError("Pi operation command quota exceeded");
      }
      const queuedCount = readCount(
        this.sql.exec("SELECT COUNT(*) AS count FROM sandbox_commands WHERE state = 'queued'")
      );
      if (queuedCount >= MAX_QUEUED_SANDBOX_COMMANDS_PER_SESSION) {
        throw new SandboxCommandQuotaError("Session queued command quota exceeded");
      }
      this.sql.exec(
        `INSERT INTO sandbox_commands
          (id, operation_id, request_json, request_fingerprint, actor_kind, actor_id,
           approval_revision, credential_profile, egress_profile, task_id, tool_call_id,
           state, created_at, metadata_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        validated.commandId,
        operationId,
        encoded,
        authority.fingerprint,
        authority.actorKind,
        authority.actorId,
        authority.approvalRevision,
        authority.credentialProfile,
        authority.egressProfile,
        authority.taskId,
        authority.toolCallId,
        now,
        now + SANDBOX_COMMAND_RETENTION_MS
      );
      this.prune(now);
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
      authority:
        row.data.request_fingerprint &&
        row.data.actor_kind &&
        (row.data.actor_kind === "user" || row.data.actor_kind === "service") &&
        row.data.actor_id &&
        row.data.approval_revision !== null &&
        row.data.credential_profile &&
        row.data.egress_profile &&
        row.data.task_id !== null &&
        row.data.tool_call_id
          ? {
              fingerprint: row.data.request_fingerprint,
              actorKind: row.data.actor_kind,
              actorId: row.data.actor_id,
              approvalRevision: row.data.approval_revision,
              credentialProfile: row.data.credential_profile,
              egressProfile: row.data.egress_profile,
              taskId: row.data.task_id,
              toolCallId: row.data.tool_call_id,
            }
          : null,
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
      dispatchAttempts: row.data.dispatch_attempts,
      lastDispatchAt: row.data.last_dispatch_at,
      acceptedAt: row.data.accepted_at,
      deadlineAt: row.data.deadline_at,
      startedAt: row.data.started_at,
      cancelRequestedAt: row.data.cancel_requested_at,
      cancelDeadlineAt: row.data.cancel_deadline_at,
      cancelAttempts: row.data.cancel_attempts,
      replayGap: row.data.replay_gap === 1,
      lateCompletionAt: row.data.late_completion_at,
      metadataExpiresAt: row.data.metadata_expires_at,
      completedAt: row.data.completed_at,
      output,
    };
  }

  markDispatchAttempt(
    commandId: string,
    sandboxId: string,
    bridgeInstanceId: string,
    now: number,
    deadlineAt: number
  ): boolean {
    return this.transaction(() => {
      const command = this.require(commandId);
      if (!["queued", "dispatched"].includes(command.state) || command.startedAt !== null)
        return false;
      if (command.dispatchAttempts >= SANDBOX_COMMAND_MAX_DISPATCH_ATTEMPTS) return false;
      const activeOther = readCount(
        this.sql.exec(
          `SELECT COUNT(*) AS count FROM sandbox_commands
           WHERE id <> ? AND state IN ('dispatched','running','cancelling')`,
          commandId
        )
      );
      if (activeOther > 0) return false;
      const result = this.sql.exec(
        `UPDATE sandbox_commands SET state = 'dispatched', sandbox_id = ?, bridge_instance_id = ?,
           dispatched_at = COALESCE(dispatched_at, ?), last_dispatch_at = ?,
           dispatch_attempts = dispatch_attempts + 1, deadline_at = COALESCE(deadline_at, ?)
         WHERE id = ? AND state IN ('queued','dispatched') AND started_at IS NULL`,
        sandboxId,
        bridgeInstanceId,
        now,
        now,
        deadlineAt,
        commandId
      );
      result.toArray();
      return (result.rowsWritten ?? 0) > 0;
    });
  }

  recordAccepted(commandId: string, now: number): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox_commands SET accepted_at = COALESCE(accepted_at, ?)
       WHERE id = ? AND state = 'dispatched'`,
      now,
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
      const operationBytes = readNumber(
        this.sql.exec(
          "SELECT COALESCE(SUM(output_bytes), 0) AS value FROM sandbox_commands WHERE operation_id = ?",
          command.operationId
        ),
        "value"
      );
      if (
        command.outputBytes + bytes > MAX_PERSISTED_SANDBOX_COMMAND_OUTPUT_BYTES ||
        operationBytes + bytes > MAX_PERSISTED_SANDBOX_OPERATION_OUTPUT_BYTES
      ) {
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
        `UPDATE sandbox_commands
         SET state = ?, completed_at = ?, cancel_requested_at = COALESCE(cancel_requested_at, ?),
             cancel_deadline_at = CASE WHEN ? = 'cancelling' THEN COALESCE(cancel_deadline_at, ?) ELSE cancel_deadline_at END
         WHERE id = ?`,
        next,
        next === "cancelled" ? now : null,
        now,
        next,
        now + SANDBOX_COMMAND_CANCEL_GRACE_MS,
        commandId
      );
      return next;
    });
  }

  recordCancelAttempt(commandId: string, now: number): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox_commands
       SET cancel_attempts = cancel_attempts + 1, last_dispatch_at = ?
       WHERE id = ? AND state = 'cancelling'`,
      now,
      commandId
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  complete(event: CompletionEvent, now: number): boolean {
    return this.transaction(() => {
      const command = this.require(event.commandId);
      const state = terminalState(event.outcome);
      if (isTerminal(command.state)) {
        this.sql.exec(
          "UPDATE sandbox_commands SET late_completion_at = COALESCE(late_completion_at, ?) WHERE id = ?",
          now,
          event.commandId
        );
        return false;
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
        event.error ? truncateUtf8(event.error, MAX_COMPLETION_ERROR_BYTES) : null,
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
      truncateUtf8(error, MAX_COMPLETION_ERROR_BYTES),
      now,
      commandId
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  recordReplayGap(commandId: string, error: string, now: number): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox_commands
       SET state = 'indeterminate', error = ?, replay_gap = 1, completed_at = ?
       WHERE id = ? AND state IN ('dispatched', 'running', 'cancelling')`,
      truncateUtf8(error, MAX_COMPLETION_ERROR_BYTES),
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
          `UPDATE sandbox_commands
           SET state = 'cancelling', error = 'Command deadline exceeded',
               cancel_requested_at = COALESCE(cancel_requested_at, ?),
               cancel_deadline_at = COALESCE(cancel_deadline_at, ?)
            WHERE id = ? AND state IN ('dispatched', 'running')`,
          now,
          now + SANDBOX_COMMAND_CANCEL_GRACE_MS,
          id
        );
      }
      return ids;
    });
  }

  claimDueDispatchRetries(now: number): ExecuteCommand[] {
    return this.sql
      .exec(
        `SELECT id FROM sandbox_commands
         WHERE state = 'dispatched' AND started_at IS NULL
           AND dispatch_attempts < ? AND last_dispatch_at <= ?
         ORDER BY last_dispatch_at, id`,
        SANDBOX_COMMAND_MAX_DISPATCH_ATTEMPTS,
        now - SANDBOX_COMMAND_DISPATCH_RETRY_MS
      )
      .toArray()
      .map((row) => this.require(z.object({ id: z.string() }).parse(row).id).request);
  }

  claimDispatchExhaustions(now: number): string[] {
    return this.sql
      .exec(
        `SELECT id FROM sandbox_commands
         WHERE state = 'dispatched' AND started_at IS NULL
           AND dispatch_attempts >= ? AND last_dispatch_at <= ?
         ORDER BY last_dispatch_at, id`,
        SANDBOX_COMMAND_MAX_DISPATCH_ATTEMPTS,
        now - SANDBOX_COMMAND_DISPATCH_RETRY_MS
      )
      .toArray()
      .map((row) => z.object({ id: z.string() }).parse(row).id);
  }

  claimDueCancellationRetries(now: number): string[] {
    return this.sql
      .exec(
        `SELECT id FROM sandbox_commands
         WHERE state = 'cancelling' AND cancel_deadline_at > ?
           AND (last_dispatch_at IS NULL OR last_dispatch_at <= ?)
         ORDER BY cancel_requested_at, id`,
        now,
        now - SANDBOX_COMMAND_CANCEL_RETRY_MS
      )
      .toArray()
      .map((row) => z.object({ id: z.string() }).parse(row).id);
  }

  claimCancellationEscalations(now: number): string[] {
    return this.sql
      .exec(
        `SELECT id FROM sandbox_commands
         WHERE state = 'cancelling' AND cancel_deadline_at IS NOT NULL AND cancel_deadline_at <= ?
         ORDER BY cancel_deadline_at, id`,
        now
      )
      .toArray()
      .map((row) => z.object({ id: z.string() }).parse(row).id);
  }

  getNextDeadline(): number | null {
    const row = z.object({ deadline: z.number().nullable() }).parse(
      this.sql
        .exec(
          `SELECT MIN(value) AS deadline FROM (
             SELECT deadline_at AS value FROM sandbox_commands
               WHERE state IN ('dispatched','running') AND deadline_at IS NOT NULL
             UNION ALL
             SELECT last_dispatch_at + ? AS value FROM sandbox_commands
               WHERE state = 'dispatched' AND started_at IS NULL
             UNION ALL
             SELECT MIN(cancel_deadline_at, COALESCE(last_dispatch_at, cancel_requested_at) + ?) AS value
               FROM sandbox_commands WHERE state = 'cancelling'
           )`,
          SANDBOX_COMMAND_DISPATCH_RETRY_MS,
          SANDBOX_COMMAND_CANCEL_RETRY_MS
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
        if (command.state === "dispatched" && command.startedAt === null) {
          recoverable.push(command.request);
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

  requestOperationCancellation(operationId: string, now: number): string[] {
    const ids = this.sql
      .exec(
        `SELECT id FROM sandbox_commands
         WHERE operation_id = ? AND state IN ('queued','dispatched','running','cancelling')
         ORDER BY created_at, id`,
        operationId
      )
      .toArray()
      .map((row) => z.object({ id: z.string() }).parse(row).id);
    for (const id of ids) this.requestCancellation(id, now);
    return ids;
  }

  listOperation(operationId: string): SandboxCommandRecord[] {
    return this.sql
      .exec(
        "SELECT id FROM sandbox_commands WHERE operation_id = ? ORDER BY created_at, id",
        operationId
      )
      .toArray()
      .map((row) => this.require(z.object({ id: z.string() }).parse(row).id));
  }

  listRecent(limit = 50): SandboxCommandRecord[] {
    const bounded = Math.max(1, Math.min(limit, 100));
    return this.sql
      .exec("SELECT id FROM sandbox_commands ORDER BY created_at DESC, id DESC LIMIT ?", bounded)
      .toArray()
      .map((row) => this.require(z.object({ id: z.string() }).parse(row).id));
  }

  nextQueued(): SandboxCommandRecord | null {
    const row = this.sql
      .exec(
        "SELECT id FROM sandbox_commands WHERE state = 'queued' ORDER BY created_at, id LIMIT 1"
      )
      .toArray()[0];
    return row ? this.require(z.object({ id: z.string() }).parse(row).id) : null;
  }

  outputPage(
    commandId: string,
    afterSequence: number,
    limitBytes: number
  ): { chunks: SandboxCommandRecord["output"]; nextSequence: number | null } {
    this.require(commandId);
    const boundedBytes = Math.max(1, Math.min(limitBytes, 64 * 1024));
    const chunks: SandboxCommandRecord["output"] = [];
    let bytes = 0;
    const rows = this.sql
      .exec(
        `SELECT sequence, stream, data, created_at FROM sandbox_command_output
         WHERE command_id = ? AND sequence > ? ORDER BY sequence LIMIT 256`,
        commandId,
        afterSequence
      )
      .toArray();
    for (const raw of rows) {
      const row = outputRowSchema.parse(raw);
      const size = new TextEncoder().encode(row.data).byteLength;
      if (chunks.length > 0 && bytes + size > boundedBytes) break;
      chunks.push({
        sequence: row.sequence,
        stream: row.stream,
        data: row.data,
        createdAt: row.created_at,
      });
      bytes += size;
    }
    const last = chunks.at(-1)?.sequence ?? afterSequence;
    const more =
      this.sql
        .exec(
          "SELECT sequence FROM sandbox_command_output WHERE command_id = ? AND sequence > ? ORDER BY sequence LIMIT 1",
          commandId,
          last
        )
        .toArray().length > 0;
    return { chunks, nextSequence: more ? last : null };
  }

  prune(now: number): void {
    this.sql.exec(
      `DELETE FROM sandbox_commands
       WHERE metadata_expires_at IS NOT NULL AND metadata_expires_at <= ?
         AND state IN ('succeeded','failed','cancelled','timed_out','indeterminate')`,
      now
    );
    this.sql.exec(
      `DELETE FROM sandbox_commands WHERE id IN (
         SELECT id FROM sandbox_commands
         WHERE state IN ('succeeded','failed','cancelled','timed_out','indeterminate')
         ORDER BY completed_at DESC, id DESC LIMIT -1 OFFSET ?
       )`,
      SANDBOX_COMMAND_MAX_RETAINED
    );
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
