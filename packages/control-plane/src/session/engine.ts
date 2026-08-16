import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import { sandboxEventSchema, type SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import { clientRequestIdSchema } from "@open-inspect/shared/types/prompts";
import { clientMessageSchema, type ClientMessage } from "@open-inspect/shared/types/websocket";
import type { Logger } from "../logger";
import { isSandboxReconnectBlockedStatus } from "../sandbox/lifecycle/decisions";
import type { SessionHistoryPage } from "./event-stream";
import type { SessionInternalRoute } from "./http/routes";

type ClientCancelPrompt = Extract<ClientMessage, { type: "cancel_prompt" }>;
type ClientPresence = Extract<ClientMessage, { type: "presence" }>;
type ClientSubscribe = Extract<ClientMessage, { type: "subscribe" }>;
type FetchHistory = Extract<ClientMessage, { type: "fetch_history" }>;

type BoundarySchema<T> = {
  safeParse(
    input: unknown
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
};

export interface SessionEngineClient {
  participantId: string;
  userId: string;
  lastFetchHistoryAt?: number;
}

export type SessionConnectionKind =
  | { kind: "sandbox"; sandboxId?: string }
  | { kind: "client"; wsId?: string };

export interface SessionEngineDeps<Connection, Client extends SessionEngineClient> {
  initialize: () => void;
  getLogger: () => Logger;
  routes: readonly SessionInternalRoute[];
  handleWebSocketUpgrade: (request: Request, url: URL, log: Logger) => Promise<Response>;
  classifyConnection: (connection: Connection) => SessionConnectionKind;
  send: (connection: Connection, message: ServerMessage) => boolean;
  close: (connection: Connection, code: number, reason: string) => void;
  closeOnError: (connection: Connection) => void;
  getClient: (connection: Connection) => Client | null;
  handleSubscribe: (connection: Connection, message: ClientSubscribe) => Promise<void>;
  handlePrompt: (
    connection: Connection,
    client: Client,
    message: {
      content: string;
      model?: string;
      reasoningEffort?: string;
      attachments?: SessionAttachmentReference[];
      clientRequestId: string;
    }
  ) => Promise<void>;
  cancelPrompt: (connection: Connection, message: ClientCancelPrompt) => Promise<void>;
  stopExecution: () => Promise<void>;
  handleTyping: () => Promise<void>;
  updatePresence: (client: Client, message: ClientPresence) => void;
  getHistoryPage: (message: {
    cursor: NonNullable<FetchHistory["cursor"]>;
    limit?: number;
  }) => SessionHistoryPage;
  processSandboxEvent: (event: SandboxEvent) => Promise<void>;
  clearSandboxConnectionIfMatch: (connection: Connection) => boolean;
  getSandboxStatus: () => SandboxStatus | undefined;
  scheduleDisconnectCheck: () => Promise<void>;
  removeClient: (connection: Connection) => Client | null;
  hasAuthenticatedParticipant: (participantId: string) => boolean;
  broadcastPresence: () => void;
  broadcast: (message: ServerMessage) => void;
  handleAlarm: () => Promise<void>;
  now: () => number;
  monotonicNow: () => number;
}

/** Platform-neutral orchestration for a single session runtime. */
export class SessionEngine<Connection, Client extends SessionEngineClient> {
  constructor(private readonly deps: SessionEngineDeps<Connection, Client>) {}

  async fetch(request: Request): Promise<Response> {
    const fetchStart = this.deps.monotonicNow();
    this.deps.initialize();
    const initMs = this.deps.monotonicNow() - fetchStart;
    const log = this.requestLogger(request);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.headers.get("Upgrade") === "websocket") {
      return this.deps.handleWebSocketUpgrade(request, url, log);
    }

    const route = this.deps.routes.find(
      (candidate) => candidate.path === path && candidate.method === request.method
    );
    if (!route) return new Response("Not Found", { status: 404 });

    const handlerStart = this.deps.monotonicNow();
    let status = 500;
    let outcome: "success" | "error" = "error";
    try {
      const response = await route.handler(request, url, log);
      status = response.status;
      outcome = status >= 500 ? "error" : "success";
      return response;
    } catch (error) {
      status = 500;
      outcome = "error";
      throw error;
    } finally {
      const handlerMs = this.deps.monotonicNow() - handlerStart;
      const totalMs = this.deps.monotonicNow() - fetchStart;
      log.info("do.request", {
        event: "do.request",
        http_method: request.method,
        http_path: path,
        http_status: status,
        duration_ms: Math.round(totalMs * 100) / 100,
        init_ms: Math.round(initMs * 100) / 100,
        handler_ms: Math.round(handlerMs * 100) / 100,
        outcome,
      });
    }
  }

  async webSocketMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    this.deps.initialize();
    if (typeof message !== "string") return;

    if (this.deps.classifyConnection(connection).kind === "sandbox") {
      await this.handleSandboxMessage(message);
    } else {
      await this.handleClientMessage(connection, message);
    }
  }

  async webSocketClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    this.deps.initialize();
    const classified = this.deps.classifyConnection(connection);

    try {
      if (classified.kind === "sandbox") {
        if (!this.deps.clearSandboxConnectionIfMatch(connection)) {
          this.deps.getLogger().debug("Ignoring close for replaced sandbox socket", { code });
          return;
        }

        const sandboxStatus = this.deps.getSandboxStatus();
        const reconnectBlocked =
          sandboxStatus !== undefined && isSandboxReconnectBlockedStatus(sandboxStatus);
        if (!reconnectBlocked) {
          this.deps.getLogger().warn("Sandbox WebSocket disconnected; awaiting reconnect", {
            event: "sandbox.disconnected",
            code,
            reason,
            was_clean: wasClean,
            sandbox_status: sandboxStatus,
            sandbox_id: classified.sandboxId,
          });
          await this.deps.scheduleDisconnectCheck();
        }
      } else {
        const client = this.deps.removeClient(connection);
        if (client) {
          if (this.deps.hasAuthenticatedParticipant(client.participantId)) {
            this.deps.broadcastPresence();
          } else {
            this.deps.broadcast({ type: "presence_leave", userId: client.userId });
          }
        }
      }
    } finally {
      this.deps.close(connection, code, reason);
    }
  }

  webSocketError(connection: Connection, error: Error): void {
    this.deps.initialize();
    this.deps.getLogger().error("WebSocket error", { error });
    this.deps.closeOnError(connection);
  }

  async alarm(): Promise<void> {
    this.deps.initialize();
    await this.deps.handleAlarm();
  }

  private requestLogger(request: Request): Logger {
    const sessionLog = this.deps.getLogger();
    const traceId = request.headers.get("x-trace-id");
    const requestId = request.headers.get("x-request-id");
    if (!traceId && !requestId) return sessionLog;

    const correlationContext: Record<string, unknown> = {};
    if (traceId) correlationContext.trace_id = traceId;
    if (requestId) correlationContext.request_id = requestId;
    return sessionLog.child(correlationContext);
  }

  private async handleSandboxMessage(message: string): Promise<void> {
    const event = this.parseWebSocketMessage(message, "sandbox", sandboxEventSchema);
    if (!event) return;

    try {
      await this.deps.processSandboxEvent(event);
    } catch (error) {
      this.deps.getLogger().error("Error processing sandbox message", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  private async handleClientMessage(connection: Connection, message: string): Promise<void> {
    try {
      const data = this.parseWebSocketMessage(message, "client", clientMessageSchema);
      if (!data) {
        const invalidRequest = this.readInvalidCorrelatedRequest(message);
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
    if (client.lastFetchHistoryAt && now - client.lastFetchHistoryAt < 200) {
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

  private parseWebSocketMessage<T>(
    message: string,
    boundary: "client" | "sandbox",
    schema: BoundarySchema<T>
  ): T | null {
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch (error) {
      this.deps.getLogger().error("Invalid WebSocket JSON", {
        boundary,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      this.deps.getLogger().warn("Invalid WebSocket message", {
        boundary,
        issues: result.error.issues,
      });
      return null;
    }
    return result.data;
  }

  private readInvalidCorrelatedRequest(
    message: string
  ): { type: "prompt" | "cancel_prompt"; clientRequestId?: string } | null {
    try {
      const raw = JSON.parse(message) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const candidate = raw as Record<string, unknown>;
      if (candidate.type !== "prompt" && candidate.type !== "cancel_prompt") return null;
      const clientRequestId = clientRequestIdSchema.safeParse(candidate.clientRequestId);
      return clientRequestId.success
        ? { type: candidate.type, clientRequestId: clientRequestId.data }
        : { type: candidate.type };
    } catch {
      return null;
    }
  }
}
