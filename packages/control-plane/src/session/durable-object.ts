/**
 * Session Durable Object implementation.
 *
 * Each session gets its own Durable Object instance with:
 * - SQLite database for persistent state
 * - WebSocket connections with hibernation support
 * - Prompt queue and event streaming
 */

import { DurableObject } from "cloudflare:workers";
import { initSchema } from "./schema";
import { generateId, decryptToken, encryptToken, hashToken } from "../auth/crypto";
import {
  generateInstallationToken,
  getGitHubAppConfig,
  getInstallationRepository,
} from "../auth/github-app";
import { refreshAccessToken } from "../auth/github";
import { createModalClient } from "../sandbox/client";
import { createModalProvider } from "../sandbox/providers/modal-provider";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxStorage,
  type SandboxBroadcaster,
  type WebSocketManager,
  type AlarmScheduler,
  type IdGenerator,
} from "../sandbox/lifecycle/manager";
import { createPullRequest, getRepository } from "../auth/pr";
import { generateBranchName } from "@open-inspect/shared";
import { DEFAULT_MODEL, isValidModel, extractProviderAndModel } from "../utils/models";
import type {
  Env,
  ClientInfo,
  ClientMessage,
  ServerMessage,
  SandboxEvent,
  SessionState,
  ParticipantPresence,
  SandboxStatus,
  MessageSource,
  ParticipantRole,
} from "../types";
import type { SessionRow, ParticipantRow, EventRow, SandboxRow, SandboxCommand } from "./types";
import { SessionRepository, type MessageWithParticipant } from "./repository";
import { RepoSecretsStore } from "../db/repo-secrets";

/**
 * Build GitHub avatar URL from login.
 */
function getGitHubAvatarUrl(githubLogin: string | null | undefined): string | undefined {
  return githubLogin ? `https://github.com/${githubLogin}.png` : undefined;
}

/**
 * Valid event types for filtering.
 * Includes both external types (from types.ts) and internal types used by the sandbox.
 */
const VALID_EVENT_TYPES = [
  "tool_call",
  "tool_result",
  "token",
  "error",
  "git_sync",
  "execution_complete",
  "heartbeat",
  "push_complete",
  "push_error",
] as const;

/**
 * Valid message statuses for filtering.
 */
const VALID_MESSAGE_STATUSES = ["pending", "processing", "completed", "failed"] as const;

/**
 * Timeout for WebSocket authentication (in milliseconds).
 * Client WebSockets must send a valid 'subscribe' message within this time
 * or the connection will be closed. This prevents resource abuse from
 * unauthenticated connections that never complete the handshake.
 */
const WS_AUTH_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Route definition for internal API endpoints.
 */
interface InternalRoute {
  method: string;
  path: string;
  handler: (request: Request, url: URL) => Promise<Response> | Response;
}

export class SessionDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private repository: SessionRepository;
  private clients: Map<WebSocket, ClientInfo>;
  private sandboxWs: WebSocket | null = null;
  private initialized = false;
  private log: Logger;
  // Track pending push operations by branch name
  private pendingPushResolvers = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  // Lifecycle manager (lazily initialized)
  private _lifecycleManager: SandboxLifecycleManager | null = null;

  // Route table for internal API endpoints
  private readonly routes: InternalRoute[] = [
    { method: "POST", path: "/internal/init", handler: (req) => this.handleInit(req) },
    { method: "GET", path: "/internal/state", handler: () => this.handleGetState() },
    { method: "POST", path: "/internal/prompt", handler: (req) => this.handleEnqueuePrompt(req) },
    { method: "POST", path: "/internal/stop", handler: () => this.handleStop() },
    {
      method: "POST",
      path: "/internal/sandbox-event",
      handler: (req) => this.handleSandboxEvent(req),
    },
    { method: "GET", path: "/internal/participants", handler: () => this.handleListParticipants() },
    {
      method: "POST",
      path: "/internal/participants",
      handler: (req) => this.handleAddParticipant(req),
    },
    { method: "GET", path: "/internal/events", handler: (_, url) => this.handleListEvents(url) },
    { method: "GET", path: "/internal/artifacts", handler: () => this.handleListArtifacts() },
    {
      method: "GET",
      path: "/internal/messages",
      handler: (_, url) => this.handleListMessages(url),
    },
    { method: "POST", path: "/internal/create-pr", handler: (req) => this.handleCreatePR(req) },
    {
      method: "POST",
      path: "/internal/ws-token",
      handler: (req) => this.handleGenerateWsToken(req),
    },
    { method: "POST", path: "/internal/archive", handler: (req) => this.handleArchive(req) },
    { method: "POST", path: "/internal/unarchive", handler: (req) => this.handleUnarchive(req) },
    {
      method: "POST",
      path: "/internal/verify-sandbox-token",
      handler: (req) => this.handleVerifySandboxToken(req),
    },
  ];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.repository = new SessionRepository(this.sql);
    this.clients = new Map();
    this.log = createLogger("session-do", {}, parseLogLevel(env.LOG_LEVEL));
    // Note: session_id context is set in ensureInitialized() once DB is ready
  }

  /**
   * Get the lifecycle manager, creating it lazily if needed.
   * The manager is created with adapters that delegate to the DO's methods.
   */
  private get lifecycleManager(): SandboxLifecycleManager {
    if (!this._lifecycleManager) {
      this._lifecycleManager = this.createLifecycleManager();
    }
    return this._lifecycleManager;
  }

  /**
   * Create the lifecycle manager with all required adapters.
   */
  private createLifecycleManager(): SandboxLifecycleManager {
    // Verify Modal configuration
    if (!this.env.MODAL_API_SECRET || !this.env.MODAL_WORKSPACE) {
      throw new Error("MODAL_API_SECRET and MODAL_WORKSPACE are required for lifecycle manager");
    }

    // Create Modal provider
    const modalClient = createModalClient(this.env.MODAL_API_SECRET, this.env.MODAL_WORKSPACE);
    const provider = createModalProvider(modalClient, this.env.MODAL_API_SECRET);

    // Storage adapter
    const storage: SandboxStorage = {
      getSandbox: () => this.repository.getSandbox(),
      getSandboxWithCircuitBreaker: () => this.repository.getSandboxWithCircuitBreaker(),
      getSession: () => this.repository.getSession(),
      getUserEnvVars: () => this.getUserEnvVars(),
      updateSandboxStatus: (status) => this.updateSandboxStatus(status),
      updateSandboxForSpawn: (data) => this.repository.updateSandboxForSpawn(data),
      updateSandboxModalObjectId: (id) => this.repository.updateSandboxModalObjectId(id),
      updateSandboxSnapshotImageId: (sandboxId, imageId) =>
        this.repository.updateSandboxSnapshotImageId(sandboxId, imageId),
      updateSandboxLastActivity: (timestamp) =>
        this.repository.updateSandboxLastActivity(timestamp),
      incrementCircuitBreakerFailure: (timestamp) =>
        this.repository.incrementCircuitBreakerFailure(timestamp),
      resetCircuitBreaker: () => this.repository.resetCircuitBreaker(),
      setLastSpawnError: (error, timestamp) =>
        this.repository.updateSandboxSpawnError(error, timestamp),
    };

    // Broadcaster adapter
    const broadcaster: SandboxBroadcaster = {
      broadcast: (message) => this.broadcast(message as ServerMessage),
    };

    // WebSocket manager adapter
    const wsManager: WebSocketManager = {
      getSandboxWebSocket: () => this.getSandboxWebSocket(),
      closeSandboxWebSocket: (code, reason) => {
        const ws = this.getSandboxWebSocket();
        if (ws) {
          try {
            ws.close(code, reason);
          } catch {
            // Ignore errors closing WebSocket
          }
          this.sandboxWs = null;
        }
      },
      sendToSandbox: (message) => {
        const ws = this.getSandboxWebSocket();
        return ws ? this.safeSend(ws, message) : false;
      },
      getConnectedClientCount: () => {
        return this.ctx.getWebSockets().filter((ws) => {
          const tags = this.ctx.getTags(ws);
          return !tags.includes("sandbox") && ws.readyState === WebSocket.OPEN;
        }).length;
      },
    };

    // Alarm scheduler adapter
    const alarmScheduler: AlarmScheduler = {
      scheduleAlarm: async (timestamp) => {
        await this.ctx.storage.setAlarm(timestamp);
      },
    };

    // ID generator adapter
    const idGenerator: IdGenerator = {
      generateId: () => generateId(),
    };

    // Build configuration
    const controlPlaneUrl =
      this.env.WORKER_URL ||
      `https://open-inspect-control-plane.${this.env.CF_ACCOUNT_ID || "workers"}.workers.dev`;

    const { provider: llmProvider, model } = extractProviderAndModel(DEFAULT_MODEL);

    // Resolve sessionId for lifecycle manager logging context
    const session = this.repository.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();

    const config = {
      ...DEFAULT_LIFECYCLE_CONFIG,
      controlPlaneUrl,
      provider: llmProvider,
      model,
      sessionId,
      inactivity: {
        ...DEFAULT_LIFECYCLE_CONFIG.inactivity,
        timeoutMs: parseInt(this.env.SANDBOX_INACTIVITY_TIMEOUT_MS || "600000", 10),
      },
    };

    return new SandboxLifecycleManager(
      provider,
      storage,
      broadcaster,
      wsManager,
      alarmScheduler,
      idGenerator,
      config
    );
  }

  /**
   * Safely send a message over a WebSocket, handling errors and closed connections.
   * Returns true if the message was sent, false otherwise.
   */
  private safeSend(ws: WebSocket, message: string | object): boolean {
    try {
      if (ws.readyState !== WebSocket.OPEN) {
        this.log.debug("Cannot send: WebSocket not open", { ready_state: ws.readyState });
        return false;
      }
      const data = typeof message === "string" ? message : JSON.stringify(message);
      ws.send(data);
      return true;
    } catch (e) {
      this.log.warn("WebSocket send failed", { error: e instanceof Error ? e : String(e) });
      return false;
    }
  }

  /**
   * Normalize branch name for comparison to handle case and whitespace differences.
   */
  private normalizeBranchName(name: string): string {
    return name.trim().toLowerCase();
  }

  /**
   * Initialize the session with required data.
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    initSchema(this.sql);
    this.initialized = true;
    const session = this.repository.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();
    this.log = createLogger(
      "session-do",
      { session_id: sessionId },
      parseLogLevel(this.env.LOG_LEVEL)
    );
  }

  /**
   * Handle incoming HTTP requests.
   */
  async fetch(request: Request): Promise<Response> {
    this.ensureInitialized();

    // Extract correlation headers and create a request-scoped logger
    const traceId = request.headers.get("x-trace-id");
    const requestId = request.headers.get("x-request-id");
    if (traceId || requestId) {
      const correlationCtx: Record<string, unknown> = {};
      if (traceId) correlationCtx.trace_id = traceId;
      if (requestId) correlationCtx.request_id = requestId;
      this.log = this.log.child(correlationCtx);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade (special case - header-based, not path-based)
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request, url);
    }

    // Match route from table
    const route = this.routes.find((r) => r.path === path && r.method === request.method);

    if (route) {
      const routeStart = Date.now();
      let status = 500;
      let outcome: "success" | "error" = "error";
      try {
        const response = await route.handler(request, url);
        status = response.status;
        outcome = status >= 500 ? "error" : "success";
        return response;
      } catch (e) {
        status = 500;
        outcome = "error";
        throw e;
      } finally {
        this.log.info("do.request", {
          event: "do.request",
          http_method: request.method,
          http_path: path,
          http_status: status,
          duration_ms: Date.now() - routeStart,
          outcome,
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Handle WebSocket upgrade request.
   */
  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    this.log.debug("WebSocket upgrade requested");
    const isSandbox = url.searchParams.get("type") === "sandbox";

    // Validate sandbox authentication
    if (isSandbox) {
      const wsStartTime = Date.now();
      const authHeader = request.headers.get("Authorization");
      const sandboxId = request.headers.get("X-Sandbox-ID");

      // Get expected values from DB
      const sandbox = this.getSandbox();
      const expectedToken = sandbox?.auth_token;
      const expectedSandboxId = sandbox?.modal_sandbox_id;

      // Reject connection if sandbox should be stopped (prevents reconnection after inactivity timeout)
      if (sandbox?.status === "stopped" || sandbox?.status === "stale") {
        this.log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "rejected",
          reject_reason: "sandbox_stopped",
          sandbox_status: sandbox.status,
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Sandbox is stopped", { status: 410 });
      }

      // Validate sandbox ID first (catches stale sandboxes reconnecting after restore)
      if (expectedSandboxId && sandboxId !== expectedSandboxId) {
        this.log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "auth_failed",
          reject_reason: "sandbox_id_mismatch",
          expected_sandbox_id: expectedSandboxId,
          sandbox_id: sandboxId,
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Forbidden: Wrong sandbox ID", { status: 403 });
      }

      // Validate auth token
      if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
        this.log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "auth_failed",
          reject_reason: "token_mismatch",
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Unauthorized: Invalid auth token", { status: 401 });
      }

      // Auth passed — continue to WebSocket accept below
      // The success ws.connect event is emitted after the WebSocket is accepted
    }

    try {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Accept with hibernation support
      // Include sandbox ID in tags for identity validation after hibernation recovery
      // For client WebSockets, generate a unique ws_id for mapping recovery
      const sandboxId = request.headers.get("X-Sandbox-ID");
      let tags: string[];
      let wsId: string | undefined;
      if (isSandbox) {
        tags = ["sandbox", ...(sandboxId ? [`sid:${sandboxId}`] : [])];
      } else {
        // Generate unique ws_id for client WebSocket mapping
        wsId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        tags = [`wsid:${wsId}`];
      }
      this.ctx.acceptWebSocket(server, tags);

      if (isSandbox) {
        // Close any existing sandbox WebSocket to prevent duplicates
        const existingSandboxWs = this.getSandboxWebSocket();
        const replacedExisting = !!(existingSandboxWs && existingSandboxWs !== server);
        if (replacedExisting) {
          try {
            existingSandboxWs!.close(1000, "New sandbox connecting");
          } catch {
            // Ignore errors closing old WebSocket
          }
        }

        this.sandboxWs = server;
        // Notify manager that sandbox connected so it can reset the spawning flag
        this.lifecycleManager.onSandboxConnected();
        this.updateSandboxStatus("ready");
        this.broadcast({ type: "sandbox_status", status: "ready" });

        // Set initial activity timestamp and schedule inactivity check
        // IMPORTANT: Must await to ensure alarm is scheduled before returning
        const now = Date.now();
        this.updateLastActivity(now);
        await this.scheduleInactivityCheck();

        this.log.info("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "success",
          sandbox_id: sandboxId,
          replaced_existing: replacedExisting,
          duration_ms: Date.now() - now,
        });

        // Process any pending messages now that sandbox is connected
        this.processMessageQueue();
      } else {
        // For client WebSockets, schedule authentication timeout check
        // This prevents resource abuse from connections that never authenticate
        if (wsId) {
          this.ctx.waitUntil(this.enforceAuthTimeout(server, wsId));
        }
      }

      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      this.log.error("WebSocket upgrade failed", {
        error: error instanceof Error ? error : String(error),
      });
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
  }

  /**
   * Handle WebSocket message (with hibernation support).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.ensureInitialized();
    if (typeof message !== "string") return;

    const tags = this.ctx.getTags(ws);
    if (tags.includes("sandbox")) {
      await this.handleSandboxMessage(ws, message);
    } else {
      await this.handleClientMessage(ws, message);
    }
  }

  /**
   * Handle WebSocket close.
   */
  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    this.ensureInitialized();
    const tags = this.ctx.getTags(ws);

    if (tags.includes("sandbox")) {
      this.sandboxWs = null;
      this.updateSandboxStatus("stopped");
    } else {
      const client = this.clients.get(ws);
      this.clients.delete(ws);

      if (client) {
        this.broadcast({ type: "presence_leave", userId: client.userId });
      }
    }
  }

  /**
   * Handle WebSocket error.
   */
  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    this.ensureInitialized();
    this.log.error("WebSocket error", { error });
    ws.close(1011, "Internal error");
  }

  /**
   * Enforce authentication timeout for client WebSockets.
   *
   * This method is called via ctx.waitUntil() after a client WebSocket is accepted.
   * It waits for the auth timeout period, then checks if the connection has been
   * authenticated (i.e., the client sent a valid 'subscribe' message).
   *
   * If the connection is still unauthenticated after the timeout, it is closed.
   * This prevents DoS attacks where attackers open many WebSocket connections
   * without ever completing the authentication handshake.
   *
   * @param ws - The WebSocket to check
   * @param wsId - The unique WebSocket ID for logging
   */
  private async enforceAuthTimeout(ws: WebSocket, wsId: string): Promise<void> {
    // Wait for the authentication timeout period
    await new Promise((resolve) => setTimeout(resolve, WS_AUTH_TIMEOUT_MS));

    // Check if the WebSocket is still open
    if (ws.readyState !== WebSocket.OPEN) {
      return; // Already closed, nothing to do
    }

    // Check if this WebSocket has been authenticated
    // An authenticated WebSocket will be in the clients Map
    if (this.clients.has(ws)) {
      return; // Authenticated, nothing to do
    }

    // After hibernation, the clients Map may be empty
    // Try to recover client info from the database
    // If recovery succeeds, the client was authenticated before hibernation
    const tags = this.ctx.getTags(ws);
    const wsIdTag = tags.find((t) => t.startsWith("wsid:"));
    if (wsIdTag) {
      const tagWsId = wsIdTag.replace("wsid:", "");
      if (this.repository.hasWsClientMapping(tagWsId)) {
        return; // Was authenticated before hibernation
      }
    }

    // Connection is unauthenticated after timeout - close it
    this.log.warn("ws.connect", {
      event: "ws.connect",
      ws_type: "client",
      outcome: "auth_timeout",
      ws_id: wsId,
      timeout_ms: WS_AUTH_TIMEOUT_MS,
    });
    try {
      ws.close(4008, "Authentication timeout");
    } catch {
      // WebSocket may have been closed by the client
    }
  }

  /**
   * Durable Object alarm handler.
   *
   * Delegates to the lifecycle manager for inactivity and heartbeat monitoring.
   */
  async alarm(): Promise<void> {
    this.ensureInitialized();
    await this.lifecycleManager.handleAlarm();
  }

  /**
   * Update the last activity timestamp.
   * Delegates to the lifecycle manager.
   */
  private updateLastActivity(timestamp: number): void {
    this.lifecycleManager.updateLastActivity(timestamp);
  }

  /**
   * Schedule the inactivity check alarm.
   * Delegates to the lifecycle manager.
   */
  private async scheduleInactivityCheck(): Promise<void> {
    await this.lifecycleManager.scheduleInactivityCheck();
  }

  /**
   * Trigger a filesystem snapshot of the sandbox.
   * Delegates to the lifecycle manager.
   */
  private async triggerSnapshot(reason: string): Promise<void> {
    await this.lifecycleManager.triggerSnapshot(reason);
  }

  /**
   * Handle messages from sandbox.
   */
  private async handleSandboxMessage(ws: WebSocket, message: string): Promise<void> {
    // Recover sandbox WebSocket reference after hibernation
    if (!this.sandboxWs || this.sandboxWs !== ws) {
      this.sandboxWs = ws;
    }

    try {
      const event = JSON.parse(message) as SandboxEvent;
      await this.processSandboxEvent(event);
    } catch (e) {
      this.log.error("Error processing sandbox message", {
        error: e instanceof Error ? e : String(e),
      });
    }
  }

  /**
   * Handle messages from clients.
   */
  private async handleClientMessage(ws: WebSocket, message: string): Promise<void> {
    try {
      const data = JSON.parse(message) as ClientMessage;

      switch (data.type) {
        case "ping":
          this.safeSend(ws, { type: "pong", timestamp: Date.now() });
          break;

        case "subscribe":
          await this.handleSubscribe(ws, data);
          break;

        case "prompt":
          await this.handlePromptMessage(ws, data);
          break;

        case "stop":
          await this.stopExecution();
          break;

        case "typing":
          await this.handleTyping();
          break;

        case "presence":
          await this.updatePresence(ws, data);
          break;
      }
    } catch (e) {
      this.log.error("Error processing client message", {
        error: e instanceof Error ? e : String(e),
      });
      this.safeSend(ws, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Failed to process message",
      });
    }
  }

  /**
   * Handle client subscription with token validation.
   */
  private async handleSubscribe(
    ws: WebSocket,
    data: { token: string; clientId: string }
  ): Promise<void> {
    // Validate the WebSocket auth token
    if (!data.token) {
      this.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "auth_failed",
        reject_reason: "no_token",
      });
      ws.close(4001, "Authentication required");
      return;
    }

    // Hash the incoming token and look up participant
    const tokenHash = await hashToken(data.token);
    const participant = this.getParticipantByWsTokenHash(tokenHash);

    if (!participant) {
      this.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "auth_failed",
        reject_reason: "invalid_token",
      });
      ws.close(4001, "Invalid authentication token");
      return;
    }

    this.log.info("ws.connect", {
      event: "ws.connect",
      ws_type: "client",
      outcome: "success",
      participant_id: participant.id,
      user_id: participant.user_id,
      client_id: data.clientId,
    });

    // Build client info from participant data
    const clientInfo: ClientInfo = {
      participantId: participant.id,
      userId: participant.user_id,
      name: participant.github_name || participant.github_login || participant.user_id,
      avatar: getGitHubAvatarUrl(participant.github_login),
      status: "active",
      lastSeen: Date.now(),
      clientId: data.clientId,
      ws,
    };

    this.clients.set(ws, clientInfo);

    // Store WebSocket to participant mapping for hibernation recovery
    // Get the ws_id from the WebSocket's tags
    const wsTags = this.ctx.getTags(ws);
    const wsIdTag = wsTags.find((t) => t.startsWith("wsid:"));
    if (wsIdTag) {
      const wsId = wsIdTag.replace("wsid:", "");
      const now = Date.now();
      // Upsert the mapping (in case of reconnection)
      this.repository.upsertWsClientMapping({
        wsId,
        participantId: participant.id,
        clientId: data.clientId,
        createdAt: now,
      });
      this.log.debug("Stored ws_client_mapping", { ws_id: wsId, participant_id: participant.id });
    }

    // Set auto-response for ping/pong during hibernation
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "pong", timestamp: Date.now() })
      )
    );

    // Send session state with current participant info
    const state = this.getSessionState();
    this.safeSend(ws, {
      type: "subscribed",
      sessionId: state.id,
      state,
      participantId: participant.id,
      participant: {
        participantId: participant.id,
        name: participant.github_name || participant.github_login || participant.user_id,
        avatar: getGitHubAvatarUrl(participant.github_login),
      },
    } as ServerMessage);

    const sandbox = this.getSandbox();
    if (sandbox?.last_spawn_error) {
      this.safeSend(ws, { type: "sandbox_error", error: sandbox.last_spawn_error });
    }

    // Send historical events (messages and sandbox events)
    this.sendHistoricalEvents(ws);

    // Send current presence
    this.sendPresence(ws);

    // Notify others
    this.broadcastPresence();
  }

  /**
   * Send historical events to a newly connected client.
   */
  private sendHistoricalEvents(ws: WebSocket): void {
    // Get messages with participant info (user prompts)
    const messages = this.repository.getMessagesWithParticipants(100);

    // Get events (tool calls, tokens, etc.)
    const events = this.repository.getEventsForReplay(500);

    // Combine and sort by timestamp
    interface HistoryItem {
      type: "message" | "event";
      timestamp: number;
      data: MessageWithParticipant | EventRow;
    }

    const combined: HistoryItem[] = [
      ...messages.map((m) => ({ type: "message" as const, timestamp: m.created_at, data: m })),
      ...events.map((e) => ({ type: "event" as const, timestamp: e.created_at, data: e })),
    ];

    // Sort by timestamp ascending
    combined.sort((a, b) => a.timestamp - b.timestamp);

    // Send in chronological order
    for (const item of combined) {
      if (item.type === "message") {
        const msg = item.data as MessageWithParticipant;
        this.safeSend(ws, {
          type: "sandbox_event",
          event: {
            type: "user_message",
            content: msg.content,
            messageId: msg.id,
            timestamp: msg.created_at / 1000, // Convert to seconds
            author: msg.participant_id
              ? {
                  participantId: msg.participant_id,
                  name: msg.github_name || msg.github_login || "Unknown",
                  avatar: getGitHubAvatarUrl(msg.github_login),
                }
              : undefined,
          },
        });
      } else {
        const event = item.data as EventRow;
        try {
          const eventData = JSON.parse(event.data);
          this.safeSend(ws, {
            type: "sandbox_event",
            event: eventData,
          });
        } catch {
          // Skip malformed events
        }
      }
    }
  }

  /**
   * Get client info for a WebSocket, reconstructing from storage if needed after hibernation.
   */
  private getClientInfo(ws: WebSocket): ClientInfo | null {
    // First check in-memory cache
    let client = this.clients.get(ws);
    if (client) return client;

    // After hibernation, the Map is empty but WebSocket is still valid
    // Try to recover client info from the database using ws_id tag
    const tags = this.ctx.getTags(ws);
    if (!tags.includes("sandbox")) {
      // This is a client WebSocket that survived hibernation
      // Try to recover from ws_client_mapping table
      const wsIdTag = tags.find((t) => t.startsWith("wsid:"));
      if (wsIdTag) {
        const wsId = wsIdTag.replace("wsid:", "");
        const mapping = this.repository.getWsClientMapping(wsId);

        if (mapping) {
          this.log.info("Recovered client info from DB", { ws_id: wsId, user_id: mapping.user_id });
          client = {
            participantId: mapping.participant_id,
            userId: mapping.user_id,
            name: mapping.github_name || mapping.github_login || mapping.user_id,
            avatar: getGitHubAvatarUrl(mapping.github_login),
            status: "active",
            lastSeen: Date.now(),
            clientId: mapping.client_id || `client-${Date.now()}`,
            ws,
          };
          this.clients.set(ws, client);
          return client;
        }
      }

      // No mapping found - client must reconnect with valid auth
      this.log.warn("No client mapping found after hibernation, closing WebSocket");
      ws.close(4002, "Session expired, please reconnect");
      return null;
    }

    return null;
  }

  /**
   * Handle prompt message from client.
   */
  private async handlePromptMessage(
    ws: WebSocket,
    data: {
      content: string;
      model?: string;
      attachments?: Array<{ type: string; name: string; url?: string; content?: string }>;
    }
  ): Promise<void> {
    const client = this.getClientInfo(ws);
    if (!client) {
      this.safeSend(ws, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: "Must subscribe first",
      });
      return;
    }

    const messageId = generateId();
    const now = Date.now();

    // Get or create participant
    let participant = this.getParticipantByUserId(client.userId);
    if (!participant) {
      participant = this.createParticipant(client.userId, client.name);
    }

    // Validate per-message model override if provided
    let messageModel: string | null = null;
    if (data.model) {
      if (isValidModel(data.model)) {
        messageModel = data.model;
      } else {
        this.log.warn("Invalid message model, ignoring override", { model: data.model });
      }
    }

    // Insert message with optional model override
    this.repository.createMessage({
      id: messageId,
      authorId: participant.id,
      content: data.content,
      source: "web",
      model: messageModel,
      attachments: data.attachments ? JSON.stringify(data.attachments) : null,
      status: "pending",
      createdAt: now,
    });

    // Get queue position
    const position = this.repository.getPendingOrProcessingCount();

    this.log.info("prompt.enqueue", {
      event: "prompt.enqueue",
      message_id: messageId,
      source: "web",
      author_id: participant.id,
      user_id: client.userId,
      model: messageModel,
      content_length: data.content.length,
      has_attachments: !!data.attachments?.length,
      attachments_count: data.attachments?.length ?? 0,
      queue_position: position,
    });

    // Confirm to sender
    this.safeSend(ws, {
      type: "prompt_queued",
      messageId,
      position,
    } as ServerMessage);

    // Process queue
    await this.processMessageQueue();
  }

  /**
   * Handle typing indicator (warm sandbox).
   */
  private async handleTyping(): Promise<void> {
    // If no sandbox or not connected, try to warm/spawn one
    if (!this.sandboxWs || this.sandboxWs.readyState !== WebSocket.OPEN) {
      if (!this.lifecycleManager.isSpawning()) {
        this.broadcast({ type: "sandbox_warming" });
        // Proactively spawn sandbox when user starts typing
        await this.spawnSandbox();
      }
    }
  }

  /**
   * Update client presence.
   */
  private async updatePresence(
    ws: WebSocket,
    data: { status: "active" | "idle"; cursor?: { line: number; file: string } }
  ): Promise<void> {
    const client = this.getClientInfo(ws);
    if (client) {
      client.status = data.status;
      client.lastSeen = Date.now();
      this.broadcastPresence();
    }
  }

  /**
   * Process sandbox event.
   */
  private async processSandboxEvent(event: SandboxEvent): Promise<void> {
    // Heartbeats and token streams are high-frequency — keep at debug to avoid noise
    // execution_complete is covered by the prompt.complete wide event below
    if (event.type === "heartbeat" || event.type === "token") {
      this.log.debug("Sandbox event", { event_type: event.type });
    } else if (event.type !== "execution_complete") {
      this.log.info("Sandbox event", { event_type: event.type });
    }
    const now = Date.now();
    const eventId = generateId();

    // Get messageId from the event first (sandbox sends correct messageId with every event)
    // Only fall back to DB lookup if event doesn't include messageId (legacy fallback)
    // This prevents race conditions where events from message A arrive after message B starts processing
    const eventMessageId = "messageId" in event ? event.messageId : null;
    const processingMessage = this.repository.getProcessingMessage();
    const messageId = eventMessageId ?? processingMessage?.id ?? null;

    // Store event
    this.repository.createEvent({
      id: eventId,
      type: event.type,
      data: JSON.stringify(event),
      messageId,
      createdAt: now,
    });

    // Handle specific event types
    if (event.type === "execution_complete") {
      // Use the resolved messageId (which now correctly prioritizes event.messageId)
      const completionMessageId = messageId ?? event.messageId;
      const status = event.success ? "completed" : "failed";

      if (completionMessageId) {
        this.repository.updateMessageCompletion(completionMessageId, status, now);

        // Emit prompt.complete wide event with duration metrics
        const timestamps = this.repository.getMessageTimestamps(completionMessageId);
        const totalDurationMs = timestamps ? now - timestamps.created_at : undefined;
        const processingDurationMs =
          timestamps?.started_at != null ? now - timestamps.started_at : undefined;
        const queueDurationMs =
          timestamps?.started_at != null
            ? timestamps.started_at - timestamps.created_at
            : undefined;

        this.log.info("prompt.complete", {
          event: "prompt.complete",
          message_id: completionMessageId,
          outcome: event.success ? "success" : "failure",
          message_status: status,
          total_duration_ms: totalDurationMs,
          processing_duration_ms: processingDurationMs,
          queue_duration_ms: queueDurationMs,
        });

        // Broadcast processing status change (after DB update so getIsProcessing is accurate)
        this.broadcast({ type: "processing_status", isProcessing: this.getIsProcessing() });

        // Notify slack-bot of completion (fire-and-forget with retry)
        this.ctx.waitUntil(this.notifySlackBot(completionMessageId, event.success));
      } else {
        this.log.warn("prompt.complete", {
          event: "prompt.complete",
          outcome: "error",
          error_reason: "no_message_id",
        });
      }

      // Take snapshot after execution completes (per Ramp spec)
      // "When the agent is finished making changes, we take another snapshot"
      // Use fire-and-forget so snapshot doesn't block the response to the user
      this.ctx.waitUntil(this.triggerSnapshot("execution_complete"));

      // Reset activity timer - give user time to review output before inactivity timeout
      this.updateLastActivity(now);
      await this.scheduleInactivityCheck();

      // Process next in queue
      await this.processMessageQueue();
    }

    if (event.type === "git_sync") {
      this.repository.updateSandboxGitSyncStatus(event.status);

      if (event.sha) {
        this.repository.updateSessionCurrentSha(event.sha);
      }
    }

    if (event.type === "heartbeat") {
      this.repository.updateSandboxHeartbeat(now);
      // Note: Don't schedule separate heartbeat alarm - it's handled in the main alarm()
      // which checks both inactivity and heartbeat health
    }

    // Handle push completion events
    if (event.type === "push_complete" || event.type === "push_error") {
      this.handlePushEvent(event);
    }

    // Broadcast to clients
    this.broadcast({ type: "sandbox_event", event });
  }

  /**
   * Push a branch to remote via the sandbox.
   * Sends push command to sandbox and waits for completion or error.
   *
   * @returns Success result or error message
   */
  private async pushBranchToRemote(
    branchName: string,
    repoOwner: string,
    repoName: string,
    githubToken?: string
  ): Promise<{ success: true } | { success: false; error: string }> {
    const sandboxWs = this.getSandboxWebSocket();

    if (!sandboxWs) {
      // No sandbox connected - user may have already pushed manually
      this.log.info("No sandbox connected, assuming branch was pushed manually");
      return { success: true };
    }

    // Create a promise that will be resolved when push_complete event arrives
    // Use normalized branch name for map key to handle case/whitespace differences
    const normalizedBranch = this.normalizeBranchName(branchName);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const pushPromise = new Promise<void>((resolve, reject) => {
      this.pendingPushResolvers.set(normalizedBranch, { resolve, reject });

      // Timeout after 180 seconds (3 minutes) - git push can take a while
      timeoutId = setTimeout(() => {
        if (this.pendingPushResolvers.has(normalizedBranch)) {
          this.pendingPushResolvers.delete(normalizedBranch);
          reject(new Error("Push operation timed out after 180 seconds"));
        }
      }, 180000);
    });

    // Tell sandbox to push the current branch
    // Pass GitHub App token for authentication (sandbox uses for git push)
    // User's OAuth token is NOT sent to sandbox - only used server-side for PR API
    this.log.info("Sending push command", { branch_name: branchName });
    this.safeSend(sandboxWs, {
      type: "push",
      branchName,
      repoOwner,
      repoName,
      githubToken,
    });

    // Wait for push_complete or push_error event
    try {
      await pushPromise;
      this.log.info("Push completed successfully", { branch_name: branchName });
      return { success: true };
    } catch (pushError) {
      this.log.error("Push failed", {
        branch_name: branchName,
        error: pushError instanceof Error ? pushError : String(pushError),
      });
      return { success: false, error: `Failed to push branch: ${pushError}` };
    } finally {
      // Clean up timeout to prevent memory leaks
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Handle push completion or error events from sandbox.
   * Resolves or rejects the pending push promise for the branch.
   */
  private handlePushEvent(event: SandboxEvent): void {
    const branchName = (event as { branchName?: string }).branchName;

    if (!branchName) {
      return;
    }

    const normalizedBranch = this.normalizeBranchName(branchName);
    const resolver = this.pendingPushResolvers.get(normalizedBranch);

    if (!resolver) {
      return;
    }

    if (event.type === "push_complete") {
      this.log.info("Push completed, resolving promise", {
        branch_name: branchName,
        pending_resolvers: Array.from(this.pendingPushResolvers.keys()),
      });
      resolver.resolve();
    } else if (event.type === "push_error") {
      const error = (event as { error?: string }).error || "Push failed";
      this.log.warn("Push failed for branch", { branch_name: branchName, error });
      resolver.reject(new Error(error));
    }

    this.pendingPushResolvers.delete(normalizedBranch);
  }

  /**
   * Get the sandbox WebSocket, recovering from hibernation if needed.
   */
  private getSandboxWebSocket(): WebSocket | null {
    // First check in-memory reference
    if (this.sandboxWs && this.sandboxWs.readyState === WebSocket.OPEN) {
      return this.sandboxWs;
    }

    // After hibernation, try to recover from ctx.getWebSockets()
    // Validate sandbox ID to prevent wrong sandbox connections
    const sandbox = this.getSandbox();
    const expectedSandboxId = sandbox?.modal_sandbox_id;

    const allWebSockets = this.ctx.getWebSockets();
    for (const ws of allWebSockets) {
      const tags = this.ctx.getTags(ws);
      if (tags.includes("sandbox") && ws.readyState === WebSocket.OPEN) {
        // Validate sandbox ID if we have an expected one
        if (expectedSandboxId) {
          const sidTag = tags.find((t) => t.startsWith("sid:"));
          if (sidTag) {
            const tagSandboxId = sidTag.replace("sid:", "");
            if (tagSandboxId !== expectedSandboxId) {
              this.log.debug("Skipping WS with wrong sandbox ID", {
                tag_sandbox_id: tagSandboxId,
                expected_sandbox_id: expectedSandboxId,
              });
              continue;
            }
          }
        }
        this.log.info("Recovered sandbox WebSocket from hibernation");
        this.sandboxWs = ws;
        return ws;
      }
    }

    return null;
  }

  /**
   * Warm sandbox proactively.
   * Delegates to the lifecycle manager.
   */
  private async warmSandbox(): Promise<void> {
    await this.lifecycleManager.warmSandbox();
  }

  /**
   * Process message queue.
   */
  private async processMessageQueue(): Promise<void> {
    // Check if already processing
    if (this.repository.getProcessingMessage()) {
      this.log.debug("processMessageQueue: already processing, returning");
      return;
    }

    // Get next pending message
    const message = this.repository.getNextPendingMessage();
    if (!message) {
      return;
    }
    const now = Date.now();

    // Check if sandbox is connected (with hibernation recovery)
    const sandboxWs = this.getSandboxWebSocket();
    if (!sandboxWs) {
      // No sandbox connected - spawn one if not already spawning
      // spawnSandbox has its own persisted status check
      this.log.info("prompt.dispatch", {
        event: "prompt.dispatch",
        message_id: message.id,
        outcome: "deferred",
        reason: "no_sandbox",
      });
      this.broadcast({ type: "sandbox_spawning" });
      await this.spawnSandbox();
      // Don't mark as processing yet - wait for sandbox to connect
      return;
    }

    // Mark as processing
    this.repository.updateMessageToProcessing(message.id, now);

    // Broadcast processing status change (hardcoded true since we just set status above)
    this.broadcast({ type: "processing_status", isProcessing: true });

    // Reset activity timer - user is actively using the sandbox
    this.updateLastActivity(now);

    // Get author info (use toArray since author may not exist in participants table)
    const author = this.repository.getParticipantById(message.author_id);

    // Get session for default model
    const session = this.getSession();

    // Send to sandbox with model (per-message override or session default)
    const resolvedModel = message.model || session?.model || "claude-haiku-4-5";
    const command: SandboxCommand = {
      type: "prompt",
      messageId: message.id,
      content: message.content,
      model: resolvedModel,
      author: {
        userId: author?.user_id ?? "unknown",
        githubName: author?.github_name ?? null,
        githubEmail: author?.github_email ?? null,
      },
      attachments: message.attachments ? JSON.parse(message.attachments) : undefined,
    };

    const sent = this.safeSend(sandboxWs, command);

    this.log.info("prompt.dispatch", {
      event: "prompt.dispatch",
      message_id: message.id,
      outcome: sent ? "sent" : "send_failed",
      model: resolvedModel,
      author_id: message.author_id,
      user_id: author?.user_id ?? "unknown",
      source: message.source,
      has_sandbox_ws: true,
      sandbox_ready_state: sandboxWs.readyState,
      queue_wait_ms: now - message.created_at,
      has_attachments: !!message.attachments,
    });
  }

  /**
   * Spawn a sandbox via Modal.
   * Delegates to the lifecycle manager.
   */
  private async spawnSandbox(): Promise<void> {
    await this.lifecycleManager.spawnSandbox();
  }

  /**
   * Stop current execution.
   * Sends stop command to sandbox, which should respond with execution_complete.
   * The processing status will be updated when execution_complete is received.
   */
  private async stopExecution(): Promise<void> {
    if (this.sandboxWs) {
      this.safeSend(this.sandboxWs, { type: "stop" });
    }
  }

  /**
   * Broadcast message to all connected clients.
   */
  private broadcast(message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (!tags.includes("sandbox")) {
        this.safeSend(ws, message);
      }
    }
  }

  /**
   * Send presence info to a specific client.
   */
  private sendPresence(ws: WebSocket): void {
    const participants = this.getPresenceList();
    this.safeSend(ws, { type: "presence_sync", participants });
  }

  /**
   * Broadcast presence to all clients.
   */
  private broadcastPresence(): void {
    const participants = this.getPresenceList();
    this.broadcast({ type: "presence_update", participants });
  }

  /**
   * Get list of present participants.
   */
  private getPresenceList(): ParticipantPresence[] {
    return Array.from(this.clients.values()).map((c) => ({
      participantId: c.participantId,
      userId: c.userId,
      name: c.name,
      avatar: c.avatar,
      status: c.status,
      lastSeen: c.lastSeen,
    }));
  }

  /**
   * Get current session state.
   */
  private getSessionState(): SessionState {
    const session = this.getSession();
    const sandbox = this.getSandbox();
    const messageCount = this.getMessageCount();
    const isProcessing = this.getIsProcessing();

    return {
      id: session?.id ?? this.ctx.id.toString(),
      title: session?.title ?? null,
      repoOwner: session?.repo_owner ?? "",
      repoName: session?.repo_name ?? "",
      branchName: session?.branch_name ?? null,
      status: session?.status ?? "created",
      sandboxStatus: sandbox?.status ?? "pending",
      messageCount,
      createdAt: session?.created_at ?? Date.now(),
      model: session?.model ?? DEFAULT_MODEL,
      isProcessing,
    };
  }

  /**
   * Check if any message is currently being processed.
   */
  private getIsProcessing(): boolean {
    return this.repository.getProcessingMessage() !== null;
  }

  // Database helpers

  private getSession(): SessionRow | null {
    return this.repository.getSession();
  }

  private getSandbox(): SandboxRow | null {
    return this.repository.getSandbox();
  }

  private async ensureRepoId(session: SessionRow): Promise<number> {
    if (session.repo_id) {
      return session.repo_id;
    }

    const appConfig = getGitHubAppConfig(this.env);
    if (!appConfig) {
      throw new Error("GitHub App not configured");
    }

    const repo = await getInstallationRepository(appConfig, session.repo_owner, session.repo_name);
    if (!repo) {
      throw new Error("Repository is not installed for the GitHub App");
    }

    this.repository.updateSessionRepoId(repo.id);
    return repo.id;
  }

  private async getUserEnvVars(): Promise<Record<string, string> | undefined> {
    const session = this.getSession();
    if (!session) {
      this.log.warn("Cannot load secrets: no session");
      return undefined;
    }

    if (!this.env.DB || !this.env.REPO_SECRETS_ENCRYPTION_KEY) {
      this.log.debug("Secrets not configured, skipping", {
        has_db: !!this.env.DB,
        has_encryption_key: !!this.env.REPO_SECRETS_ENCRYPTION_KEY,
      });
      return undefined;
    }

    let repoId: number;
    try {
      repoId = await this.ensureRepoId(session);
    } catch (e) {
      this.log.warn("Cannot resolve repo ID for secrets, proceeding without", {
        repo_owner: session.repo_owner,
        repo_name: session.repo_name,
        error: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }

    const store = new RepoSecretsStore(this.env.DB, this.env.REPO_SECRETS_ENCRYPTION_KEY);

    try {
      const secrets = await store.getDecryptedSecrets(repoId);
      return Object.keys(secrets).length === 0 ? undefined : secrets;
    } catch (e) {
      this.log.error("Failed to load repo secrets, proceeding without", {
        repo_id: repoId,
        error: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }
  }

  /**
   * Verify a sandbox authentication token.
   * Called by the router to validate sandbox-originated requests.
   */
  private async handleVerifySandboxToken(request: Request): Promise<Response> {
    const body = (await request.json()) as { token: string };

    if (!body.token) {
      return new Response(JSON.stringify({ valid: false, error: "Missing token" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const sandbox = this.getSandbox();
    if (!sandbox) {
      this.log.warn("Sandbox token verification failed: no sandbox");
      return new Response(JSON.stringify({ valid: false, error: "No sandbox" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Check if sandbox is in an active state
    if (sandbox.status === "stopped" || sandbox.status === "stale") {
      this.log.warn("Sandbox token verification failed: sandbox is stopped/stale", {
        status: sandbox.status,
      });
      return new Response(JSON.stringify({ valid: false, error: "Sandbox stopped" }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate the token
    if (body.token !== sandbox.auth_token) {
      this.log.warn("Sandbox token verification failed: token mismatch");
      return new Response(JSON.stringify({ valid: false, error: "Invalid token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    this.log.info("Sandbox token verified successfully");
    return new Response(JSON.stringify({ valid: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  private getMessageCount(): number {
    return this.repository.getMessageCount();
  }

  private getParticipantByUserId(userId: string): ParticipantRow | null {
    return this.repository.getParticipantByUserId(userId);
  }

  private createParticipant(userId: string, name: string): ParticipantRow {
    const id = generateId();
    const now = Date.now();

    this.repository.createParticipant({
      id,
      userId,
      githubName: name,
      role: "member",
      joinedAt: now,
    });

    return {
      id,
      user_id: userId,
      github_user_id: null,
      github_login: null,
      github_email: null,
      github_name: name,
      role: "member",
      github_access_token_encrypted: null,
      github_refresh_token_encrypted: null,
      github_token_expires_at: null,
      ws_auth_token: null,
      ws_token_created_at: null,
      joined_at: now,
    };
  }

  private updateSandboxStatus(status: string): void {
    this.repository.updateSandboxStatus(status as SandboxStatus);
  }

  /**
   * Generate HMAC signature for callback payload.
   */
  private async signCallback(data: object, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureData = encoder.encode(JSON.stringify(data));
    const sig = await crypto.subtle.sign("HMAC", key, signatureData);
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Notify slack-bot of completion with retry.
   * Uses service binding for reliable internal communication.
   */
  private async notifySlackBot(messageId: string, success: boolean): Promise<void> {
    // Safely query for callback context
    const message = this.repository.getMessageCallbackContext(messageId);
    if (!message?.callback_context) {
      this.log.debug("No callback context for message, skipping notification", {
        message_id: messageId,
      });
      return;
    }
    if (!this.env.SLACK_BOT || !this.env.INTERNAL_CALLBACK_SECRET) {
      this.log.debug("SLACK_BOT or INTERNAL_CALLBACK_SECRET not configured, skipping notification");
      return;
    }

    const session = this.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();

    const context = JSON.parse(message.callback_context);
    const timestamp = Date.now();

    // Build payload without signature
    const payloadData = {
      sessionId,
      messageId,
      success,
      timestamp,
      context,
    };

    // Sign the payload
    const signature = await this.signCallback(payloadData, this.env.INTERNAL_CALLBACK_SECRET);

    const payload = { ...payloadData, signature };

    // Try with retry (max 2 attempts)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.env.SLACK_BOT.fetch("https://internal/callbacks/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          this.log.info("Slack callback succeeded", { message_id: messageId });
          return;
        }

        const responseText = await response.text();
        this.log.error("Slack callback failed", {
          message_id: messageId,
          status: response.status,
          response_text: responseText,
        });
      } catch (e) {
        this.log.error("Slack callback attempt failed", {
          message_id: messageId,
          attempt: attempt + 1,
          error: e instanceof Error ? e : String(e),
        });
      }

      // Wait before retry
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    this.log.error("Failed to notify slack-bot after retries", { message_id: messageId });
  }

  /**
   * Check if a participant's GitHub token is expired.
   * Returns true if expired or will expire within buffer time.
   */
  private isGitHubTokenExpired(participant: ParticipantRow, bufferMs = 60000): boolean {
    if (!participant.github_token_expires_at) {
      return false; // No expiration set, assume valid
    }
    return Date.now() + bufferMs >= participant.github_token_expires_at;
  }

  /**
   * Refresh an expired GitHub access token using the stored refresh token.
   *
   * Returns the updated participant row, or null if refresh cannot be performed.
   */
  private async refreshParticipantToken(
    participant: ParticipantRow
  ): Promise<ParticipantRow | null> {
    if (!participant.github_refresh_token_encrypted) {
      this.log.warn("Cannot refresh: no refresh token stored", { user_id: participant.user_id });
      return null;
    }

    if (!this.env.GITHUB_CLIENT_ID || !this.env.GITHUB_CLIENT_SECRET) {
      this.log.warn("Cannot refresh: GitHub OAuth credentials not configured");
      return null;
    }

    try {
      const refreshToken = await decryptToken(
        participant.github_refresh_token_encrypted,
        this.env.TOKEN_ENCRYPTION_KEY
      );

      const newTokens = await refreshAccessToken(refreshToken, {
        clientId: this.env.GITHUB_CLIENT_ID,
        clientSecret: this.env.GITHUB_CLIENT_SECRET,
        encryptionKey: this.env.TOKEN_ENCRYPTION_KEY,
      });

      const newAccessTokenEncrypted = await encryptToken(
        newTokens.access_token,
        this.env.TOKEN_ENCRYPTION_KEY
      );

      const newRefreshTokenEncrypted = newTokens.refresh_token
        ? await encryptToken(newTokens.refresh_token, this.env.TOKEN_ENCRYPTION_KEY)
        : null;

      const newExpiresAt = newTokens.expires_in
        ? Date.now() + newTokens.expires_in * 1000
        : Date.now() + 8 * 60 * 60 * 1000;

      this.repository.updateParticipantTokens(participant.id, {
        githubAccessTokenEncrypted: newAccessTokenEncrypted,
        githubRefreshTokenEncrypted: newRefreshTokenEncrypted,
        githubTokenExpiresAt: newExpiresAt,
      });

      this.log.info("Server-side token refresh succeeded", { user_id: participant.user_id });

      return this.repository.getParticipantById(participant.id);
    } catch (error) {
      this.log.error("Server-side token refresh failed", {
        user_id: participant.user_id,
        error: error instanceof Error ? error : String(error),
      });
      return null;
    }
  }

  /**
   * Get the prompting user for PR creation.
   * Returns the participant who triggered the currently processing message.
   */
  private async getPromptingUserForPR(): Promise<
    | { user: ParticipantRow; error?: never; status?: never }
    | { user?: never; error: string; status: number }
  > {
    // Find the currently processing message
    const processingMessage = this.repository.getProcessingMessageAuthor();

    if (!processingMessage) {
      this.log.warn("PR creation failed: no processing message found");
      return {
        error: "No active prompt found. PR creation must be triggered by a user prompt.",
        status: 400,
      };
    }

    const participantId = processingMessage.author_id;

    // Get the participant record
    let participant = this.repository.getParticipantById(participantId);

    if (!participant) {
      this.log.warn("PR creation failed: participant not found", { participantId });
      return { error: "User not found. Please re-authenticate.", status: 401 };
    }

    if (!participant.github_access_token_encrypted) {
      this.log.warn("PR creation failed: no GitHub token", { userId: participant.user_id });
      return {
        error:
          "Your GitHub token is not available for PR creation. Please reconnect to the session to re-authenticate.",
        status: 401,
      };
    }

    if (this.isGitHubTokenExpired(participant)) {
      this.log.warn("GitHub token expired, attempting server-side refresh", {
        userId: participant.user_id,
      });

      const refreshed = await this.refreshParticipantToken(participant);
      if (refreshed) {
        participant = refreshed;
      } else {
        return {
          error:
            "Your GitHub token has expired and could not be refreshed. Please re-authenticate.",
          status: 401,
        };
      }
    }

    return { user: participant };
  }

  // HTTP handlers

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      sessionName: string; // The name used for WebSocket routing
      repoOwner: string;
      repoName: string;
      repoId?: number;
      title?: string;
      model?: string; // LLM model to use
      userId: string;
      githubLogin?: string;
      githubName?: string;
      githubEmail?: string;
      githubToken?: string | null; // Plain GitHub token (will be encrypted)
      githubTokenEncrypted?: string | null; // Pre-encrypted GitHub token
    };

    const sessionId = this.ctx.id.toString();
    const sessionName = body.sessionName; // Store the WebSocket routing name
    const now = Date.now();

    // Encrypt the GitHub token if provided in plain text
    let encryptedToken = body.githubTokenEncrypted ?? null;
    if (body.githubToken && this.env.TOKEN_ENCRYPTION_KEY) {
      try {
        const { encryptToken } = await import("../auth/crypto");
        encryptedToken = await encryptToken(body.githubToken, this.env.TOKEN_ENCRYPTION_KEY);
        this.log.debug("Encrypted GitHub token for storage");
      } catch (err) {
        this.log.error("Failed to encrypt GitHub token", {
          error: err instanceof Error ? err : String(err),
        });
      }
    }

    // Validate model name if provided
    const model = body.model && isValidModel(body.model) ? body.model : DEFAULT_MODEL;
    if (body.model && !isValidModel(body.model)) {
      this.log.warn("Invalid model name, using default", {
        requested_model: body.model,
        default_model: DEFAULT_MODEL,
      });
    }

    // Create session (store both internal ID and external name)
    this.repository.upsertSession({
      id: sessionId,
      sessionName, // Store the session name for WebSocket routing
      title: body.title ?? null,
      repoOwner: body.repoOwner,
      repoName: body.repoName,
      repoId: body.repoId ?? null,
      model,
      status: "created",
      createdAt: now,
      updatedAt: now,
    });

    // Create sandbox record
    // Note: created_at is set to 0 initially so the first spawn isn't blocked by cooldown
    // It will be updated to the actual spawn time when spawnSandbox() is called
    const sandboxId = generateId();
    this.repository.createSandbox({
      id: sandboxId,
      status: "pending",
      gitSyncStatus: "pending",
      createdAt: 0,
    });

    // Create owner participant with encrypted GitHub token
    const participantId = generateId();
    this.repository.createParticipant({
      id: participantId,
      userId: body.userId,
      githubLogin: body.githubLogin ?? null,
      githubName: body.githubName ?? null,
      githubEmail: body.githubEmail ?? null,
      githubAccessTokenEncrypted: encryptedToken,
      role: "owner",
      joinedAt: now,
    });

    this.log.info("Triggering sandbox spawn for new session");
    this.ctx.waitUntil(this.warmSandbox());

    return Response.json({ sessionId, status: "created" });
  }

  private handleGetState(): Response {
    const session = this.getSession();
    if (!session) {
      return new Response("Session not found", { status: 404 });
    }

    const sandbox = this.getSandbox();

    return Response.json({
      id: session.id,
      title: session.title,
      repoOwner: session.repo_owner,
      repoName: session.repo_name,
      repoDefaultBranch: session.repo_default_branch,
      branchName: session.branch_name,
      baseSha: session.base_sha,
      currentSha: session.current_sha,
      opencodeSessionId: session.opencode_session_id,
      status: session.status,
      model: session.model,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      sandbox: sandbox
        ? {
            id: sandbox.id,
            modalSandboxId: sandbox.modal_sandbox_id,
            status: sandbox.status,
            gitSyncStatus: sandbox.git_sync_status,
            lastHeartbeat: sandbox.last_heartbeat,
          }
        : null,
    });
  }

  private async handleEnqueuePrompt(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as {
        content: string;
        authorId: string;
        source: string;
        attachments?: Array<{ type: string; name: string; url?: string }>;
        callbackContext?: {
          channel: string;
          threadTs: string;
          repoFullName: string;
          model: string;
        };
      };

      // Get or create participant for the author
      // The authorId here is a user ID (like "anonymous"), not a participant row ID
      let participant = this.getParticipantByUserId(body.authorId);
      if (!participant) {
        participant = this.createParticipant(body.authorId, body.authorId);
      }

      const messageId = generateId();
      const now = Date.now();

      this.repository.createMessage({
        id: messageId,
        authorId: participant.id, // Use the participant's row ID, not the user ID
        content: body.content,
        source: body.source as MessageSource,
        attachments: body.attachments ? JSON.stringify(body.attachments) : null,
        callbackContext: body.callbackContext ? JSON.stringify(body.callbackContext) : null,
        status: "pending",
        createdAt: now,
      });

      const queuePosition = this.repository.getPendingOrProcessingCount();

      this.log.info("prompt.enqueue", {
        event: "prompt.enqueue",
        message_id: messageId,
        source: body.source,
        author_id: participant.id,
        user_id: body.authorId,
        model: null,
        content_length: body.content.length,
        has_attachments: !!body.attachments?.length,
        attachments_count: body.attachments?.length ?? 0,
        has_callback_context: !!body.callbackContext,
        queue_position: queuePosition,
      });

      await this.processMessageQueue();

      return Response.json({ messageId, status: "queued" });
    } catch (error) {
      this.log.error("handleEnqueuePrompt error", {
        error: error instanceof Error ? error : String(error),
      });
      throw error;
    }
  }

  private handleStop(): Response {
    this.stopExecution();
    return Response.json({ status: "stopping" });
  }

  private async handleSandboxEvent(request: Request): Promise<Response> {
    const event = (await request.json()) as SandboxEvent;
    await this.processSandboxEvent(event);
    return Response.json({ status: "ok" });
  }

  private handleListParticipants(): Response {
    const participants = this.repository.listParticipants();

    return Response.json({
      participants: participants.map((p) => ({
        id: p.id,
        userId: p.user_id,
        githubLogin: p.github_login,
        githubName: p.github_name,
        role: p.role,
        joinedAt: p.joined_at,
      })),
    });
  }

  private async handleAddParticipant(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      userId: string;
      githubLogin?: string;
      githubName?: string;
      githubEmail?: string;
      role?: string;
    };

    const id = generateId();
    const now = Date.now();

    this.repository.createParticipant({
      id,
      userId: body.userId,
      githubLogin: body.githubLogin ?? null,
      githubName: body.githubName ?? null,
      githubEmail: body.githubEmail ?? null,
      role: (body.role ?? "member") as ParticipantRole,
      joinedAt: now,
    });

    return Response.json({ id, status: "added" });
  }

  private handleListEvents(url: URL): Response {
    const cursor = url.searchParams.get("cursor");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
    const type = url.searchParams.get("type");
    const messageId = url.searchParams.get("message_id");

    // Validate type parameter if provided
    if (type && !VALID_EVENT_TYPES.includes(type as (typeof VALID_EVENT_TYPES)[number])) {
      return Response.json({ error: `Invalid event type: ${type}` }, { status: 400 });
    }

    const events = this.repository.listEvents({ cursor, limit, type, messageId });
    const hasMore = events.length > limit;

    if (hasMore) events.pop();

    return Response.json({
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        data: JSON.parse(e.data),
        messageId: e.message_id,
        createdAt: e.created_at,
      })),
      cursor: events.length > 0 ? events[events.length - 1].created_at.toString() : undefined,
      hasMore,
    });
  }

  private handleListArtifacts(): Response {
    const artifacts = this.repository.listArtifacts();

    return Response.json({
      artifacts: artifacts.map((a) => ({
        id: a.id,
        type: a.type,
        url: a.url,
        metadata: a.metadata ? JSON.parse(a.metadata) : null,
        createdAt: a.created_at,
      })),
    });
  }

  private handleListMessages(url: URL): Response {
    const cursor = url.searchParams.get("cursor");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);
    const status = url.searchParams.get("status");

    // Validate status parameter if provided
    if (
      status &&
      !VALID_MESSAGE_STATUSES.includes(status as (typeof VALID_MESSAGE_STATUSES)[number])
    ) {
      return Response.json({ error: `Invalid message status: ${status}` }, { status: 400 });
    }

    const messages = this.repository.listMessages({ cursor, limit, status });
    const hasMore = messages.length > limit;

    if (hasMore) messages.pop();

    return Response.json({
      messages: messages.map((m) => ({
        id: m.id,
        authorId: m.author_id,
        content: m.content,
        source: m.source,
        status: m.status,
        createdAt: m.created_at,
        startedAt: m.started_at,
        completedAt: m.completed_at,
      })),
      cursor: messages.length > 0 ? messages[messages.length - 1].created_at.toString() : undefined,
      hasMore,
    });
  }

  /**
   * Handle PR creation request.
   * 1. Get prompting user's GitHub token (required, no fallback)
   * 2. Send push command to sandbox
   * 3. Create PR using GitHub API
   */
  private async handleCreatePR(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      title: string;
      body: string;
      baseBranch?: string;
    };

    const session = this.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Get the prompting user who will create the PR
    const promptingUser = await this.getPromptingUserForPR();
    if (!promptingUser.user) {
      return Response.json({ error: promptingUser.error }, { status: promptingUser.status });
    }

    this.log.info("Creating PR", { user_id: promptingUser.user.user_id });

    const user = promptingUser.user;

    try {
      // Decrypt the prompting user's GitHub token
      const accessToken = await decryptToken(
        user.github_access_token_encrypted!,
        this.env.TOKEN_ENCRYPTION_KEY
      );

      // Get repository info to determine default branch
      const repoInfo = await getRepository(accessToken, session.repo_owner, session.repo_name);

      const baseBranch = body.baseBranch || repoInfo.defaultBranch;
      const sessionId = session.session_name || session.id;
      const headBranch = generateBranchName(sessionId);

      // Generate GitHub App token for push (not user token)
      // User token is only used for PR API call below
      let pushToken: string | undefined;
      const appConfig = getGitHubAppConfig(this.env);
      if (appConfig) {
        try {
          pushToken = await generateInstallationToken(appConfig);
          this.log.info("Generated fresh GitHub App token for push");
        } catch (err) {
          this.log.error("Failed to generate app token, push may fail", {
            error: err instanceof Error ? err : String(err),
          });
        }
      }

      // Push branch to remote via sandbox
      const pushResult = await this.pushBranchToRemote(
        headBranch,
        session.repo_owner,
        session.repo_name,
        pushToken
      );

      if (!pushResult.success) {
        return Response.json({ error: pushResult.error }, { status: 500 });
      }

      // Append session link footer to agent's PR body
      const webAppUrl = this.env.WEB_APP_URL || this.env.WORKER_URL || "";
      const sessionUrl = `${webAppUrl}/session/${sessionId}`;
      const fullBody = body.body + `\n\n---\n*Created with [Open-Inspect](${sessionUrl})*`;

      // Create the PR using GitHub API (using the prompting user's token)
      const prResult = await createPullRequest(
        {
          accessTokenEncrypted: user.github_access_token_encrypted!,
          owner: session.repo_owner,
          repo: session.repo_name,
          title: body.title,
          body: fullBody,
          head: headBranch,
          base: baseBranch,
        },
        this.env.TOKEN_ENCRYPTION_KEY
      );

      // Store the PR as an artifact
      const artifactId = generateId();
      const now = Date.now();
      this.repository.createArtifact({
        id: artifactId,
        type: "pr",
        url: prResult.htmlUrl,
        metadata: JSON.stringify({
          number: prResult.number,
          state: prResult.state,
          head: headBranch,
          base: baseBranch,
        }),
        createdAt: now,
      });

      // Update session with branch name
      this.repository.updateSessionBranch(session.id, headBranch);

      // Broadcast PR creation to all clients
      this.broadcast({
        type: "artifact_created",
        artifact: {
          id: artifactId,
          type: "pr",
          url: prResult.htmlUrl,
          prNumber: prResult.number,
        },
      });

      return Response.json({
        prNumber: prResult.number,
        prUrl: prResult.htmlUrl,
        state: prResult.state,
      });
    } catch (error) {
      this.log.error("PR creation failed", {
        error: error instanceof Error ? error : String(error),
      });
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to create PR" },
        { status: 500 }
      );
    }
  }

  /**
   * Generate a WebSocket authentication token for a participant.
   *
   * This endpoint:
   * 1. Creates or updates a participant record
   * 2. Generates a 256-bit random token
   * 3. Stores the SHA-256 hash in the participant record
   * 4. Optionally stores encrypted GitHub token for PR creation
   * 5. Returns the plain token to the caller
   */
  private async handleGenerateWsToken(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      userId: string;
      githubUserId?: string;
      githubLogin?: string;
      githubName?: string;
      githubEmail?: string;
      githubTokenEncrypted?: string | null; // Encrypted GitHub OAuth token for PR creation
      githubRefreshTokenEncrypted?: string | null; // Encrypted GitHub OAuth refresh token
      githubTokenExpiresAt?: number | null; // Token expiry timestamp in milliseconds
    };

    if (!body.userId) {
      return Response.json({ error: "userId is required" }, { status: 400 });
    }

    const now = Date.now();

    // Check if participant exists
    let participant = this.getParticipantByUserId(body.userId);

    if (participant) {
      // Only accept client tokens if they're newer than what we have in the DB.
      // The server-side refresh may have rotated tokens, and the client could
      // be sending stale values from an old session cookie.
      const clientExpiresAt = body.githubTokenExpiresAt ?? null;
      const dbExpiresAt = participant.github_token_expires_at;
      const clientSentAnyToken =
        body.githubTokenEncrypted != null || body.githubRefreshTokenEncrypted != null;

      const shouldUpdateTokens =
        clientSentAnyToken &&
        (dbExpiresAt == null || (clientExpiresAt != null && clientExpiresAt >= dbExpiresAt));

      // If we already have a refresh token (server-side refresh may rotate it),
      // only accept an incoming refresh token when we're also accepting the
      // access token update, or when we don't have one yet.
      const shouldUpdateRefreshToken =
        body.githubRefreshTokenEncrypted != null &&
        (participant.github_refresh_token_encrypted == null || shouldUpdateTokens);

      this.repository.updateParticipantCoalesce(participant.id, {
        githubUserId: body.githubUserId ?? null,
        githubLogin: body.githubLogin ?? null,
        githubName: body.githubName ?? null,
        githubEmail: body.githubEmail ?? null,
        githubAccessTokenEncrypted: shouldUpdateTokens ? (body.githubTokenEncrypted ?? null) : null,
        githubRefreshTokenEncrypted: shouldUpdateRefreshToken
          ? (body.githubRefreshTokenEncrypted ?? null)
          : null,
        githubTokenExpiresAt: shouldUpdateTokens ? clientExpiresAt : null,
      });
    } else {
      // Create new participant with optional GitHub token
      const id = generateId();
      this.repository.createParticipant({
        id,
        userId: body.userId,
        githubUserId: body.githubUserId ?? null,
        githubLogin: body.githubLogin ?? null,
        githubName: body.githubName ?? null,
        githubEmail: body.githubEmail ?? null,
        githubAccessTokenEncrypted: body.githubTokenEncrypted ?? null,
        githubRefreshTokenEncrypted: body.githubRefreshTokenEncrypted ?? null,
        githubTokenExpiresAt: body.githubTokenExpiresAt ?? null,
        role: "member",
        joinedAt: now,
      });
      participant = this.getParticipantByUserId(body.userId)!;
    }

    // Generate a new WebSocket token (32 bytes = 256 bits)
    const plainToken = generateId(32);
    const tokenHash = await hashToken(plainToken);

    // Store the hash (invalidates any previous token)
    this.repository.updateParticipantWsToken(participant.id, tokenHash, now);

    this.log.info("Generated WS token", { participant_id: participant.id, user_id: body.userId });

    return Response.json({
      token: plainToken,
      participantId: participant.id,
    });
  }

  /**
   * Get participant by WebSocket token hash.
   */
  private getParticipantByWsTokenHash(tokenHash: string): ParticipantRow | null {
    return this.repository.getParticipantByWsTokenHash(tokenHash);
  }

  /**
   * Handle archive session request.
   * Sets session status to "archived" and broadcasts to all clients.
   * Only session participants are authorized to archive.
   */
  private async handleArchive(request: Request): Promise<Response> {
    const session = this.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Verify user is a participant (fail closed)
    let body: { userId?: string };
    try {
      body = (await request.json()) as { userId?: string };
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (!body.userId) {
      return Response.json({ error: "userId is required" }, { status: 400 });
    }

    const participant = this.getParticipantByUserId(body.userId);
    if (!participant) {
      return Response.json({ error: "Not authorized to archive this session" }, { status: 403 });
    }

    const now = Date.now();
    this.repository.updateSessionStatus(session.id, "archived", now);

    // Broadcast status change to all connected clients
    this.broadcast({
      type: "session_status",
      status: "archived",
    });

    return Response.json({ status: "archived" });
  }

  /**
   * Handle unarchive session request.
   * Restores session status to "active" and broadcasts to all clients.
   * Only session participants are authorized to unarchive.
   */
  private async handleUnarchive(request: Request): Promise<Response> {
    const session = this.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Verify user is a participant (fail closed)
    let body: { userId?: string };
    try {
      body = (await request.json()) as { userId?: string };
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (!body.userId) {
      return Response.json({ error: "userId is required" }, { status: 400 });
    }

    const participant = this.getParticipantByUserId(body.userId);
    if (!participant) {
      return Response.json({ error: "Not authorized to unarchive this session" }, { status: 403 });
    }

    const now = Date.now();
    this.repository.updateSessionStatus(session.id, "active", now);

    // Broadcast status change to all connected clients
    this.broadcast({
      type: "session_status",
      status: "active",
    });

    return Response.json({ status: "active" });
  }
}
