import { decryptToken, encryptToken } from "../auth/crypto";
import type { SessionWebSocket } from "../platform-ports";
import { STOP_CONFIRMATION_TIMEOUT_MS, type MessageRepository } from "./message-repository";
import type { SandboxStateReader } from "./sandbox-ports";
import type { SessionMessenger } from "./messenger";
import type { SqlStorage } from "./sql-storage";
import type { SandboxCommand } from "./types";
import {
  SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS,
  type SessionWebSocketManager,
} from "./websocket-manager";

interface OutboxRow {
  command_id: string;
  sandbox_id: string;
  sandbox_created_at: number;
  command_type: "prompt" | "stop" | "push";
  message_id: string | null;
  payload: string;
  encrypted: number;
  attempted: number;
  expires_at: number;
}

export interface SandboxCommandOutboxDeps {
  sql: SqlStorage;
  wsManager: SessionWebSocketManager;
  sandboxRepository: SandboxStateReader;
  messageRepository: Pick<
    MessageRepository,
    "getMessageById" | "getMessageAwaitingStopConfirmation"
  >;
  encryptionKey: string;
  messenger: Pick<SessionMessenger, "broadcast">;
  mayDispatch: (type: "prompt" | "push") => boolean;
}

/** Persist before delivery; only replay attempted commands to a deduplicating runtime. */
export class SandboxCommandOutbox {
  constructor(private readonly deps: SandboxCommandOutboxDeps) {}

  recordProtocol(supported: boolean): void {
    const sandbox = this.deps.sandboxRepository.getSandbox();
    if (!sandbox?.modal_sandbox_id) return;
    this.deps.sql.exec(
      `INSERT OR REPLACE INTO sandbox_command_protocol
       (singleton, sandbox_id, sandbox_created_at, socket_id, supported) VALUES (1, ?, ?, ?, ?)`,
      sandbox.modal_sandbox_id,
      sandbox.created_at,
      sandbox.active_socket_id ?? "",
      supported ? 1 : 0
    );
  }

  supportsReplay(): boolean {
    const sandbox = this.deps.sandboxRepository.getSandbox();
    return (
      this.deps.sql
        .exec(
          `SELECT singleton FROM sandbox_command_protocol
       WHERE sandbox_id = ? AND sandbox_created_at = ? AND socket_id = ? AND supported = 1`,
          sandbox?.modal_sandbox_id ?? "",
          sandbox?.created_at ?? -1,
          sandbox?.active_socket_id ?? ""
        )
        .toArray().length > 0
    );
  }

  send(
    ws: SessionWebSocket,
    command: Extract<SandboxCommand, { type: "prompt" | "stop" }>
  ): boolean {
    const sandbox = this.deps.sandboxRepository.getSandbox();
    if (!sandbox?.modal_sandbox_id) return false;
    const commandId = command.commandId ?? crypto.randomUUID();
    const messageId =
      command.messageId ?? this.deps.messageRepository.getMessageAwaitingStopConfirmation()?.id;
    const payload = JSON.stringify({ ...command, commandId, ...(messageId ? { messageId } : {}) });
    return this.persistAndSend(
      ws,
      {
        command_id: commandId,
        sandbox_id: sandbox.modal_sandbox_id,
        sandbox_created_at: sandbox.created_at,
        command_type: command.type,
        message_id: messageId ?? null,
        payload,
        encrypted: 0,
        attempted: 0,
        expires_at:
          command.type === "stop"
            ? Date.now() + STOP_CONFIRMATION_TIMEOUT_MS
            : Number.MAX_SAFE_INTEGER,
      },
      payload
    );
  }

  async sendPush(
    ws: SessionWebSocket,
    command: Extract<SandboxCommand, { type: "push" }>,
    commandId: string,
    expiresAt: number
  ): Promise<boolean> {
    const sandbox = this.deps.sandboxRepository.getSandbox();
    if (!sandbox?.modal_sandbox_id || !this.deps.mayDispatch("push") || this.targetSocket() !== ws)
      return false;
    const sandboxId = sandbox.modal_sandbox_id;
    const createdAt = sandbox.created_at;
    const payload = JSON.stringify({ ...command, commandId });
    const encrypted = await encryptToken(payload, this.deps.encryptionKey);
    // Encryption yields: persist only if this generation and its dispatch authority survived.
    return this.persistAndSend(
      ws,
      {
        command_id: commandId,
        sandbox_id: sandboxId,
        sandbox_created_at: createdAt,
        command_type: "push",
        message_id: null,
        payload: encrypted,
        encrypted: 1,
        attempted: 0,
        expires_at: expiresAt,
      },
      payload
    );
  }

  async flush(): Promise<void> {
    const rows = this.deps.sql
      .exec("SELECT * FROM sandbox_command_outbox ORDER BY rowid")
      .toArray() as OutboxRow[];
    for (const row of rows) {
      if (!this.retain(row)) continue;
      if (row.attempted && !this.supportsReplay()) continue;
      const ws = this.targetSocket();
      if (!ws || !this.canSend(row)) continue;
      let payload = row.payload;
      if (row.encrypted) {
        try {
          payload = await decryptToken(payload, this.deps.encryptionKey);
        } catch {
          this.discard(row.command_id);
          continue;
        }
      }
      // ACK, cancellation, expiry, revocation and socket replacement may race decryption.
      const [current] = this.deps.sql
        .exec("SELECT attempted FROM sandbox_command_outbox WHERE command_id = ?", row.command_id)
        .toArray() as Array<{ attempted: number }>;
      if (!current || !this.retain(row) || this.targetSocket() !== ws || !this.canSend(row))
        continue;
      if (current.attempted && !this.supportsReplay()) continue;
      this.deps.sql.exec(
        "UPDATE sandbox_command_outbox SET attempted = 1 WHERE command_id = ?",
        row.command_id
      );
      this.deps.wsManager.send(ws, payload);
    }
  }

  acknowledge(commandId: string): void {
    this.discard(commandId);
  }

  hasUnacknowledgedPrompt(messageId: string): boolean {
    return (
      this.deps.sql
        .exec(
          "SELECT command_id FROM sandbox_command_outbox WHERE command_type = 'prompt' AND message_id = ?",
          messageId
        )
        .toArray().length > 0
    );
  }

  discard(commandId: string): void {
    this.deps.sql.exec("DELETE FROM sandbox_command_outbox WHERE command_id = ?", commandId);
  }

  private persistAndSend(ws: SessionWebSocket, row: OutboxRow, payload: string): boolean {
    if (
      !this.isLive(row) ||
      (row.command_type !== "stop" && !this.deps.mayDispatch(row.command_type)) ||
      this.targetSocket() !== ws
    )
      return false;
    this.deps.sql.exec(
      `INSERT INTO sandbox_command_outbox
       (command_id, sandbox_id, sandbox_created_at, command_type, message_id, payload, encrypted, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.command_id,
      row.sandbox_id,
      row.sandbox_created_at,
      row.command_type,
      row.message_id,
      row.payload,
      row.encrypted,
      row.expires_at
    );
    if (!this.canSend(row)) {
      this.deps.messenger.broadcast({ type: "sandbox_connection", status: "reconnecting" });
      return true;
    }
    this.deps.sql.exec(
      "UPDATE sandbox_command_outbox SET attempted = 1 WHERE command_id = ?",
      row.command_id
    );
    if (this.deps.wsManager.send(ws, payload)) return true;
    this.discard(row.command_id);
    return false;
  }

  private targetSocket(): SessionWebSocket | null {
    const target = this.deps.wsManager.getSandboxCommandTarget();
    if (target.kind !== "dispatch" && target.kind !== "reconnecting") return null;
    return this.deps.wsManager.isActiveSandboxSocket(target.socket) ? target.socket : null;
  }

  private canSend(row: OutboxRow): boolean {
    const heartbeat = this.deps.sandboxRepository.getSandbox()?.last_heartbeat;
    return (
      heartbeat != null &&
      Date.now() - heartbeat < SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS &&
      (row.command_type === "stop" || this.deps.mayDispatch(row.command_type))
    );
  }

  private retain(row: OutboxRow): boolean {
    if (this.isLive(row)) return true;
    this.discard(row.command_id);
    return false;
  }

  private isLive(row: OutboxRow): boolean {
    const sandbox = this.deps.sandboxRepository.getSandbox();
    if (
      row.expires_at <= Date.now() ||
      sandbox?.modal_sandbox_id !== row.sandbox_id ||
      sandbox.created_at !== row.sandbox_created_at
    )
      return false;
    if (row.command_type === "push") return true;
    if (!row.message_id) return false;
    const message = this.deps.messageRepository.getMessageById(row.message_id);
    if (row.command_type === "prompt") return message?.status === "processing";
    return (
      message?.status === "failed" ||
      this.deps.messageRepository.getMessageAwaitingStopConfirmation()?.id === row.message_id
    );
  }
}
