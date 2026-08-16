import { sandboxEventSchema, type SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { clientRequestIdSchema } from "@open-inspect/shared/types/prompts";
import { clientMessageSchema, type ClientMessage } from "@open-inspect/shared/types/websocket";
import type { Logger } from "../logger";
import type { SessionHistoryPage } from "./event-stream";
import type { Clock, ConnectedClient, SocketRegistry } from "./ports";

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

// Retain valid JSON on schema failure so correlated errors do not parse the payload twice.
type ParsedMessage<T> = { valid: true; data: T } | { valid: false; raw?: unknown };

export interface SessionClientCommands<Connection, Client extends ConnectedClient> {
  subscribe: (connection: Connection, message: ClientSubscribe) => Promise<void>;
  submitPrompt: (connection: Connection, client: Client, message: ClientPrompt) => Promise<void>;
  cancelPrompt: (connection: Connection, message: ClientCancelPrompt) => Promise<void>;
  stopExecution: () => Promise<void>;
  notifyTyping: () => Promise<void>;
  updatePresence: (client: Client, message: ClientPresence) => void;
  getHistoryPage: (message: {
    cursor: NonNullable<FetchHistory["cursor"]>;
    limit?: number;
  }) => SessionHistoryPage;
}

export interface SessionMessageRouterDeps<Connection, Client extends ConnectedClient> {
  getLogger: () => Logger;
  sockets: SocketRegistry<Connection, Client>;
  clientCommands: SessionClientCommands<Connection, Client>;
  processSandboxEvent: (event: SandboxEvent) => Promise<void>;
  clock: Clock;
}

/** Validates incoming messages and routes them to session capabilities. */
export class SessionMessageRouter<Connection, Client extends ConnectedClient> {
  constructor(private readonly deps: SessionMessageRouterDeps<Connection, Client>) {}

  async route(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    // The wire protocol is JSON text; binary frames have always been ignored.
    if (typeof message !== "string") return;

    if (this.deps.sockets.classify(connection).kind === "sandbox") {
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
        this.deps.sockets.send(connection, {
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
      // Ping and subscribe are the only messages valid before client authentication.
      if (data.type === "ping") {
        this.deps.sockets.send(connection, { type: "pong", timestamp: this.deps.clock.nowMs() });
        return;
      }
      if (data.type === "subscribe") {
        await this.deps.clientCommands.subscribe(connection, data);
        return;
      }

      const client = this.deps.sockets.getClient(connection);
      if (!client) return;

      switch (data.type) {
        case "prompt":
          await this.deps.clientCommands.submitPrompt(connection, client, data);
          break;
        case "cancel_prompt":
          await this.deps.clientCommands.cancelPrompt(connection, data);
          break;
        case "stop":
          await this.deps.clientCommands.stopExecution();
          break;
        case "typing":
          await this.deps.clientCommands.notifyTyping();
          break;
        case "fetch_history":
          this.handleFetchHistory(connection, client, data);
          break;
        case "presence":
          this.deps.clientCommands.updatePresence(client, data);
          break;
        default:
          // Adding a shared ClientMessage variant must also add an explicit handler here.
          data satisfies never;
      }
    } catch (error) {
      this.deps.getLogger().error("Error processing client message", {
        error: error instanceof Error ? error : String(error),
      });
      this.deps.sockets.send(connection, {
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
      this.deps.sockets.send(connection, {
        type: "error",
        code: "INVALID_CURSOR",
        message: "Invalid cursor",
      });
      return;
    }

    const now = this.deps.clock.nowMs();
    if (
      client.lastFetchHistoryAtMs !== undefined &&
      now - client.lastFetchHistoryAtMs < FETCH_HISTORY_MIN_INTERVAL_MS
    ) {
      this.deps.sockets.send(connection, {
        type: "error",
        code: "RATE_LIMITED",
        message: "Too many requests",
      });
      return;
    }
    client.lastFetchHistoryAtMs = now;

    const page = this.deps.clientCommands.getHistoryPage({
      cursor: data.cursor,
      limit: data.limit,
    });
    this.deps.sockets.send(connection, { type: "history_page", ...page });
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
      // Keep the parsed object for clientRequestId correlation on invalid prompts.
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
