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
import { generateId, hashToken } from "../auth/crypto";
import { getGitHubAppConfig, getInstallationRepository } from "../auth/github-app";
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
import {
  createSourceControlProvider as createSourceControlProviderImpl,
  resolveScmProviderFromEnv,
  type SourceControlProvider,
  type GitPushSpec,
} from "../source-control";
import {
  DEFAULT_MODEL,
  isValidModel,
  isValidReasoningEffort,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
} from "../utils/models";
import type {
  Env,
  ClientInfo,
  ClientMessage,
  ServerMessage,
  SandboxEvent,
  SessionState,
  SandboxStatus,
  MessageSource,
  ParticipantRole,
} from "../types";
import type { SessionRow, ParticipantRow, ArtifactRow, SandboxRow, SandboxCommand } from "./types";
import { SessionRepository } from "./repository";
import { SessionWebSocketManagerImpl, type SessionWebSocketManager } from "./websocket-manager";
import { SessionPullRequestService } from "./pull-request-service";
import { shouldPersistToolCallEvent } from "./event-persistence";
import { RepoSecretsStore } from "../db/repo-secrets";
import { SessionIndexStore } from "../db/session-index";
import { GlobalSecretsStore } from "../db/global-secrets";
import { mergeSecrets } from "../db/secrets-validation";
import { OpenAITokenRefreshService } from "./openai-token-refresh-service";
import { ParticipantService, getGitHubAvatarUrl } from "./participant-service";
import { CallbackNotificationService } from "./callback-notification-service";
import { PresenceService } from "./presence-service";

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
  "step_start",
  "step_finish",
  "execution_complete",
  "heartbeat",
  "push_complete",
  "push_error",
  "user_message",
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
  private initialized = false;
  private log: Logger;
  // WebSocket manager (lazily initialized like lifecycleManager)
  private _wsManager: SessionWebSocketManager | null = null;
  // Track pending push operations by branch name
  private pendingPushResolvers = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  // Lifecycle manager (lazily initialized)
  private _lifecycleManager: SandboxLifecycleManager | null = null;
  // Source control provider (lazily initialized)
  private _sourceControlProvider: SourceControlProvider | null = null;
  // Participant service (lazily initialized)
  private _participantService: ParticipantService | null = null;
  // Callback notification service (lazily initialized)
  private _callbackService: CallbackNotificationService | null = null;
  // Presence service (lazily initialized)
  private _presenceService: PresenceService | null = null;

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
    {
      method: "POST",
      path: "/internal/openai-token-refresh",
      handler: () => this.handleOpenAITokenRefresh(),
    },
  ];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.repository = new SessionRepository(this.sql);
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
   * Get the source control provider, creating it lazily if needed.
   */
  private get sourceControlProvider(): SourceControlProvider {
    if (!this._sourceControlProvider) {
      this._sourceControlProvider = this.createSourceControlProvider();
    }
    return this._sourceControlProvider;
  }

  /**
   * Get the participant service, creating it lazily if needed.
   */
  private get participantService(): ParticipantService {
    if (!this._participantService) {
      this._participantService = new ParticipantService({
        repository: this.repository,
        env: this.env,
        log: this.log,
        generateId: () => generateId(),
      });
    }
    return this._participantService;
  }

  /**
   * Get the callback notification service, creating it lazily if needed.
   */
  private get callbackService(): CallbackNotificationService {
    if (!this._callbackService) {
      this._callbackService = new CallbackNotificationService({
        repository: this.repository,
        env: this.env,
        log: this.log,
        getSessionId: () => {
          const session = this.getSession();
          return session?.session_name || session?.id || this.ctx.id.toString();
        },
      });
    }
    return this._callbackService;
  }

  /**
   * Get the presence service, creating it lazily if needed.
   */
  private get presenceService(): PresenceService {
    if (!this._presenceService) {
      this._presenceService = new PresenceService({
        getAuthenticatedClients: () => this.wsManager.getAuthenticatedClients(),
        getClientInfo: (ws) => this.getClientInfo(ws),
        broadcast: (msg) => this.broadcast(msg),
        send: (ws, msg) => this.safeSend(ws, msg),
        getSandboxSocket: () => this.wsManager.getSandboxSocket(),
        isSpawning: () => this.lifecycleManager.isSpawning(),
        spawnSandbox: () => this.spawnSandbox(),
        log: this.log,
      });
    }
    return this._presenceService;
  }

  /**
   * Get the WebSocket manager, creating it lazily if needed.
   * Lazy initialization ensures the logger has session_id context
   * (set by ensureInitialized()) by the time the manager is created.
   */
  private get wsManager(): SessionWebSocketManager {
    if (!this._wsManager) {
      this._wsManager = new SessionWebSocketManagerImpl(this.ctx, this.repository, this.log, {
        authTimeoutMs: WS_AUTH_TIMEOUT_MS,
      });
    }
    return this._wsManager;
  }

  /**
   * Create the source control provider.
   */
  private createSourceControlProvider(): SourceControlProvider {
    const appConfig = getGitHubAppConfig(this.env);
    const provider = resolveScmProviderFromEnv(this.env.SCM_PROVIDER);

    return createSourceControlProviderImpl({
      provider,
      github: {
        appConfig: appConfig ?? undefined,
      },
    });
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

    // WebSocket manager adapter — thin delegation to wsManager
    const wsManager: WebSocketManager = {
      getSandboxWebSocket: () => this.wsManager.getSandboxSocket(),
      closeSandboxWebSocket: (code, reason) => {
        const ws = this.wsManager.getSandboxSocket();
        if (ws) {
          this.wsManager.close(ws, code, reason);
          this.wsManager.clearSandboxSocket();
        }
      },
      sendToSandbox: (message) => {
        const ws = this.wsManager.getSandboxSocket();
        return ws ? this.wsManager.send(ws, message) : false;
      },
      getConnectedClientCount: () => this.wsManager.getConnectedClientCount(),
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

    // Resolve sessionId for lifecycle manager logging context
    const session = this.repository.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();

    const config = {
      ...DEFAULT_LIFECYCLE_CONFIG,
      controlPlaneUrl,
      model: DEFAULT_MODEL,
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
   * Safely send a message over a WebSocket.
   */
  private safeSend(ws: WebSocket, message: string | object): boolean {
    return this.wsManager.send(ws, message);
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
    this.wsManager.enableAutoPingPong();
  }

  /**
   * Handle incoming HTTP requests.
   */
  async fetch(request: Request): Promise<Response> {
    const fetchStart = performance.now();

    this.ensureInitialized();
    const initMs = performance.now() - fetchStart;

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
      const handlerStart = performance.now();
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
        const handlerMs = performance.now() - handlerStart;
        const totalMs = performance.now() - fetchStart;
        this.log.info("do.request", {
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

      const sandboxId = request.headers.get("X-Sandbox-ID");

      if (isSandbox) {
        const { replaced } = this.wsManager.acceptAndSetSandboxSocket(
          server,
          sandboxId ?? undefined
        );

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
          replaced_existing: replaced,
          duration_ms: Date.now() - now,
        });

        // Process any pending messages now that sandbox is connected
        this.processMessageQueue();
      } else {
        const wsId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        this.wsManager.acceptClientSocket(server, wsId);
        this.ctx.waitUntil(this.wsManager.enforceAuthTimeout(server, wsId));
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

    const { kind } = this.wsManager.classify(ws);
    if (kind === "sandbox") {
      await this.handleSandboxMessage(ws, message);
    } else {
      await this.handleClientMessage(ws, message);
    }
  }

  /**
   * Handle WebSocket close.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.ensureInitialized();
    const { kind } = this.wsManager.classify(ws);

    try {
      if (kind === "sandbox") {
        const wasActive = this.wsManager.clearSandboxSocketIfMatch(ws);
        if (!wasActive) {
          // sandboxWs points to a different socket — this close is for a replaced connection.
          this.log.debug("Ignoring close for replaced sandbox socket", { code });
          return;
        }

        const isNormalClose = code === 1000 || code === 1001;
        if (isNormalClose) {
          this.updateSandboxStatus("stopped");
        } else {
          // Abnormal close (e.g., 1006): leave status unchanged so the bridge can reconnect.
          // Schedule a heartbeat check to detect truly dead sandboxes.
          this.log.warn("Sandbox WebSocket abnormal close", {
            event: "sandbox.abnormal_close",
            code,
            reason,
          });
          await this.lifecycleManager.scheduleDisconnectCheck();
        }
      } else {
        const client = this.wsManager.removeClient(ws);
        if (client) {
          this.broadcast({ type: "presence_leave", userId: client.userId });
        }
      }
    } finally {
      // Reciprocate the peer close to complete the WebSocket close handshake.
      this.wsManager.close(ws, code, reason);
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
          await this.presenceService.handleTyping();
          break;

        case "fetch_history":
          this.handleFetchHistory(ws, data);
          break;

        case "presence":
          this.presenceService.updatePresence(ws, data);
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
    const participant = this.participantService.getByWsTokenHash(tokenHash);

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

    this.wsManager.setClient(ws, clientInfo);

    const parsed = this.wsManager.classify(ws);
    if (parsed.kind === "client" && parsed.wsId) {
      this.wsManager.persistClientMapping(parsed.wsId, participant.id, data.clientId);
      this.log.debug("Stored ws_client_mapping", {
        ws_id: parsed.wsId,
        participant_id: participant.id,
      });
    }

    // Gather session state and replay events, then send as a single message.
    // Fetch sandbox once and thread it through to avoid a redundant SQLite read.
    const sandbox = this.getSandbox();
    const state = this.getSessionState(sandbox);
    const replay = this.getReplayData();

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
      replay,
      spawnError: sandbox?.last_spawn_error ?? null,
    } as ServerMessage);

    // Send current presence
    this.presenceService.sendPresence(ws);

    // Notify others
    this.presenceService.broadcastPresence();
  }

  /**
   * Collect historical events for replay.
   * Returns parsed events and pagination metadata for inclusion in the subscribed message.
   */
  private getReplayData(): {
    events: SandboxEvent[];
    hasMore: boolean;
    cursor: { timestamp: number; id: string } | null;
  } {
    const REPLAY_LIMIT = 500;
    const rows = this.repository.getEventsForReplay(REPLAY_LIMIT);
    const hasMore = rows.length >= REPLAY_LIMIT;

    const events: SandboxEvent[] = [];
    for (const row of rows) {
      try {
        events.push(JSON.parse(row.data));
      } catch {
        // Skip malformed events
      }
    }

    const cursor = rows.length > 0 ? { timestamp: rows[0].created_at, id: rows[0].id } : null;

    return { events, hasMore, cursor };
  }

  /**
   * Get client info for a WebSocket, reconstructing from storage if needed after hibernation.
   */
  private getClientInfo(ws: WebSocket): ClientInfo | null {
    // 1. In-memory cache (manager)
    const cached = this.wsManager.getClient(ws);
    if (cached) return cached;

    // 2. DB recovery (manager handles tag parsing + DB lookup)
    const mapping = this.wsManager.recoverClientMapping(ws);
    if (!mapping) {
      this.log.warn("No client mapping found after hibernation, closing WebSocket");
      this.wsManager.close(ws, 4002, "Session expired, please reconnect");
      return null;
    }

    // 3. Build ClientInfo (DO owns domain logic)
    this.log.info("Recovered client info from DB", { user_id: mapping.user_id });
    const clientInfo: ClientInfo = {
      participantId: mapping.participant_id,
      userId: mapping.user_id,
      name: mapping.github_name || mapping.github_login || mapping.user_id,
      avatar: getGitHubAvatarUrl(mapping.github_login),
      status: "active",
      lastSeen: Date.now(),
      clientId: mapping.client_id || `client-${Date.now()}`,
      ws,
    };

    // 4. Re-cache
    this.wsManager.setClient(ws, clientInfo);
    return clientInfo;
  }

  /**
   * Handle prompt message from client.
   */
  private async handlePromptMessage(
    ws: WebSocket,
    data: {
      content: string;
      model?: string;
      reasoningEffort?: string;
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
    let participant = this.participantService.getByUserId(client.userId);
    if (!participant) {
      participant = this.participantService.create(client.userId, client.name);
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

    // Validate per-message reasoning effort if provided
    const effectiveModelForEffort = messageModel || this.getSession()?.model || DEFAULT_MODEL;
    const messageReasoningEffort = this.validateReasoningEffort(
      effectiveModelForEffort,
      data.reasoningEffort
    );

    // Insert message with optional model and reasoning effort overrides
    this.repository.createMessage({
      id: messageId,
      authorId: participant.id,
      content: data.content,
      source: "web",
      model: messageModel,
      reasoningEffort: messageReasoningEffort,
      attachments: data.attachments ? JSON.stringify(data.attachments) : null,
      status: "pending",
      createdAt: now,
    });

    this.writeUserMessageEvent(participant, data.content, messageId, now);

    // Get queue position
    const position = this.repository.getPendingOrProcessingCount();

    this.log.info("prompt.enqueue", {
      event: "prompt.enqueue",
      message_id: messageId,
      source: "web",
      author_id: participant.id,
      user_id: client.userId,
      model: messageModel,
      reasoning_effort: messageReasoningEffort,
      content_length: data.content.length,
      has_attachments: !!data.attachments?.length,
      attachments_count: data.attachments?.length ?? 0,
      queue_position: position,
    });

    // Background: update D1 timestamp so session bubbles to top of sidebar
    if (this.env.DB) {
      const store = new SessionIndexStore(this.env.DB);
      const sessionId = this.getSession()?.id;
      if (sessionId) {
        this.ctx.waitUntil(store.touchUpdatedAt(sessionId).catch(() => {}));
      }
    }

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
   * Handle fetch_history request from client for paginated history loading.
   */
  private handleFetchHistory(
    ws: WebSocket,
    data: { cursor?: { timestamp: number; id: string }; limit?: number }
  ): void {
    const client = this.getClientInfo(ws);
    if (!client) {
      this.safeSend(ws, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: "Must subscribe first",
      });
      return;
    }

    // Validate cursor
    if (
      !data.cursor ||
      typeof data.cursor.timestamp !== "number" ||
      typeof data.cursor.id !== "string"
    ) {
      this.safeSend(ws, {
        type: "error",
        code: "INVALID_CURSOR",
        message: "Invalid cursor",
      });
      return;
    }

    // Rate limit: reject if < 200ms since last fetch
    const now = Date.now();
    if (client.lastFetchHistoryAt && now - client.lastFetchHistoryAt < 200) {
      this.safeSend(ws, {
        type: "error",
        code: "RATE_LIMITED",
        message: "Too many requests",
      });
      return;
    }
    client.lastFetchHistoryAt = now;

    const rawLimit = typeof data.limit === "number" ? data.limit : 200;
    const limit = Math.max(1, Math.min(rawLimit, 500));
    const page = this.repository.getEventsHistoryPage(data.cursor.timestamp, data.cursor.id, limit);

    const items: SandboxEvent[] = [];
    for (const event of page.events) {
      try {
        items.push(JSON.parse(event.data));
      } catch {
        // Skip malformed events
      }
    }

    // Compute new cursor from oldest item in the page
    const oldestEvent = page.events.length > 0 ? page.events[0] : null;

    this.safeSend(ws, {
      type: "history_page",
      items,
      hasMore: page.hasMore,
      cursor: oldestEvent ? { timestamp: oldestEvent.created_at, id: oldestEvent.id } : null,
    } as ServerMessage);
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

    // Heartbeats update the sandbox table (for health monitoring) but are not
    // stored as events — they are high-frequency noise that drowns out real
    // content in replay and pagination queries.
    if (event.type === "heartbeat") {
      this.repository.updateSandboxHeartbeat(now);
      return;
    }

    // Get messageId from the event first (sandbox sends correct messageId with every event)
    // Only fall back to DB lookup if event doesn't include messageId (legacy fallback)
    // This prevents race conditions where events from message A arrive after message B starts processing
    const eventMessageId = "messageId" in event ? event.messageId : null;
    const processingMessage = this.repository.getProcessingMessage();
    const messageId = eventMessageId ?? processingMessage?.id ?? null;

    if (event.type === "token") {
      if (messageId) {
        this.repository.upsertTokenEvent(messageId, event, now);
      }
      this.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "step_start" || event.type === "step_finish") {
      this.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "tool_call") {
      if (shouldPersistToolCallEvent(event.status)) {
        this.repository.createEvent({
          id: generateId(),
          type: event.type,
          data: JSON.stringify(event),
          messageId,
          createdAt: now,
        });
      }
      this.broadcast({ type: "sandbox_event", event });

      // Fire-and-forget tool_call callback to originating client (e.g. linear-bot)
      if (messageId && event.status === "running") {
        this.ctx.waitUntil(this.callbackService.notifyToolCall(messageId, event).catch(() => {}));
      }
      return;
    }

    if (event.type === "tool_result") {
      this.repository.createEvent({
        id: generateId(),
        type: event.type,
        data: JSON.stringify(event),
        messageId,
        createdAt: now,
      });
      this.broadcast({ type: "sandbox_event", event });
      return;
    }

    // Handle specific event types
    if (event.type === "execution_complete") {
      if (messageId) {
        this.repository.upsertExecutionCompleteEvent(messageId, event, now);
      }

      // messageId already incorporates event.messageId (line above), so no extra fallback needed
      const completionMessageId = messageId;

      // Only update message status if it's still processing (not already stopped)
      const isStillProcessing =
        completionMessageId != null && processingMessage?.id === completionMessageId;

      if (isStillProcessing) {
        // Normal path: message still processing, complete it as before
        const status = event.success ? "completed" : "failed";
        this.repository.updateMessageCompletion(completionMessageId, status, now);

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

        this.broadcast({ type: "sandbox_event", event });
        this.broadcast({ type: "processing_status", isProcessing: this.getIsProcessing() });
        this.ctx.waitUntil(this.callbackService.notifyComplete(completionMessageId, event.success));
      } else {
        // Stopped path: message was already marked failed by stopExecution()
        this.log.info("prompt.complete", {
          event: "prompt.complete",
          message_id: completionMessageId,
          outcome: "already_stopped",
        });
      }

      // Always run these regardless of stop (snapshot, activity, queue drain)
      this.ctx.waitUntil(this.triggerSnapshot("execution_complete"));
      this.updateLastActivity(now);
      await this.scheduleInactivityCheck();
      await this.processMessageQueue();
      return; // execution_complete handling is done; skip the generic broadcast below
    }

    this.repository.createEvent({
      id: generateId(),
      type: event.type,
      data: JSON.stringify(event),
      messageId,
      createdAt: now,
    });

    if (event.type === "git_sync") {
      this.repository.updateSandboxGitSyncStatus(event.status);

      if (event.sha) {
        this.repository.updateSessionCurrentSha(event.sha);
      }
    }

    // Handle push completion events
    if (event.type === "push_complete" || event.type === "push_error") {
      this.handlePushEvent(event);
    }

    // Broadcast to clients (all non-execution_complete events)
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
    pushSpec: GitPushSpec
  ): Promise<{ success: true } | { success: false; error: string }> {
    const sandboxWs = this.wsManager.getSandboxSocket();

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

    // Tell sandbox to push the branch using provider-generated transport details.
    this.log.info("Sending push command", { branch_name: branchName });
    this.safeSend(sandboxWs, {
      type: "push",
      pushSpec,
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
    const sandboxWs = this.wsManager.getSandboxSocket();
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
    const resolvedModel = getValidModelOrDefault(message.model || session?.model);

    // Resolve reasoning effort: per-message > session default > model default
    const resolvedEffort =
      message.reasoning_effort ??
      session?.reasoning_effort ??
      getDefaultReasoningEffort(resolvedModel);

    const command: SandboxCommand = {
      type: "prompt",
      messageId: message.id,
      content: message.content,
      model: resolvedModel,
      reasoningEffort: resolvedEffort,
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
      reasoning_effort: resolvedEffort,
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
   * Marks the processing message as failed, upserts synthetic execution_complete,
   * broadcasts synthetic execution_complete
   * so all clients flush buffered tokens, and forwards stop to the sandbox.
   */
  private async stopExecution(): Promise<void> {
    const now = Date.now();
    const processingMessage = this.repository.getProcessingMessage();

    if (processingMessage) {
      this.repository.updateMessageCompletion(processingMessage.id, "failed", now);
      this.log.info("prompt.stopped", {
        event: "prompt.stopped",
        message_id: processingMessage.id,
      });

      const syntheticExecutionComplete: Extract<SandboxEvent, { type: "execution_complete" }> = {
        type: "execution_complete",
        messageId: processingMessage.id,
        success: false,
        sandboxId: "",
        timestamp: now / 1000,
      };
      this.repository.upsertExecutionCompleteEvent(
        processingMessage.id,
        syntheticExecutionComplete,
        now
      );

      // Broadcast synthetic execution_complete so ALL clients flush buffered tokens.
      // (The stop-clicking client flushes locally, but other connected clients don't.)
      this.broadcast({
        type: "sandbox_event",
        event: syntheticExecutionComplete,
      });

      // Notify slack-bot now because the bridge's late execution_complete will hit
      // the "already_stopped" branch in processSandboxEvent() which skips notification.
      this.ctx.waitUntil(this.callbackService.notifyComplete(processingMessage.id, false));
    }

    // Immediate client feedback
    this.broadcast({ type: "processing_status", isProcessing: false });

    // Forward stop to sandbox (bridge cancels its task)
    const sandboxWs = this.wsManager.getSandboxSocket();
    if (sandboxWs) {
      this.wsManager.send(sandboxWs, { type: "stop" });
    }
  }

  /**
   * Broadcast message to all authenticated clients.
   */
  private broadcast(message: ServerMessage): void {
    this.wsManager.forEachClientSocket("authenticated_only", (ws) => {
      this.wsManager.send(ws, message);
    });
  }

  /**
   * Validate reasoning effort against a model's allowed values.
   * Returns the validated effort string or null if invalid/absent.
   */
  private validateReasoningEffort(model: string, effort: string | undefined): string | null {
    if (!effort) return null;
    if (isValidReasoningEffort(model, effort)) return effort;
    this.log.warn("Invalid reasoning effort for model, ignoring", {
      model,
      reasoning_effort: effort,
    });
    return null;
  }

  /**
   * Get current session state.
   * Accepts an optional pre-fetched sandbox row to avoid a redundant SQLite read.
   */
  private getSessionState(sandbox?: SandboxRow | null): SessionState {
    const session = this.getSession();
    sandbox ??= this.getSandbox();
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
      reasoningEffort: session?.reasoning_effort ?? undefined,
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

    const repo = await getInstallationRepository(
      appConfig,
      session.repo_owner,
      session.repo_name,
      this.env
    );
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

    // Fetch global secrets
    let globalSecrets: Record<string, string> = {};
    try {
      const globalStore = new GlobalSecretsStore(this.env.DB, this.env.REPO_SECRETS_ENCRYPTION_KEY);
      globalSecrets = await globalStore.getDecryptedSecrets();
    } catch (e) {
      this.log.error("Failed to load global secrets, proceeding without", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Fetch repo secrets
    let repoSecrets: Record<string, string> = {};
    try {
      const repoId = await this.ensureRepoId(session);
      const repoStore = new RepoSecretsStore(this.env.DB, this.env.REPO_SECRETS_ENCRYPTION_KEY);
      repoSecrets = await repoStore.getDecryptedSecrets(repoId);
    } catch (e) {
      this.log.warn("Failed to load repo secrets, proceeding without", {
        repo_owner: session.repo_owner,
        repo_name: session.repo_name,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Merge: repo overrides global
    const { merged, totalBytes, exceedsLimit } = mergeSecrets(globalSecrets, repoSecrets);
    const globalCount = Object.keys(globalSecrets).length;
    const repoCount = Object.keys(repoSecrets).length;
    const mergedCount = Object.keys(merged).length;

    if (mergedCount > 0) {
      const logLevel = exceedsLimit ? "warn" : "info";
      this.log[logLevel]("Secrets merged for sandbox", {
        global_count: globalCount,
        repo_count: repoCount,
        merged_count: mergedCount,
        payload_bytes: totalBytes,
        exceeds_limit: exceedsLimit,
      });
    }

    return mergedCount === 0 ? undefined : merged;
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

  /**
   * Handle OpenAI token refresh.
   * Reads the refresh token from D1 secrets, calls OpenAI, stores the rotated
   * token back, and returns only the access token to the sandbox.
   */
  private async handleOpenAITokenRefresh(): Promise<Response> {
    const session = this.getSession();
    if (!session) {
      return this.openAIRefreshJsonResponse({ error: "No session" }, 404);
    }

    const encryptionKey = this.env.REPO_SECRETS_ENCRYPTION_KEY;
    if (!this.env.DB || !encryptionKey) {
      return this.openAIRefreshJsonResponse({ error: "Secrets not configured" }, 500);
    }

    const service = new OpenAITokenRefreshService(
      this.env.DB,
      encryptionKey,
      (sessionRow) => this.ensureRepoId(sessionRow),
      this.log
    );

    const result = await service.refresh(session);
    if (!result.ok) {
      return this.openAIRefreshJsonResponse({ error: result.error }, result.status);
    }

    return this.openAIRefreshJsonResponse(
      {
        access_token: result.accessToken,
        expires_in: result.expiresIn,
        account_id: result.accountId,
      },
      200
    );
  }

  private openAIRefreshJsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private getMessageCount(): number {
    return this.repository.getMessageCount();
  }

  /**
   * Write a user_message event to the events table and broadcast to connected clients.
   * Used by both WebSocket and HTTP prompt handlers for unified timeline replay.
   */
  private writeUserMessageEvent(
    participant: ParticipantRow,
    content: string,
    messageId: string,
    now: number
  ): void {
    const userMessageEvent: SandboxEvent = {
      type: "user_message",
      content,
      messageId,
      timestamp: now / 1000, // Convert to seconds to match other events
      author: {
        participantId: participant.id,
        name: participant.github_name || participant.github_login || participant.user_id,
        avatar: getGitHubAvatarUrl(participant.github_login),
      },
    };
    this.repository.createEvent({
      id: generateId(),
      type: "user_message",
      data: JSON.stringify(userMessageEvent),
      messageId,
      createdAt: now,
    });
    this.broadcast({ type: "sandbox_event", event: userMessageEvent });
  }

  private updateSandboxStatus(status: string): void {
    this.repository.updateSandboxStatus(status as SandboxStatus);
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
      reasoningEffort?: string; // Reasoning effort level
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

    // Validate and normalize model name if provided
    const model = getValidModelOrDefault(body.model);
    if (body.model && !isValidModel(body.model)) {
      this.log.warn("Invalid model name, using default", {
        requested_model: body.model,
        default_model: DEFAULT_MODEL,
      });
    }

    // Validate reasoning effort if provided
    const reasoningEffort = this.validateReasoningEffort(model, body.reasoningEffort);

    // Create session (store both internal ID and external name)
    this.repository.upsertSession({
      id: sessionId,
      sessionName, // Store the session name for WebSocket routing
      title: body.title ?? null,
      repoOwner: body.repoOwner,
      repoName: body.repoName,
      repoId: body.repoId ?? null,
      model,
      reasoningEffort,
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
      reasoningEffort: session.reasoning_effort ?? undefined,
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
        model?: string;
        reasoningEffort?: string;
        attachments?: Array<{ type: string; name: string; url?: string }>;
        callbackContext?: Record<string, unknown>;
      };

      // Get or create participant for the author
      // The authorId here is a user ID (like "anonymous"), not a participant row ID
      let participant = this.participantService.getByUserId(body.authorId);
      if (!participant) {
        participant = this.participantService.create(body.authorId, body.authorId);
      }

      const messageId = generateId();
      const now = Date.now();

      // Validate per-message model override
      let messageModel: string | null = null;
      if (body.model) {
        if (isValidModel(body.model)) {
          messageModel = body.model;
        } else {
          this.log.warn("Invalid message model in enqueue, ignoring", { model: body.model });
        }
      }

      // Validate per-message reasoning effort
      const effectiveModelForEffort = messageModel || this.getSession()?.model || DEFAULT_MODEL;
      const messageReasoningEffort = this.validateReasoningEffort(
        effectiveModelForEffort,
        body.reasoningEffort
      );

      this.repository.createMessage({
        id: messageId,
        authorId: participant.id, // Use the participant's row ID, not the user ID
        content: body.content,
        source: body.source as MessageSource,
        model: messageModel,
        reasoningEffort: messageReasoningEffort,
        attachments: body.attachments ? JSON.stringify(body.attachments) : null,
        callbackContext: body.callbackContext ? JSON.stringify(body.callbackContext) : null,
        status: "pending",
        createdAt: now,
      });

      this.writeUserMessageEvent(participant, body.content, messageId, now);

      const queuePosition = this.repository.getPendingOrProcessingCount();

      this.log.info("prompt.enqueue", {
        event: "prompt.enqueue",
        message_id: messageId,
        source: body.source,
        author_id: participant.id,
        user_id: body.authorId,
        model: messageModel,
        reasoning_effort: messageReasoningEffort,
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

  private async handleStop(): Promise<Response> {
    await this.stopExecution();
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
        metadata: this.parseArtifactMetadata(a),
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
   * Resolves prompting participant and auth in DO, then delegates PR orchestration.
   */
  private async handleCreatePR(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      title: string;
      body: string;
      baseBranch?: string;
      headBranch?: string;
    };

    const session = this.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const promptingParticipantResult = await this.participantService.getPromptingParticipantForPR();
    if (!promptingParticipantResult.participant) {
      return Response.json(
        { error: promptingParticipantResult.error },
        { status: promptingParticipantResult.status }
      );
    }

    const promptingParticipant = promptingParticipantResult.participant;
    const authResolution = await this.participantService.resolveAuthForPR(promptingParticipant);
    if ("error" in authResolution) {
      return Response.json({ error: authResolution.error }, { status: authResolution.status });
    }

    const sessionId = session.session_name || session.id;
    const webAppUrl = this.env.WEB_APP_URL || this.env.WORKER_URL || "";
    const sessionUrl = webAppUrl + "/session/" + sessionId;

    const pullRequestService = new SessionPullRequestService({
      repository: this.repository,
      sourceControlProvider: this.sourceControlProvider,
      log: this.log,
      generateId: () => generateId(),
      pushBranchToRemote: (headBranch, pushSpec) => this.pushBranchToRemote(headBranch, pushSpec),
      broadcastArtifactCreated: (artifact) => {
        this.broadcast({
          type: "artifact_created",
          artifact,
        });
      },
    });

    const result = await pullRequestService.createPullRequest({
      ...body,
      promptingUserId: promptingParticipant.user_id,
      promptingAuth: authResolution.auth,
      sessionUrl,
    });

    if (result.kind === "error") {
      return Response.json({ error: result.error }, { status: result.status });
    }

    if (result.kind === "manual") {
      return Response.json({
        status: "manual",
        createPrUrl: result.createPrUrl,
        headBranch: result.headBranch,
        baseBranch: result.baseBranch,
      });
    }

    return Response.json({
      prNumber: result.prNumber,
      prUrl: result.prUrl,
      state: result.state,
    });
  }

  private parseArtifactMetadata(
    artifact: Pick<ArtifactRow, "id" | "metadata">
  ): Record<string, unknown> | null {
    if (!artifact.metadata) {
      return null;
    }

    try {
      return JSON.parse(artifact.metadata) as Record<string, unknown>;
    } catch (error) {
      this.log.warn("Invalid artifact metadata JSON", {
        artifact_id: artifact.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
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
    let participant = this.participantService.getByUserId(body.userId);

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
      participant = this.participantService.getByUserId(body.userId)!;
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

    const participant = this.participantService.getByUserId(body.userId);
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

    const participant = this.participantService.getByUserId(body.userId);
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
