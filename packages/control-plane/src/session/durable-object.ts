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
import { buildSessionInternalUrl, SessionInternalPaths } from "./contracts";
import { timingSafeEqual } from "@open-inspect/shared";
import { generateId, hashToken, encryptToken, decryptToken } from "../auth/crypto";
import { getGitHubAppConfig } from "../auth/github-app";
import { createContainerProvider } from "../sandbox/providers/container-provider";
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
  type RepoImageLookup,
} from "../sandbox/lifecycle/manager";
import { RepoImageStore } from "../db/repo-images";
import { SessionIndexStore } from "../db/session-index";
import { DEFAULT_EXECUTION_TIMEOUT_MS } from "../sandbox/lifecycle/decisions";
import {
  createSourceControlProvider as createSourceControlProviderImpl,
  resolveScmProviderFromEnv,
  type SourceControlProvider,
  type GitPushSpec,
} from "../source-control";
import { DEFAULT_MODEL, isValidReasoningEffort } from "../utils/models";
import type {
  Env,
  ClientInfo,
  ClientMessage,
  ServerMessage,
  SandboxEvent,
  SessionState,
  SessionStatus,
  SandboxStatus,
  SkillInfo,
} from "../types";
import type { SessionRow, ArtifactRow, SandboxRow } from "./types";
import { SessionRepository } from "./repository";
import { SessionWebSocketManagerImpl, type SessionWebSocketManager } from "./websocket-manager";
import { SessionPullRequestService } from "./pull-request-service";
import { RepoSecretsStore } from "../db/repo-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { mergeSecrets } from "../db/secrets-validation";
import { OpenAITokenRefreshService } from "./openai-token-refresh-service";
import { ParticipantService, getAvatarUrl } from "./participant-service";
import { UserScmTokenStore } from "../db/user-scm-tokens";
import { CallbackNotificationService } from "./callback-notification-service";
import { DOFetcherAdapter } from "../scheduler/do-fetcher-adapter";
import { PresenceService } from "./presence-service";
import { SessionMessageQueue } from "./message-queue";
import { SessionSandboxEventProcessor } from "./sandbox-events";
import { createSessionInternalRoutes } from "./http/routes";
import { createMessagesHandler, type MessagesHandler } from "./http/handlers/messages.handler";
import {
  createChildSessionsHandler,
  type ChildSessionsHandler,
} from "./http/handlers/child-sessions.handler";
import { createSandboxHandler, type SandboxHandler } from "./http/handlers/sandbox.handler";
import { createWsTokenHandler, type WsTokenHandler } from "./http/handlers/ws-token.handler";
import {
  createSessionLifecycleHandler,
  type SessionLifecycleHandler,
} from "./http/handlers/session-lifecycle.handler";
import {
  createPullRequestHandler,
  type PullRequestHandler,
} from "./http/handlers/pull-request.handler";
import {
  createParticipantsHandler,
  type ParticipantsHandler,
} from "./http/handlers/participants.handler";
import { MessageService } from "./services/message.service";
import { createAlarmHandler, type AlarmHandler } from "./alarm/handler";

/**
 * Timeout for WebSocket authentication (in milliseconds).
 * Client WebSockets must send a valid 'subscribe' message within this time
 * or the connection will be closed. This prevents resource abuse from
 * unauthenticated connections that never complete the handshake.
 */
const WS_AUTH_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Maximum age of a WebSocket authentication token (in milliseconds).
 * Tokens older than this are rejected with close code 4001, forcing
 * the client to fetch a fresh token on reconnect.
 */
const WS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class SessionDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private repository: SessionRepository;
  private initialized = false;
  private log: Logger;
  // WebSocket manager (lazily initialized like lifecycleManager)
  private _wsManager: SessionWebSocketManager | null = null;
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
  // Message queue service (lazily initialized)
  private _messageQueue: SessionMessageQueue | null = null;
  // Message service (lazily initialized)
  private _messageService: MessageService | null = null;
  // Messages handler (lazily initialized)
  private _messagesHandler: MessagesHandler | null = null;
  // Child sessions handler (lazily initialized)
  private _childSessionsHandler: ChildSessionsHandler | null = null;
  // Sandbox handler (lazily initialized)
  private _sandboxHandler: SandboxHandler | null = null;
  // WebSocket token handler (lazily initialized)
  private _wsTokenHandler: WsTokenHandler | null = null;
  // Session lifecycle handler (lazily initialized)
  private _sessionLifecycleHandler: SessionLifecycleHandler | null = null;
  // Pull request handler (lazily initialized)
  private _pullRequestHandler: PullRequestHandler | null = null;
  // Participants handler (lazily initialized)
  private _participantsHandler: ParticipantsHandler | null = null;
  // Alarm handler (lazily initialized)
  private _alarmHandler: AlarmHandler | null = null;
  // Sandbox event processor (lazily initialized)
  private _sandboxEventProcessor: SessionSandboxEventProcessor | null = null;
  /** Skill catalog from the most recent skills_discovered event. */
  private skills: SkillInfo[] = [];

  // Internal HTTP route table (transport wiring only; handlers remain on SessionDO).
  private readonly routes = createSessionInternalRoutes({
    init: (request) => this.sessionLifecycleHandler.init(request),
    state: () => this.sessionLifecycleHandler.getState(),
    prompt: (request) => this.messagesHandler.enqueuePrompt(request),
    stop: () => this.messagesHandler.stop(),
    sandboxEvent: (request) => this.sandboxHandler.sandboxEvent(request),
    listParticipants: () => this.participantsHandler.listParticipants(),
    addParticipant: (request) => this.sandboxHandler.addParticipant(request),
    listEvents: (_request, url) => this.messagesHandler.listEvents(url),
    listArtifacts: () => this.messagesHandler.listArtifacts(),
    listMessages: (_request, url) => this.messagesHandler.listMessages(url),
    createPr: (request) => this.pullRequestHandler.createPr(request),
    wsToken: (request) => this.wsTokenHandler.generateWsToken(request),
    updateTitle: (request) => this.sessionLifecycleHandler.updateTitle(request),
    archive: (request) => this.sessionLifecycleHandler.archive(request),
    unarchive: (request) => this.sessionLifecycleHandler.unarchive(request),
    verifySandboxToken: (request) => this.sandboxHandler.verifySandboxToken(request),
    openaiTokenRefresh: () => this.sandboxHandler.openaiTokenRefresh(),
    spawnContext: () => this.childSessionsHandler.getSpawnContext(),
    childSummary: () => this.childSessionsHandler.getChildSummary(),
    cancel: () => this.sessionLifecycleHandler.cancel(),
    childSessionUpdate: (request) => this.childSessionsHandler.childSessionUpdate(request),
  });

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
      const userScmTokenStore =
        this.env.DB && this.env.TOKEN_ENCRYPTION_KEY
          ? new UserScmTokenStore(this.env.DB, this.env.TOKEN_ENCRYPTION_KEY)
          : null;
      this._participantService = new ParticipantService({
        repository: this.repository,
        env: this.env,
        log: this.log,
        generateId: () => generateId(),
        userScmTokenStore,
      });
    }
    return this._participantService;
  }

  /**
   * Get the callback notification service, creating it lazily if needed.
   */
  private get callbackService(): CallbackNotificationService {
    if (!this._callbackService) {
      // Wrap SchedulerDO namespace as a Fetcher for automation callbacks
      const schedulerCallback = this.env.SCHEDULER
        ? new DOFetcherAdapter(this.env.SCHEDULER, "global-scheduler")
        : undefined;

      this._callbackService = new CallbackNotificationService({
        repository: this.repository,
        env: {
          ...this.env,
          SCHEDULER_CALLBACK: schedulerCallback,
        },
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

  private get executionTimeoutMs(): number {
    return parseInt(this.env.EXECUTION_TIMEOUT_MS || String(DEFAULT_EXECUTION_TIMEOUT_MS), 10);
  }

  private get messageQueue(): SessionMessageQueue {
    if (!this._messageQueue) {
      this._messageQueue = new SessionMessageQueue({
        env: this.env,
        ctx: this.ctx,
        log: this.log,
        repository: this.repository,
        wsManager: this.wsManager,
        participantService: this.participantService,
        callbackService: this.callbackService,
        scmProvider: resolveScmProviderFromEnv(this.env.SCM_PROVIDER),
        getClientInfo: (ws) => this.getClientInfo(ws),
        validateReasoningEffort: (model, effort) => this.validateReasoningEffort(model, effort),
        getSession: () => this.getSession(),
        updateLastActivity: (timestamp) => this.updateLastActivity(timestamp),
        spawnSandbox: () => this.spawnSandbox(),
        broadcast: (message) => this.broadcast(message),
        setSessionStatus: async (status) => {
          await this.transitionSessionStatus(status);
        },
        reconcileSessionStatusAfterExecution: async (success) => {
          await this.reconcileSessionStatusAfterExecution(success);
        },
        scheduleExecutionTimeout: async (startedAtMs: number) => {
          const deadline = startedAtMs + this.executionTimeoutMs;
          const currentAlarm = await this.ctx.storage.getAlarm();
          if (!currentAlarm || deadline < currentAlarm) {
            await this.ctx.storage.setAlarm(deadline);
          }
        },
      });
    }

    return this._messageQueue;
  }

  private get messageService(): MessageService {
    if (!this._messageService) {
      this._messageService = new MessageService({
        repository: this.repository,
        messageQueue: this.messageQueue,
        stopExecution: () => this.stopExecution(),
        parseArtifactMetadata: (artifact) => this.parseArtifactMetadata(artifact),
      });
    }

    return this._messageService;
  }

  private get messagesHandler(): MessagesHandler {
    if (!this._messagesHandler) {
      this._messagesHandler = createMessagesHandler({
        messageService: this.messageService,
        getLog: () => this.log,
      });
    }

    return this._messagesHandler;
  }

  private get childSessionsHandler(): ChildSessionsHandler {
    if (!this._childSessionsHandler) {
      this._childSessionsHandler = createChildSessionsHandler({
        repository: this.repository,
        getSession: () => this.getSession(),
        getSandbox: () => this.getSandbox(),
        getPublicSessionId: (session) => this.getPublicSessionId(session),
        broadcast: (message) => this.broadcast(message),
      });
    }

    return this._childSessionsHandler;
  }

  private get sandboxHandler(): SandboxHandler {
    if (!this._sandboxHandler) {
      this._sandboxHandler = createSandboxHandler({
        repository: this.repository,
        processSandboxEvent: (event) => this.processSandboxEvent(event),
        getSandbox: () => this.getSandbox(),
        isValidSandboxToken: (token, sandbox) => this.isValidSandboxToken(token, sandbox),
        getSession: () => this.getSession(),
        refreshOpenAIToken: async (session) => {
          const service = new OpenAITokenRefreshService(
            this.env.DB!,
            this.env.REPO_SECRETS_ENCRYPTION_KEY!,
            (sessionRow) => this.ensureRepoId(sessionRow),
            this.log
          );
          return service.refresh(session);
        },
        isOpenAISecretsConfigured: () =>
          Boolean(this.env.DB && this.env.REPO_SECRETS_ENCRYPTION_KEY),
        generateId: () => generateId(),
        now: () => Date.now(),
        getLog: () => this.log,
      });
    }

    return this._sandboxHandler;
  }

  private get wsTokenHandler(): WsTokenHandler {
    if (!this._wsTokenHandler) {
      this._wsTokenHandler = createWsTokenHandler({
        repository: this.repository,
        getParticipantByUserId: (userId) => this.participantService.getByUserId(userId),
        generateId: (bytes) => generateId(bytes),
        hashToken: (token) => hashToken(token),
        now: () => Date.now(),
        getLog: () => this.log,
      });
    }

    return this._wsTokenHandler;
  }

  private get sessionLifecycleHandler(): SessionLifecycleHandler {
    if (!this._sessionLifecycleHandler) {
      this._sessionLifecycleHandler = createSessionLifecycleHandler({
        repository: this.repository,
        getDurableObjectId: () => this.ctx.id.toString(),
        tokenEncryptionKey: this.env.TOKEN_ENCRYPTION_KEY,
        encryptToken: async (token, encryptionKey) => {
          const { encryptToken } = await import("../auth/crypto");
          return encryptToken(token, encryptionKey);
        },
        validateReasoningEffort: (model, effort) => this.validateReasoningEffort(model, effort),
        generateId: (bytes) => generateId(bytes),
        now: () => Date.now(),
        scheduleWarmSandbox: () => this.ctx.waitUntil(this.warmSandbox()),
        getLog: () => this.log,
        getSession: () => this.getSession(),
        getSandbox: () => this.getSandbox(),
        getPublicSessionId: (session) => this.getPublicSessionId(session),
        getParticipantByUserId: (userId) => this.participantService.getByUserId(userId),
        transitionSessionStatus: (status) => this.transitionSessionStatus(status),
        stopExecution: (options) => this.stopExecution(options),
        getSandboxSocket: () => this.wsManager.getSandboxSocket(),
        sendToSandbox: (ws, message) => this.wsManager.send(ws, message),
        updateSandboxStatus: (status) => this.updateSandboxStatus(status),
        broadcast: (message) => this.broadcast(message),
      });
    }

    return this._sessionLifecycleHandler;
  }

  private get pullRequestHandler(): PullRequestHandler {
    if (!this._pullRequestHandler) {
      this._pullRequestHandler = createPullRequestHandler({
        getSession: () => this.getSession(),
        getPromptingParticipantForPR: () => this.participantService.getPromptingParticipantForPR(),
        resolveAuthForPR: (participant) => this.participantService.resolveAuthForPR(participant),
        getSessionUrl: (session) => {
          const sessionId = session.session_name || session.id;
          const webAppUrl = this.env.WEB_APP_URL || this.env.WORKER_URL || "";
          return webAppUrl + "/session/" + sessionId;
        },
        createPullRequest: async (input) => {
          const pullRequestService = new SessionPullRequestService({
            repository: this.repository,
            sourceControlProvider: this.sourceControlProvider,
            log: this.log,
            generateId: () => generateId(),
            pushBranchToRemote: (headBranch, pushSpec) =>
              this.pushBranchToRemote(headBranch, pushSpec),
            broadcastArtifactCreated: (artifact) => {
              this.broadcast({
                type: "artifact_created",
                artifact,
              });
            },
          });

          return pullRequestService.createPullRequest(input);
        },
      });
    }

    return this._pullRequestHandler;
  }

  private get participantsHandler(): ParticipantsHandler {
    if (!this._participantsHandler) {
      this._participantsHandler = createParticipantsHandler({
        repository: this.repository,
      });
    }

    return this._participantsHandler;
  }

  private get alarmHandler(): AlarmHandler {
    if (!this._alarmHandler) {
      this._alarmHandler = createAlarmHandler({
        repository: this.repository,
        messageQueue: this.messageQueue,
        lifecycleManager: this.lifecycleManager,
        executionTimeoutMs: this.executionTimeoutMs,
        now: () => Date.now(),
        getLog: () => this.log,
      });
    }

    return this._alarmHandler;
  }

  private get sandboxEventProcessor(): SessionSandboxEventProcessor {
    if (!this._sandboxEventProcessor) {
      this._sandboxEventProcessor = new SessionSandboxEventProcessor({
        ctx: this.ctx,
        log: this.log,
        repository: this.repository,
        callbackService: this.callbackService,
        wsManager: this.wsManager,
        broadcast: (message) => this.broadcast(message),
        getIsProcessing: () => this.getIsProcessing(),
        triggerSnapshot: (reason) => this.triggerSnapshot(reason),
        reconcileSessionStatusAfterExecution: async (success) => {
          await this.reconcileSessionStatusAfterExecution(success);
        },
        updateLastActivity: (timestamp) => this.updateLastActivity(timestamp),
        scheduleInactivityCheck: () => this.scheduleInactivityCheck(),
        processMessageQueue: () => this.messageQueue.processMessageQueue(),
        updateSkills: (skills) => {
          this.skills = skills;
        },
      });
    }

    return this._sandboxEventProcessor;
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
        kvCache: this.env.REPOS_CACHE,
      },
    });
  }

  /**
   * Create the lifecycle manager with all required adapters.
   */
  private createLifecycleManager(): SandboxLifecycleManager {
    // Verify container binding is available
    if (!this.env.SANDBOX_CONTAINER) {
      throw new Error("SANDBOX_CONTAINER binding is required for lifecycle manager");
    }

    // Create Cloudflare Container provider
    const provider = createContainerProvider(this.env.SANDBOX_CONTAINER, {
      anthropicApiKey: this.env.ANTHROPIC_API_KEY,
      anthropicBaseUrl: this.env.ANTHROPIC_BASE_URL,
      githubAppId: this.env.GITHUB_APP_ID,
      githubAppPrivateKey: this.env.GITHUB_APP_PRIVATE_KEY,
      githubAppInstallationId: this.env.GITHUB_APP_INSTALLATION_ID,
    });

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
      updateSandboxCodeServer: async (url, password) => {
        const encrypted = this.env.REPO_SECRETS_ENCRYPTION_KEY
          ? await encryptToken(password, this.env.REPO_SECRETS_ENCRYPTION_KEY)
          : password;
        this.repository.updateSandboxCodeServer(url, encrypted);
      },
      clearSandboxCodeServer: () => this.repository.clearSandboxCodeServer(),
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

    // Create repo image lookup if D1 is available
    let repoImageLookup: RepoImageLookup | undefined;
    if (this.env.DB) {
      const repoImageStore = new RepoImageStore(this.env.DB);
      repoImageLookup = {
        getLatestReady: (repoOwner, repoName, baseBranch) =>
          repoImageStore.getLatestReady(repoOwner, repoName, baseBranch),
      };
    }

    return new SandboxLifecycleManager(
      provider,
      storage,
      broadcaster,
      wsManager,
      alarmScheduler,
      idGenerator,
      config,
      {
        onSandboxTerminating: () => this.messageQueue.failStuckProcessingMessage(),
      },
      repoImageLookup
    );
  }

  /**
   * Safely send a message over a WebSocket.
   */
  private safeSend(ws: WebSocket, message: string | object): boolean {
    return this.wsManager.send(ws, message);
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

    const originalLogger = this.log;

    // Extract correlation headers and create a request-scoped logger
    const traceId = request.headers.get("x-trace-id");
    const requestId = request.headers.get("x-request-id");
    if (traceId || requestId) {
      const correlationCtx: Record<string, unknown> = {};
      if (traceId) correlationCtx.trace_id = traceId;
      if (requestId) correlationCtx.request_id = requestId;
      this.log = originalLogger.child(correlationCtx);
    }

    try {
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
    } finally {
      this.log = originalLogger;
    }
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
      const providedToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : null;

      // Get expected values from DB
      const sandbox = this.getSandbox();
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
      const tokenMatches = await this.isValidSandboxToken(providedToken, sandbox);
      if (!tokenMatches) {
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
   * Checks for stuck processing messages (defense-in-depth execution timeout)
   * BEFORE delegating to the lifecycle manager for inactivity and heartbeat
   * monitoring. This ensures stuck messages are failed even when the sandbox
   * is already dead and handleAlarm() returns early.
   */
  async alarm(): Promise<void> {
    this.ensureInitialized();
    await this.alarmHandler.handle();
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
      ws.close(4001, "Token expired");
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
      name: participant.scm_name || participant.scm_login || participant.user_id,
      avatar: getAvatarUrl(participant.scm_login, resolveScmProviderFromEnv(this.env.SCM_PROVIDER)),
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
    const state = await this.getSessionState(sandbox);
    const replay = this.getReplayData();

    this.safeSend(ws, {
      type: "subscribed",
      sessionId: state.id,
      state,
      participantId: participant.id,
      participant: {
        participantId: participant.id,
        name: participant.scm_name || participant.scm_login || participant.user_id,
        avatar: getAvatarUrl(
          participant.scm_login,
          resolveScmProviderFromEnv(this.env.SCM_PROVIDER)
        ),
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
      name: mapping.scm_name || mapping.scm_login || mapping.user_id,
      avatar: getAvatarUrl(mapping.scm_login, resolveScmProviderFromEnv(this.env.SCM_PROVIDER)),
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
    await this.messageQueue.handlePromptMessage(ws, data);
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
    await this.sandboxEventProcessor.processSandboxEvent(event);
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
    return await this.sandboxEventProcessor.pushBranchToRemote(branchName, pushSpec);
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
    await this.messageQueue.processMessageQueue();
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
  private async stopExecution(options?: { suppressStatusReconcile?: boolean }): Promise<void> {
    await this.messageQueue.stopExecution(options);
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

  private getPublicSessionId(session?: SessionRow | null): string {
    const resolved = session ?? this.getSession();
    return resolved?.session_name || resolved?.id || this.ctx.id.toString();
  }

  private syncSessionIndexStatus(
    sessionId: string,
    status: SessionStatus,
    updatedAt: number
  ): void {
    if (!this.env.DB) return;
    const sessionStore = new SessionIndexStore(this.env.DB);
    this.ctx.waitUntil(
      sessionStore.updateStatus(sessionId, status, updatedAt).catch((error) => {
        this.log.error("session_index.update_status.background_error", {
          session_id: sessionId,
          status,
          updated_at: updatedAt,
          error,
        });
      })
    );
  }

  private async transitionSessionStatus(status: SessionStatus): Promise<boolean> {
    const session = this.getSession();
    if (!session) return false;

    const publicSessionId = this.getPublicSessionId(session);
    if (session.status === status) {
      this.syncSessionIndexStatus(publicSessionId, status, session.updated_at);
      return false;
    }

    const updatedAt = Math.max(Date.now(), session.updated_at + 1);
    this.repository.updateSessionStatus(session.id, status, updatedAt);
    this.syncSessionIndexStatus(publicSessionId, status, updatedAt);

    this.broadcast({ type: "session_status", status });

    // Notify parent session (if this is a child) so its UI can refresh
    this.notifyParentOfStatusChange(session, publicSessionId, status);

    return true;
  }

  /**
   * Fire-and-forget notification to the parent session so its connected clients
   * can refresh the child-sessions list in real time.
   */
  private notifyParentOfStatusChange(
    session: Pick<SessionRow, "parent_session_id" | "title">,
    childSessionId: string,
    status: SessionStatus
  ): void {
    const parentId = session.parent_session_id;
    if (!parentId || !this.env.SESSION) return;

    const parentDoId = this.env.SESSION.idFromName(parentId);
    const parentStub = this.env.SESSION.get(parentDoId);

    this.ctx.waitUntil(
      parentStub
        .fetch(
          new Request(buildSessionInternalUrl(SessionInternalPaths.childSessionUpdate), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              childSessionId,
              status,
              title: session.title,
            }),
          })
        )
        .catch((error) => {
          this.log.error("notify_parent.failed", {
            parent_id: parentId,
            child_id: childSessionId,
            status,
            error,
          });
        })
    );
  }

  private async reconcileSessionStatusAfterExecution(success: boolean): Promise<void> {
    const pendingOrProcessing = this.repository.getPendingOrProcessingCount();
    const nextStatus: SessionStatus =
      pendingOrProcessing > 0 ? "active" : success ? "completed" : "failed";
    await this.transitionSessionStatus(nextStatus);
  }

  /**
   * Get current session state.
   * Accepts an optional pre-fetched sandbox row to avoid a redundant SQLite read.
   */
  private async getSessionState(sandbox?: SandboxRow | null): Promise<SessionState> {
    const session = this.getSession();
    sandbox ??= this.getSandbox();
    const messageCount = this.repository.getMessageCount();
    const isProcessing = this.getIsProcessing();

    // Decrypt code-server password if stored encrypted
    let codeServerPassword: string | null = sandbox?.code_server_password ?? null;
    if (codeServerPassword && this.env.REPO_SECRETS_ENCRYPTION_KEY) {
      try {
        codeServerPassword = await decryptToken(
          codeServerPassword,
          this.env.REPO_SECRETS_ENCRYPTION_KEY
        );
      } catch {
        // Key mismatch or corruption — don't leak ciphertext to clients
        codeServerPassword = null;
      }
    }

    return {
      id: this.getPublicSessionId(session),
      title: session?.title ?? null,
      repoOwner: session?.repo_owner ?? "",
      repoName: session?.repo_name ?? "",
      baseBranch: session?.base_branch ?? "main",
      branchName: session?.branch_name ?? null,
      status: session?.status ?? "created",
      sandboxStatus: sandbox?.status ?? "pending",
      messageCount,
      createdAt: session?.created_at ?? Date.now(),
      model: session?.model ?? DEFAULT_MODEL,
      reasoningEffort: session?.reasoning_effort ?? undefined,
      isProcessing,
      parentSessionId: session?.parent_session_id ?? null,
      codeServerUrl: sandbox?.code_server_url ?? null,
      codeServerPassword,
      skills: this.skills.length > 0 ? this.skills : undefined,
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

    const result = await this.sourceControlProvider.checkRepositoryAccess({
      owner: session.repo_owner,
      name: session.repo_name,
    });
    if (!result) {
      throw new Error("Repository is not accessible for the configured SCM provider");
    }

    this.repository.updateSessionRepoId(result.repoId);
    return result.repoId;
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
   * Verify a provided sandbox token against stored credentials.
   *
   * Preferred path uses auth_token_hash. Plaintext auth_token is only used
   * as a compatibility fallback for older rows.
   */
  private async isValidSandboxToken(
    token: string | null,
    sandbox: SandboxRow | null
  ): Promise<boolean> {
    if (!token || !sandbox) {
      return false;
    }

    if (sandbox.auth_token_hash) {
      const tokenHash = await hashToken(token);
      return timingSafeEqual(tokenHash, sandbox.auth_token_hash);
    }

    if (sandbox.auth_token) {
      return timingSafeEqual(token, sandbox.auth_token);
    }

    return false;
  }

  private updateSandboxStatus(status: string): void {
    this.repository.updateSandboxStatus(status as SandboxStatus);
  }

  // HTTP handlers

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
}
