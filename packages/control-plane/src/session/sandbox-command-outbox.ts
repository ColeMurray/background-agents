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
  bridge_instance_id: string | null;
  expires_at: number;
}

interface CommandProtocol {
  supported: number;
  bridge_instance_id: string | null;
  stop_confirmation_version: number | null;
}

export interface SandboxCommandOutboxDeps {
  sql: SqlStorage;
  wsManager: SessionWebSocketManager;
  sandboxRepository: SandboxStateReader;
  messageRepository: Pick<
    MessageRepository,
    | "getMessageById"
    | "getMessageAwaitingStopConfirmation"
    | "setStopConfirmationRequirement"
    | "resolveUnknownStopConfirmationPolicy"
  >;
  encryptionKey: string;
  messenger: Pick<SessionMessenger, "broadcast">;
  mayDispatch: (type: "prompt" | "push") => boolean;
  onUncertainDelivery: (command: {
    commandId: string;
    type: OutboxRow["command_type"];
  }) => Promise<void>;
}

/** Persist before delivery; only replay attempted commands to a deduplicating runtime. */
export class SandboxCommandOutbox {
  constructor(private readonly deps: SandboxCommandOutboxDeps) {}

  recordProtocol(supported: boolean, bridgeInstanceId?: string, stopConfirmationVersion?: 1): void {
    const sandbox = this.deps.sandboxRepository.getSandbox();
    if (!sandbox?.modal_sandbox_id) return;
    this.deps.sql.exec(
      `INSERT OR REPLACE INTO sandbox_command_protocol
       (singleton, sandbox_id, sandbox_created_at, socket_id, supported, bridge_instance_id, stop_confirmation_version) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      sandbox.modal_sandbox_id,
      sandbox.created_at,
      sandbox.active_socket_id ?? "",
      supported && bridgeInstanceId ? 1 : 0,
      bridgeInstanceId ?? null,
      stopConfirmationVersion ?? null
    );
    // A boot-time stop may already have been delivered (and receipt-ACKed).
    // Resolve its unknown fence even when no outbox entry remains to flush.
    this.deps.messageRepository.resolveUnknownStopConfirmationPolicy(stopConfirmationVersion === 1);
  }

  supportsReplay(): boolean {
    const protocol = this.protocol();
    return protocol?.supported === 1 && protocol.bridge_instance_id !== null;
  }

  /** Null means this socket has not negotiated; keep its stop fence conservative. */
  requiresStopConfirmation(): boolean | null {
    const protocol = this.protocol();
    return protocol ? protocol.stop_confirmation_version === 1 : null;
  }

  private protocol(): CommandProtocol | undefined {
    const sandbox = this.deps.sandboxRepository.getSandbox();
    return this.deps.sql
      .exec(
        `SELECT supported, bridge_instance_id, stop_confirmation_version FROM sandbox_command_protocol
      WHERE sandbox_id = ? AND sandbox_created_at = ? AND socket_id = ?`,
        sandbox?.modal_sandbox_id ?? "",
        sandbox?.created_at ?? -1,
        sandbox?.active_socket_id ?? ""
      )
      .toArray()[0] as CommandProtocol | undefined;
  }

  send(
    ws: SessionWebSocket,
    command: Extract<SandboxCommand, { type: "prompt" | "stop" }>
  ): boolean {
    const commandId = this.enqueue(ws, command);
    return commandId !== null && this.deliver(ws, commandId);
  }

  /** Persistence only, safe to include in the message-claim transaction. */
  enqueue(
    ws: SessionWebSocket,
    command: Extract<SandboxCommand, { type: "prompt" | "stop" }>
  ): string | null {
    const sandbox = this.deps.sandboxRepository.getSandbox();
    if (!sandbox?.modal_sandbox_id) return null;
    const commandId = command.commandId ?? crypto.randomUUID();
    const messageId =
      command.messageId ?? this.deps.messageRepository.getMessageAwaitingStopConfirmation()?.id;
    const payload = JSON.stringify({ ...command, commandId, ...(messageId ? { messageId } : {}) });
    const persisted = this.persist(ws, {
      command_id: commandId,
      sandbox_id: sandbox.modal_sandbox_id,
      sandbox_created_at: sandbox.created_at,
      command_type: command.type,
      message_id: messageId ?? null,
      payload,
      encrypted: 0,
      attempted: 0,
      bridge_instance_id: null,
      expires_at:
        command.type === "stop"
          ? Date.now() + STOP_CONFIRMATION_TIMEOUT_MS
          : Number.MAX_SAFE_INTEGER,
    });
    return persisted ? commandId : null;
  }

  /** Called only after the enclosing enqueue transaction has committed. */
  deliver(ws: SessionWebSocket, commandId: string): boolean {
    const row = this.deps.sql
      .exec("SELECT * FROM sandbox_command_outbox WHERE command_id = ?", commandId)
      .toArray()[0] as OutboxRow | undefined;
    if (!row || row.encrypted || row.attempted) return false;
    return this.sendPersisted(ws, row, row.payload);
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
    const row: OutboxRow = {
      command_id: commandId,
      sandbox_id: sandboxId,
      sandbox_created_at: createdAt,
      command_type: "push",
      message_id: null,
      payload: encrypted,
      encrypted: 1,
      attempted: 0,
      bridge_instance_id: null,
      expires_at: expiresAt,
    };
    return this.persist(ws, row) && this.sendPersisted(ws, row, payload);
  }

  async flush(): Promise<void> {
    const socket = this.targetSocket();
    if (socket && !this.protocol() && !this.deps.wsManager.expectsSandboxReady(socket)) {
      // Untagged sockets surviving a rollout need a new handshake. Fresh sockets
      // may drain buffered heartbeats before ready and must be allowed to finish.
      this.deps.wsManager.close(socket, 1012, "Sandbox command negotiation required");
      this.deps.messenger.broadcast({ type: "sandbox_connection", status: "reconnecting" });
    }
    const rows = this.deps.sql
      .exec("SELECT * FROM sandbox_command_outbox ORDER BY rowid")
      .toArray() as OutboxRow[];
    for (const row of rows) {
      if (!this.retain(row)) continue;
      const ws = this.targetSocket(row.command_type);
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
        .exec("SELECT * FROM sandbox_command_outbox WHERE command_id = ?", row.command_id)
        .toArray() as OutboxRow[];
      if (
        !current ||
        !this.retain(row) ||
        this.targetSocket(row.command_type) !== ws ||
        !this.canSend(row)
      )
        continue;
      const protocol = this.protocol();
      if (current.attempted) {
        if (!protocol) continue;
        if (current.bridge_instance_id !== protocol.bridge_instance_id) {
          // The receiver lost its deduplication memory. Never turn uncertainty
          // into another execution, even within the same sandbox generation.
          await this.deps.onUncertainDelivery({
            commandId: row.command_id,
            type: row.command_type,
          });
          this.discard(row.command_id);
          return;
        }
        if (!protocol.supported || !protocol.bridge_instance_id) continue;
      }
      this.recordAttempt(row, protocol);
      if (!this.deps.wsManager.send(ws, payload) && !current.attempted) {
        this.deps.sql.exec(
          "UPDATE sandbox_command_outbox SET attempted = 0, bridge_instance_id = NULL WHERE command_id = ?",
          row.command_id
        );
      }
    }
  }

  acknowledge(commandId: string): void {
    this.discard(commandId);
  }

  confirmStop(commandId: string, messageId: string): void {
    this.deps.sql.exec(
      `DELETE FROM sandbox_command_outbox
      WHERE command_id = ? AND message_id = ? AND command_type = 'stop'`,
      commandId,
      messageId
    );
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

  private persist(ws: SessionWebSocket, row: OutboxRow): boolean {
    if (
      !this.isLive(row) ||
      (row.command_type !== "stop" && !this.deps.mayDispatch(row.command_type)) ||
      this.targetSocket(row.command_type) !== ws
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
    return true;
  }

  private sendPersisted(ws: SessionWebSocket, row: OutboxRow, payload: string): boolean {
    if (!this.isLive(row) || this.targetSocket(row.command_type) !== ws) return false;
    if (!this.canSend(row)) {
      this.deps.messenger.broadcast({ type: "sandbox_connection", status: "reconnecting" });
      return true;
    }
    this.recordAttempt(row, this.protocol());
    if (this.deps.wsManager.send(ws, payload)) return true;
    this.discard(row.command_id);
    return false;
  }

  private recordAttempt(row: OutboxRow, protocol: CommandProtocol | undefined): void {
    // Unknown is not legacy: resolve a held stop's fence against the receiver
    // used for this delivery, before any completion can arrive on its socket.
    if (row.command_type === "stop" && row.message_id) {
      this.deps.messageRepository.setStopConfirmationRequirement(
        row.message_id,
        protocol ? protocol.stop_confirmation_version === 1 : null
      );
    }
    this.deps.sql.exec(
      "UPDATE sandbox_command_outbox SET attempted = 1, bridge_instance_id = ? WHERE command_id = ?",
      protocol?.bridge_instance_id ?? null,
      row.command_id
    );
  }

  private targetSocket(commandType?: OutboxRow["command_type"]): SessionWebSocket | null {
    if (commandType === "stop") {
      const socket = this.deps.wsManager.getSandboxSocket();
      return socket && this.deps.wsManager.isActiveSandboxSocket(socket) ? socket : null;
    }
    const target = this.deps.wsManager.getSandboxCommandTarget();
    if (target.kind !== "dispatch" && target.kind !== "reconnecting") return null;
    return this.deps.wsManager.isActiveSandboxSocket(target.socket) ? target.socket : null;
  }

  private canSend(row: OutboxRow): boolean {
    const heartbeat = this.deps.sandboxRepository.getSandbox()?.last_heartbeat;
    // Early boot can receive a stop before ready negotiation. Only its first
    // delivery is allowed without protocol identity; flush still fences replays.
    return (
      heartbeat != null &&
      (this.protocol() !== undefined ||
        (row.command_type === "stop" &&
          this.deps.wsManager.getSandboxCommandTarget().kind === "booting")) &&
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
