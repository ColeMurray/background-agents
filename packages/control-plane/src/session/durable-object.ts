/**
 * Session Durable Object implementation.
 *
 * Each session gets its own Durable Object instance with:
 * - SQLite database for persistent state
 * - WebSocket connections with hibernation support
 * - Prompt queue and event streaming
 *
 * The collaborator graph is built eagerly by `createSessionComponents` in
 * `ensureInitialized()`. This class owns only the Cloudflare adapters (fetch,
 * WebSocket callbacks, alarm) and the domain logic Phase 3 has not yet
 * extracted: connection auth, the snapshot read model, and sandbox access.
 */

import { DurableObject } from "cloudflare:workers";
import { initSchema } from "./schema";
import {
  sessionSnapshotSchema,
  type ServerMessage,
  type SessionSnapshotState,
} from "@open-inspect/shared/types/server-messages";
import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import { hashToken } from "../auth/crypto";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import { isSandboxReconnectBlockedStatus } from "../sandbox/lifecycle/decisions";
import { resolveScmProviderFromEnv } from "../source-control";
import type { SessionRepositoryState } from "@open-inspect/shared/types/repositories";
import type { Env, ClientInfo } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionRow, SandboxRow } from "./types";
import { DEFAULT_SANDBOX_STATUS } from "../sandbox/sandbox-status";
import { resolveParticipantName } from "./participant-name";
import { safeParseTunnelUrls } from "./tunnel-urls";
import { resolvePublicSessionId } from "./public-session-id";
import {
  decryptStoredAccessValue,
  isValidSandboxToken,
  resolveSandboxDashboardUrl,
} from "./sandbox-access";
import { findPrArtifactForRepo } from "./pr-artifacts";
import { EnvironmentStore } from "../db/environments";
import { getAvatarUrl } from "./participant-service";
import { createSessionInternalRoutes } from "./http/routes";
import { handleAlarmDelivery } from "./alarm/scheduler";
import { SessionServer } from "./server";
import { SessionHttpDispatcher } from "./http/dispatcher";
import { SessionMessageRouter, type SessionClientCommands } from "./message-router";
import { SessionDisconnectHandler } from "./disconnect-handler";
import type { Clock, SandboxDisconnectMonitor, SessionBroadcaster, SocketRegistry } from "./ports";
import {
  createSessionComponents,
  type SessionComponents,
  type SessionPlatform,
} from "./components";

/**
 * Maximum age of a WebSocket authentication token (in milliseconds).
 * Tokens older than this are rejected with close code 4001, forcing
 * the client to fetch a fresh token on reconnect.
 */
const WS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface SessionSnapshotEnrichment {
  environmentId: string | null;
  environmentName: string | null;
}

export class SessionDO extends DurableObject<Env> {
  private sql: SqlStorage;
  /**
   * The DO's global-database handle — the single point where env.DB is read.
   * Nullable to preserve the existing defensive guards against a missing
   * binding at runtime. Distinct from `this.sql`, the DO-embedded SQLite.
   */
  private readonly db: SqlDatabase | null;
  private initialized = false;
  // Boot logger until ensureInitialized() replaces it with the session-scoped
  // logger the composition root creates. Request-serving code receives a
  // request-scoped child (with trace_id / request_id) threaded explicitly
  // from fetch().
  private log: Logger;
  // The eagerly constructed collaborator graph. Every runtime entry point
  // (fetch, WebSocket callbacks, alarm) calls ensureInitialized() before any
  // of these closures dereference it.
  private components!: SessionComponents;
  private readonly server: SessionServer<WebSocket, ClientInfo>;

  // Internal HTTP route table (transport wiring only; handlers live in the
  // component graph).
  private readonly routes = createSessionInternalRoutes({
    init: (request, _url, log) => this.components.sessionLifecycleHandler.init(request, log),
    state: () => this.components.sessionLifecycleHandler.getState(),
    snapshot: () => this.handleSnapshot(),
    sandboxAccess: () => this.handleSandboxAccess(),
    prompt: (request, _url, log) => this.components.messagesHandler.enqueuePrompt(request, log),
    stop: () => this.components.messagesHandler.stop(),
    sandboxEvent: (request) => this.components.sandboxHandler.sandboxEvent(request),
    createMediaArtifact: (request) => this.components.sandboxHandler.createMediaArtifact(request),
    recordAttachment: (request) => {
      const session = this.components.sessionCoreRepository.getSession();
      return this.components.attachmentsHandler.recordAttachment(
        request,
        session ? resolvePublicSessionId(session, this.ctx.id.toString()) : null
      );
    },
    listParticipants: () => this.components.participantsHandler.listParticipants(),
    addParticipant: (request) => this.components.sandboxHandler.addParticipant(request),
    listEvents: (_request, url) => this.components.messagesHandler.listEvents(url),
    listArtifacts: (_request, url) => this.components.messagesHandler.listArtifacts(url),
    listMessages: (_request, url) => this.components.messagesHandler.listMessages(url),
    createPr: (request, _url, log) => this.components.pullRequestHandler.createPr(request, log),
    pullRequestArtifactSnapshot: (request, url) =>
      this.components.pullRequestHandler.pullRequestArtifactSnapshot(request, url),
    pullRequestsRefresh: () => this.components.pullRequestHandler.refreshPullRequests(),
    wsToken: (request, _url, log) => this.components.wsTokenHandler.generateWsToken(request, log),
    updateTitle: (request) => this.components.sessionLifecycleHandler.updateTitle(request),
    archive: (request) => this.components.sessionLifecycleHandler.archive(request),
    unarchive: (request) => this.components.sessionLifecycleHandler.unarchive(request),
    expireDraft: () => this.components.sessionLifecycleHandler.expireDraft(),
    verifySandboxToken: (request, _url, log) =>
      this.components.sandboxHandler.verifySandboxToken(request, log),
    openaiTokenRefresh: (_request, _url, log) =>
      this.components.sandboxHandler.openaiTokenRefresh(log),
    xaiTokenRefresh: (_request, _url, log) => this.components.sandboxHandler.xaiTokenRefresh(log),
    scmCredentials: (_request, _url, log) => this.components.sandboxHandler.scmCredentials(log),
    tunnelUrls: (_request, _url, log) => this.components.sandboxHandler.tunnelUrls(log),
    spawnContext: () => this.components.childSessionsHandler.getSpawnContext(),
    activePromptAuthor: () => this.components.childSessionsHandler.getActivePromptAuthor(),
    childSummary: (_request, url) => this.components.childSessionsHandler.getChildSummary(url),
    parentPrompt: (request) => this.components.childSessionsHandler.parentPrompt(request),
    cancel: () => this.components.sessionLifecycleHandler.cancel(),
    childSessionUpdate: (request) =>
      this.components.childSessionsHandler.childSessionUpdate(request),
    diffState: () => this.components.diffsHandler.state(),
    diffStore: (request) => this.components.diffsHandler.storeBundle(request),
    diffFailure: (request) => this.components.diffsHandler.recordFailure(request),
    diffResolveFile: (_request, url) => this.components.diffsHandler.resolveFile(url),
    diffRetry: () => this.components.diffsHandler.retry(),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // eslint-disable-next-line no-restricted-syntax -- composition root: the DO's one env.DB read
    this.db = env.DB ?? null;
    this.sql = ctx.storage.sql;
    this.log = createLogger("session-do", {}, parseLogLevel(env.LOG_LEVEL));
    const ensureInitialized = (rehydrateAlarm?: boolean) => this.ensureInitialized(rehydrateAlarm);
    const clock: Clock = {
      nowMs: () => Date.now(),
      monotonicNowMs: () => performance.now(),
    };
    const sockets: SocketRegistry<WebSocket, ClientInfo> = {
      classify: (ws) => this.components.wsManager.classify(ws),
      send: (ws, message) => this.components.wsManager.send(ws, message),
      getClient: (ws) => this.getClientInfo(ws),
      close: (ws, code, reason) => this.components.wsManager.close(ws, code, reason),
      clearSandboxIfMatch: (ws) => this.components.wsManager.clearSandboxSocketIfMatch(ws),
      removeClient: (ws) => this.components.wsManager.removeClient(ws),
      hasParticipant: (participantId) =>
        Array.from(this.components.wsManager.getAuthenticatedClients()).some(
          (client) => client.participantId === participantId
        ),
    };
    const clientCommands: SessionClientCommands<WebSocket, ClientInfo> = {
      subscribe: (ws, message) => this.handleSubscribe(ws, message),
      submitPrompt: (ws, client, message) =>
        this.components.messageQueue.handlePromptMessage(ws, client, message),
      cancelPrompt: (ws, message) => this.components.messageQueue.cancelQueuedPrompt(ws, message),
      stopExecution: () => this.components.messageQueue.stopExecution(),
      notifyTyping: () => this.components.presenceService.handleTyping(),
      updatePresence: (client, message) =>
        this.components.presenceService.updatePresence(client, message),
      getHistoryPage: (message) => this.components.eventStream.getHistoryPage(message),
    };
    const sandboxDisconnects: SandboxDisconnectMonitor = {
      getStatus: () => this.components.sandboxRepository.getSandbox()?.status,
      scheduleCheck: () => this.components.lifecycleManager.scheduleDisconnectCheck(),
    };
    const broadcaster: SessionBroadcaster = {
      broadcastPresence: () => this.components.presenceService.broadcastPresence(),
      broadcast: (message) => this.components.messenger.broadcast(message),
    };
    // Cloudflare composition root: adapt DO callbacks and hibernating sockets to the server.
    this.server = new SessionServer({
      ensureInitialized,
      http: new SessionHttpDispatcher({
        ensureInitialized,
        getLogger: () => this.log,
        routes: this.routes,
        handleWebSocketUpgrade: (request, url, log) =>
          this.handleWebSocketUpgrade(request, url, log),
        clock,
      }),
      messages: new SessionMessageRouter({
        getLogger: () => this.log,
        sockets,
        clientCommands,
        processSandboxEvent: (event) =>
          this.components.sandboxEventProcessor.processSandboxEvent(event),
        clock,
      }),
      disconnects: new SessionDisconnectHandler({
        getLogger: () => this.log,
        sockets,
        sandbox: sandboxDisconnects,
        broadcaster,
      }),
      handleScheduledDeadline: () =>
        handleAlarmDelivery(
          this.components.alarmDeadlines,
          () => this.components.alarmHandler.handle(),
          () => this.components.alarmScheduler.rearmPending()
        ),
    });
  }

  /**
   * Initialize the session runtime: apply the schema, then build the whole
   * collaborator graph eagerly. Every runtime entry point calls this first.
   */
  private ensureInitialized(rehydrateAlarm = true): void {
    if (this.initialized) return;
    initSchema(this.sql);
    this.initialized = true;
    const platform: SessionPlatform = { ctx: this.ctx, sql: this.sql, db: this.db };
    this.components = createSessionComponents(platform, this.env);
    this.log = this.components.log;
    if (rehydrateAlarm) {
      this.components.backgroundTasks.submit(() => this.components.alarmScheduler.rehydrate(), {
        name: "alarm.rehydrate",
      });
    }
  }

  /**
   * Handle incoming HTTP requests.
   */
  async fetch(request: Request): Promise<Response> {
    return this.server.onRequest(request);
  }

  /**
   * Handle WebSocket upgrade request. `log` is the request-scoped logger.
   */
  private async handleWebSocketUpgrade(request: Request, url: URL, log: Logger): Promise<Response> {
    log.debug("WebSocket upgrade requested");
    const isSandbox = url.searchParams.get("type") === "sandbox";

    // Validate sandbox authentication
    if (isSandbox) {
      const wsStartTime = Date.now();
      const authHeader = request.headers.get("Authorization");
      const sandboxId = request.headers.get("X-Sandbox-ID");
      const providedToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : null;

      // Get expected values from DB
      const sandbox = this.components.sandboxRepository.getSandbox();
      const expectedSandboxId = sandbox?.modal_sandbox_id;

      // Validate sandbox ID first (catches stale sandboxes reconnecting after restore)
      if (expectedSandboxId && sandboxId !== expectedSandboxId) {
        log.warn("ws.connect", {
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
      const tokenMatches = await isValidSandboxToken(providedToken, sandbox);
      if (!tokenMatches) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "auth_failed",
          reject_reason: "token_mismatch",
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Unauthorized: Invalid auth token", { status: 401 });
      }

      // Reject connection if the session itself is closed for good. Narrower
      // than "not active": `completed` and `failed` sessions are idle, not
      // over — warm-on-typing spawns a sandbox for one before the follow-up
      // prompt arrives, and rejecting its bridge stranded that prompt.
      //
      // Read after authentication, not before: token hashing is a non-storage
      // await, so the input gate lets a cancel or archive land while this
      // request is suspended. Admission needs a fresh, synchronous read.
      const currentSession = this.components.sessionCoreRepository.getSession();
      if (currentSession && !isSessionPromptable(currentSession.status)) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "rejected",
          reject_reason: "session_terminal",
          session_status: currentSession.status,
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Session is terminal", { status: 410 });
      }

      const currentSandbox = this.components.sandboxRepository.getSandbox();
      // Deliberately narrower than isDeadSandboxStatus: a "failed" sandbox may
      // still connect after a slow boot and self-heal by becoming ready.
      if (currentSandbox && isSandboxReconnectBlockedStatus(currentSandbox.status)) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "rejected",
          reject_reason: "sandbox_stopped",
          sandbox_status: currentSandbox.status,
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Sandbox is stopped", { status: 410 });
      }
      if (
        currentSandbox?.modal_sandbox_id !== expectedSandboxId ||
        currentSandbox?.auth_token_hash !== sandbox?.auth_token_hash ||
        currentSandbox?.auth_token !== sandbox?.auth_token
      ) {
        return new Response("Forbidden: Sandbox credentials changed", { status: 403 });
      }

      // Auth passed — continue to WebSocket accept below
      // The success ws.connect event is emitted after the WebSocket is accepted
    }

    try {
      const { client, server } = this.components.connections.createUpgradeSockets();

      const sandboxId = request.headers.get("X-Sandbox-ID");

      if (isSandbox) {
        // The lifecycle manager publishes access after any pending provider
        // startup has persisted its URLs and credentials.
        const accessIsPersisted = !this.components.lifecycleManager.isProviderStartupPending();
        const { replaced } = this.components.wsManager.acceptAndSetSandboxSocket(
          server,
          sandboxId ?? undefined
        );
        // Notify manager that sandbox connected so it can reset the spawning flag
        this.components.lifecycleManager.onSandboxConnected();
        this.components.sandboxRepository.updateSandboxStatus("ready");
        this.components.messenger.broadcast({ type: "sandbox_status", status: "ready" });
        if (accessIsPersisted) {
          this.components.messenger.broadcast({ type: "sandbox_access_changed" });
        }

        // Set initial activity timestamp and schedule inactivity check
        // IMPORTANT: Must await to ensure alarm is scheduled before returning
        const now = Date.now();
        this.components.lifecycleManager.updateLastActivity(now);
        this.components.sandboxRepository.updateSandboxHeartbeat(now);
        await this.components.lifecycleManager.scheduleInactivityCheck();

        log.info("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "success",
          sandbox_id: sandboxId,
          replaced_existing: replaced,
          duration_ms: Date.now() - now,
        });

        // Process any pending messages now that sandbox is connected
        this.components.backgroundTasks.submit(
          () => this.components.messageQueue.processMessageQueue(),
          {
            name: "message_queue.process",
          }
        );
      } else {
        const wsId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        this.components.wsManager.acceptClientSocket(server, wsId);
        this.components.backgroundTasks.submit(
          () => this.components.wsManager.enforceAuthTimeout(server, wsId),
          {
            name: "websocket.enforce_auth_timeout",
            context: { ws_id: wsId },
          }
        );
      }

      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      log.error("WebSocket upgrade failed", {
        error: error instanceof Error ? error : String(error),
      });
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
  }

  /**
   * Handle WebSocket message (with hibernation support).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.server.onMessage(ws, message);
  }

  /**
   * Handle WebSocket close.
   */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    await this.server.onClose(ws, code, reason, wasClean);
  }

  /**
   * Handle WebSocket error.
   */
  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    this.server.onError(ws, error);
  }

  /**
   * Durable Object alarm handler.
   *
   * Checks for stuck processing messages (defense-in-depth execution timeout)
   * BEFORE delegating to the lifecycle manager for inactivity and heartbeat
   * monitoring. This ensures stuck messages are failed even when the sandbox
   * is already dead and handleAlarm() returns early.
   */
  async alarm(): Promise<void> {
    await this.server.onScheduledDeadline();
  }

  /**
   * Handle client subscription with token validation.
   */
  private async handleSubscribe(
    ws: WebSocket,
    data: {
      token: string;
      clientId: string;
    }
  ): Promise<void> {
    const { wsManager, participantService, presenceService } = this.components;
    // Validate the WebSocket auth token
    if (!data.token) {
      this.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "auth_failed",
        reject_reason: "no_token",
      });
      wsManager.close(ws, 4001, "Authentication required");
      return;
    }

    if (wsManager.isClientAuthenticated(ws) || wsManager.isClientSynchronizing(ws)) {
      wsManager.close(ws, 4003, "Already subscribed");
      return;
    }
    wsManager.setClientSynchronizing(ws, true);

    try {
      // Hash the incoming token and look up participant
      const tokenHash = await hashToken(data.token);
      const participant = participantService.getByWsTokenHash(tokenHash);

      if (!participant) {
        this.log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "client",
          outcome: "auth_failed",
          reject_reason: "invalid_token",
        });
        wsManager.close(ws, 4001, "Invalid authentication token");
        return;
      }

      // Reject tokens older than the TTL
      if (
        participant.ws_token_created_at === null ||
        Date.now() - participant.ws_token_created_at > WS_TOKEN_TTL_MS
      ) {
        this.log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "client",
          outcome: "auth_failed",
          reject_reason: "token_expired",
          participant_id: participant.id,
          user_id: participant.user_id,
        });
        wsManager.close(ws, 4001, "Token expired");
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
        userId: participant.canonical_user_id ?? participant.user_id,
        name: resolveParticipantName(participant),
        avatar: getAvatarUrl(
          participant.scm_login,
          resolveScmProviderFromEnv(this.env.SCM_PROVIDER)
        ),
        status: "active",
        lastSeen: Date.now(),
        clientId: data.clientId,
        ws,
      };

      const enrichment = await this.resolveSessionSnapshotEnrichment();
      if (!this.completeClientSubscription(ws, clientInfo, enrichment)) {
        wsManager.close(ws, 4009, "Session synchronization failed");
        return;
      }

      presenceService.sendPresence(ws);
      presenceService.broadcastPresence();
      this.components.schedulePullRequestRefresh("open");
    } finally {
      wsManager.setClientSynchronizing(ws, false);
    }
  }

  /**
   * Finish the snapshot-to-stream handoff synchronously. Keeping the final read,
   * send, and registration in a non-async method makes the no-await invariant
   * structural rather than a convention inside the async authentication flow.
   */
  private completeClientSubscription(
    ws: WebSocket,
    client: ClientInfo,
    enrichment: SessionSnapshotEnrichment
  ): boolean {
    const { wsManager } = this.components;
    const snapshot = this.readSessionSnapshot(enrichment);
    if (!snapshot) return false;

    if (
      !wsManager.send(ws, {
        type: "subscribed",
        ...snapshot,
        participantId: client.participantId,
        participant: {
          participantId: client.participantId,
          userId: client.userId,
          name: client.name,
          avatar: client.avatar,
        },
      } satisfies ServerMessage)
    ) {
      return false;
    }

    wsManager.setClient(ws, client);
    const parsed = wsManager.classify(ws);
    if (parsed.kind === "client" && parsed.wsId) {
      wsManager.persistClientMapping(parsed.wsId, client.participantId, client.clientId);
      this.log.debug("Stored ws_client_mapping", {
        ws_id: parsed.wsId,
        participant_id: client.participantId,
      });
    }
    return true;
  }

  /**
   * Get client info for a WebSocket, reconstructing from storage if needed after hibernation.
   */
  private getClientInfo(ws: WebSocket): ClientInfo | null {
    const { wsManager } = this.components;
    // 1. In-memory cache (manager)
    const cached = wsManager.getClient(ws);
    if (cached) return cached;

    // 2. DB recovery (manager handles tag parsing + DB lookup)
    const mapping = wsManager.recoverClientMapping(ws);
    if (!mapping) {
      this.log.warn("No client mapping found after hibernation, closing WebSocket");
      wsManager.close(ws, 4002, "Session expired, please reconnect");
      return null;
    }

    // 3. Build ClientInfo (DO owns domain logic)
    this.log.info("Recovered client info from DB", { user_id: mapping.user_id });
    const clientInfo: ClientInfo = {
      participantId: mapping.participant_id,
      userId: mapping.canonical_user_id ?? mapping.user_id,
      name: resolveParticipantName(mapping),
      avatar: getAvatarUrl(mapping.scm_login, resolveScmProviderFromEnv(this.env.SCM_PROVIDER)),
      status: "active",
      lastSeen: Date.now(),
      clientId: mapping.client_id || `client-${Date.now()}`,
      ws,
    };

    // 4. Re-cache
    wsManager.setClient(ws, clientInfo);
    return clientInfo;
  }

  private async resolveSessionSnapshotEnrichment(): Promise<SessionSnapshotEnrichment> {
    const session = this.components.sessionCoreRepository.getSession();
    const environmentId = session?.environment_id ?? null;
    const environmentName = await this.resolveEnvironmentName(environmentId);
    return { environmentId, environmentName };
  }

  private readSessionState(
    enrichment: SessionSnapshotEnrichment
  ): { session: SessionSnapshotState; sandbox: SandboxRow | null } | null {
    const session = this.components.sessionCoreRepository.getSession();
    if (!session) return null;
    const sandbox = this.components.sandboxRepository.getSandbox();
    const publicSession: SessionSnapshotState = {
      id: resolvePublicSessionId(session, this.ctx.id.toString()),
      title: session.title,
      repoOwner: session.repo_owner,
      repoName: session.repo_name,
      baseBranch: session.base_branch,
      branchName: session.branch_name,
      status: session.status,
      sandboxStatus: sandbox?.status ?? DEFAULT_SANDBOX_STATUS,
      messageCount: this.components.messageRepository.getMessageCount(),
      createdAt: session.created_at,
      model: session.model ?? DEFAULT_MODEL,
      reasoningEffort: session.reasoning_effort ?? undefined,
      isProcessing: this.getIsProcessing(),
      parentSessionId: session.parent_session_id,
      totalCost: session.total_cost ?? 0,
      codeServerUrl: sandbox?.code_server_url ?? null,
      vncUrl: sandbox?.vnc_url ?? null,
      tunnelUrls: sandbox?.tunnel_urls ? safeParseTunnelUrls(sandbox.tunnel_urls, this.log) : null,
      ttydUrl: sandbox?.ttyd_url ?? null,
      sandboxDashboardUrl: resolveSandboxDashboardUrl(
        this.components.sandboxDashboardSettings,
        sandbox?.modal_object_id
      ),
      repositories: this.getSessionRepositoryStates(session),
      environmentId: session.environment_id ?? null,
      environmentName:
        session.environment_id === enrichment.environmentId ? enrichment.environmentName : null,
    };
    return { session: publicSession, sandbox };
  }

  private readSessionSnapshot(enrichment: SessionSnapshotEnrichment) {
    return this.ctx.storage.transactionSync(() => {
      const local = this.readSessionState(enrichment);
      if (!local) return null;
      return {
        session: local.session,
        artifacts: this.components.messageService.listArtifacts().artifacts,
        timeline: this.components.eventStream.getReplay(),
        promptQueue: this.components.messageRepository.listPromptQueue(),
        spawnError: local.sandbox?.last_spawn_error ?? null,
      };
    });
  }

  private async handleSnapshot(): Promise<Response> {
    const headers = { "Cache-Control": "private, no-store" };
    const enrichment = await this.resolveSessionSnapshotEnrichment();
    const snapshot = this.readSessionSnapshot(enrichment);
    if (!snapshot) {
      return Response.json({ error: "Session not found" }, { status: 404, headers });
    }
    return Response.json(sessionSnapshotSchema.parse(snapshot), { headers });
  }

  private async handleSandboxAccess(): Promise<Response> {
    const headers = { "Cache-Control": "private, no-store" };
    if (!this.components.sessionCoreRepository.getSession()) {
      return Response.json({ error: "Session not found" }, { status: 404, headers });
    }
    const sandbox = this.components.sandboxRepository.getSandbox();
    if (!sandbox || sandbox.status !== "ready") {
      return Response.json({ error: "Sandbox access is unavailable" }, { status: 409, headers });
    }

    const encryptionKey = this.env.REPO_SECRETS_ENCRYPTION_KEY;
    const [codeServerPassword, vncPassword, ttydToken] = await Promise.all([
      decryptStoredAccessValue(sandbox.code_server_password, encryptionKey, this.log),
      decryptStoredAccessValue(sandbox.vnc_password, encryptionKey, this.log),
      decryptStoredAccessValue(sandbox.ttyd_token, encryptionKey, this.log),
    ]);
    const current = this.components.sandboxRepository.getSandbox();
    if (
      !current ||
      current.id !== sandbox.id ||
      current.status !== "ready" ||
      current.code_server_url !== sandbox.code_server_url ||
      current.code_server_password !== sandbox.code_server_password ||
      current.vnc_url !== sandbox.vnc_url ||
      current.vnc_password !== sandbox.vnc_password ||
      current.ttyd_url !== sandbox.ttyd_url ||
      current.ttyd_token !== sandbox.ttyd_token
    ) {
      return Response.json({ error: "Sandbox access changed; retry" }, { status: 409, headers });
    }
    return Response.json(
      {
        codeServer:
          current.code_server_url && codeServerPassword
            ? { url: current.code_server_url, password: codeServerPassword }
            : null,
        vnc:
          current.vnc_url && vncPassword ? { url: current.vnc_url, password: vncPassword } : null,
        ttyd: current.ttyd_url && ttydToken ? { url: current.ttyd_url, token: ttydToken } : null,
      },
      { headers }
    );
  }

  /**
   * The launch environment's current display name, or null when the session has
   * no environment or the environment was deleted after launch (§7.6). Resolved
   * live rather than snapshotted so deletion is reflected; best-effort, so a
   * lookup failure resolves null rather than failing the whole state read.
   */
  private async resolveEnvironmentName(environmentId: string | null): Promise<string | null> {
    if (!environmentId || !this.db) {
      return null;
    }
    try {
      const environment = await new EnvironmentStore(this.db).getById(environmentId);
      return environment?.name ?? null;
    } catch (e) {
      this.log.warn("Failed to resolve environment name for session state", {
        environment_id: environmentId,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Member repositories for SessionState, in position order (see
   * buildSessionRepositories for the scalar-mirror fallback). Members synthesized
   * from the scalars — and member rows written before per-repo git state
   * existed, whose git columns are null while the scalars are set — have the
   * primary entry overlaid with the session scalars.
   */
  private getSessionRepositoryStates(session: SessionRow | null): SessionRepositoryState[] {
    const prUrlForRepo = this.getPrUrlLookup();
    return this.components.sessionCoreRepository.getSessionRepositories().map((member) => ({
      position: member.position,
      repoOwner: member.repoOwner,
      repoName: member.repoName,
      repoId: member.row ? member.row.repo_id : (session?.repo_id ?? null),
      baseBranch: member.baseBranch ?? "main",
      branchName:
        member.row?.branch_name ?? (member.isPrimary ? (session?.branch_name ?? null) : null),
      baseSha: member.row?.base_sha ?? (member.isPrimary ? (session?.base_sha ?? null) : null),
      currentSha:
        member.row?.current_sha ?? (member.isPrimary ? (session?.current_sha ?? null) : null),
      prUrl: prUrlForRepo(member.repoOwner, member.repoName, member.isPrimary),
    }));
  }

  /** Per-repo PR URL lookup over the session's PR artifacts. */
  private getPrUrlLookup(): (
    repoOwner: string,
    repoName: string,
    isPrimary: boolean
  ) => string | null {
    const artifacts = this.components.artifactRepository
      .listArtifacts()
      .filter((artifact) => artifact.url !== null);
    return (repoOwner, repoName, isPrimary) =>
      findPrArtifactForRepo(artifacts, { repoOwner, repoName }, isPrimary)?.url ?? null;
  }

  /**
   * Check if any message is currently being processed.
   */
  private getIsProcessing(): boolean {
    return this.components.messageRepository.getProcessingMessage() !== null;
  }
}
