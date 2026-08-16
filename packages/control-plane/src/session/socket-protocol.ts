import { sandboxEventSchema, type SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import { clientRequestIdSchema } from "@open-inspect/shared/types/prompts";
import { clientMessageSchema, type ClientMessage } from "@open-inspect/shared/types/websocket";
import type { Logger } from "../logger";
import type { SessionHistoryPage } from "./event-stream";
import type { SessionConnectionKind, SessionRuntimeClient } from "./runtime-contracts";

const FETCH_HISTORY_MIN_INTERVAL_MS = 200;

type ClientCancelPrompt = Extract<ClientMessage, { type: "cancel_prompt" }>;
type ClientPresence = Extract<ClientMessage, { type: "presence" }>;
type ClientPrompt = Extract<ClientMessage, { type: "prompt" }>;
type ClientSubscribe = Extract<ClientMessage, { type: "subscribe" }>;
type FetchHistory = Extract<ClientMessage, { type: "fetch_history" }>;

type BoundarySchema<T> = {
  safeParse(
    input: unknown
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
};

type ParsedMessage<T> = { valid: true; data: T } | { valid: false; raw?: unknown };

export interface SessionSocketProtocolDeps<Connection, Client extends SessionRuntimeClient> {
  getLogger: () => Logger;
  classifyConnection: (connection: Connection) => SessionConnectionKind;
  send: (connection: Connection, message: ServerMessage) => boolean;
  getClient: (connection: Connection) => Client | null;
  handleSubscribe: (connection: Connection, message: ClientSubscribe) => Promise<void>;
  handlePrompt: (connection: Connection, client: Client, message: ClientPrompt) => Promise<void>;
  cancelPrompt: (connection: Connection, message: ClientCancelPrompt) => Promise<void>;
  stopExecution: () => Promise<void>;
  handleTyping: () => Promise<void>;
  updatePresence: (client: Client, message: ClientPresence) => void;
  getHistoryPage: (message: {
    cursor: NonNullable<FetchHistory["cursor"]>;
    limit?: number;
  }) => SessionHistoryPage;
  processSandboxEvent: (event: SandboxEvent) => Promise<void>;
  now: () => number;
}

/** Validates and dispatches the session WebSocket protocol. */
export class SessionSocketProtocol<Connection, Client extends SessionRuntimeClient> {
  constructor(private readonly deps: SessionSocketProtocolDeps<Connection, Client>) {}

  async handleMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    if (this.deps.classifyConnection(connection).kind === "sandbox") {
      await this.handleSandboxMessage(message);
    } else {
      await this.handleClientMessage(connection, message);
    }
  }

  private async handleSandboxMessage(message: string): Promise<void> {
    const parsed = this.parseMessage(message, "sandbox", sandboxEventSchema);
    if (!parsed.valid) return;

    try {
      await this.deps.processSandboxEvent(parsed.data);
    } catch (error) {
      this.deps.getLogger().error("Error processing sandbox message", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  private async handleClientMessage(connection: Connection, message: string): Promise<void> {
    try {
      const parsed = this.parseMessage(message, "client", clientMessageSchema);
      if (!parsed.valid) {
        const invalidRequest = this.readInvalidCorrelatedRequest(parsed.raw);
        this.deps.send(connection, {
          type: "error",
          code: invalidRequest?.type === "prompt" ? "INVALID_PROMPT" : "INVALID_MESSAGE",
          message:
            invalidRequest?.type === "prompt" ? "Invalid prompt" : "Failed to process message",
          ...(invalidRequest?.clientRequestId
            ? { clientRequestId: invalidRequest.clientRequestId }
            : {}),
        });
        return;
      }

      const data = parsed.data;
      if (data.type === "ping") {
        this.deps.send(connection, { type: "pong", timestamp: this.deps.now() });
        return;
      }
      if (data.type === "subscribe") {
        await this.deps.handleSubscribe(connection, data);
        return;
      }

      const client = this.deps.getClient(connection);
      if (!client) return;

      switch (data.type) {
        case "prompt":
          await this.deps.handlePrompt(connection, client, data);
          break;
        case "cancel_prompt":
          await this.deps.cancelPrompt(connection, data);
          break;
        case "stop":
          await this.deps.stopExecution();
          break;
        case "typing":
          await this.deps.handleTyping();
          break;
        case "fetch_history":
          this.handleFetchHistory(connection, client, data);
          break;
        case "presence":
          this.deps.updatePresence(client, data);
          break;
        default:
          data satisfies never;
      }
    } catch (error) {
      this.deps.getLogger().error("Error processing client message", {
        error: error instanceof Error ? error : String(error),
      });
      this.deps.send(connection, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Failed to process message",
      });
    }
  }

  private handleFetchHistory(connection: Connection, client: Client, data: FetchHistory): void {
    if (
      !data.cursor ||
      typeof data.cursor.timestamp !== "number" ||
      typeof data.cursor.id !== "string" ||
      (data.cursor.sequence !== undefined &&
        (!Number.isSafeInteger(data.cursor.sequence) || data.cursor.sequence < 0))
    ) {
      this.deps.send(connection, {
        type: "error",
        code: "INVALID_CURSOR",
        message: "Invalid cursor",
      });
      return;
    }

    const now = this.deps.now();
    if (
      client.lastFetchHistoryAt &&
      now - client.lastFetchHistoryAt < FETCH_HISTORY_MIN_INTERVAL_MS
    ) {
      this.deps.send(connection, {
        type: "error",
        code: "RATE_LIMITED",
        message: "Too many requests",
      });
      return;
    }
    client.lastFetchHistoryAt = now;

    const page = this.deps.getHistoryPage({ cursor: data.cursor, limit: data.limit });
    this.deps.send(connection, { type: "history_page", ...page });
  }

  private parseMessage<T>(
    message: string,
    boundary: "client" | "sandbox",
    schema: BoundarySchema<T>
  ): ParsedMessage<T> {
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch (error) {
      this.deps.getLogger().error("Invalid WebSocket JSON", {
        boundary,
        error: error instanceof Error ? error.message : String(error),
      });
      return { valid: false };
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      this.deps.getLogger().warn("Invalid WebSocket message", {
        boundary,
        issues: result.error.issues,
      });
      return { valid: false, raw };
    }
    return { valid: true, data: result.data };
  }

  private readInvalidCorrelatedRequest(
    raw: unknown
  ): { type: "prompt" | "cancel_prompt"; clientRequestId?: string } | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const candidate = raw as Record<string, unknown>;
    if (candidate.type !== "prompt" && candidate.type !== "cancel_prompt") return null;
    const clientRequestId = clientRequestIdSchema.safeParse(candidate.clientRequestId);
    return clientRequestId.success
      ? { type: candidate.type, clientRequestId: clientRequestId.data }
      : { type: candidate.type };
  }
}
