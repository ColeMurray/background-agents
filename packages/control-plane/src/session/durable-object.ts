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
import {
  sessionSnapshotSchema,
  type ServerMessage,
  type SessionSnapshotState,
} from "@open-inspect/shared/types/server-messages";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { ClientMessage } from "@open-inspect/shared/types/websocket";
import type { ScmSettings } from "@open-inspect/shared/types/integrations";
import { resolveAppName } from "@open-inspect/shared/app-name";
import { timingSafeEqual } from "@open-inspect/shared/auth";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import { generateId, hashToken, encryptToken, decryptToken } from "../auth/crypto";
import { buildModalSandboxDashboardUrl } from "../sandbox/client";
import { resolveSandboxBackendName } from "../sandbox/provider-name";
import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import { createImageBuildLookup } from "../image-builds/lookup";
import { resolveImageBuildProvider } from "../image-builds/provider-policy";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxStorage,
  type SandboxBroadcaster,
  type WebSocketManager,
  type IdGenerator,
  type ImageBuildLookup,
  type McpServerLookup,
  type SlackAgentNotifyLookup,
} from "../sandbox/lifecycle/manager";
import { McpServerStore } from "../db/mcp-servers";
import { IntegrationSettingsStore, resolveSlackSettings } from "../db/integration-settings";
import { ScmSettingsStore } from "../db/scm-settings";
import { SessionIndexStore } from "../db/session-index";
import { isSandboxReconnectBlockedStatus } from "../sandbox/lifecycle/decisions";
import { DEFAULT_SANDBOX_TIMEOUT_SECONDS } from "../sandbox/provider";
import { parsePersistedSandboxSettings } from "../sandbox/settings";
import {
  createSourceControlProviderFromEnv,
  resolveScmProviderFromEnv,
  type SourceControlProvider,
  type GitPushSpec,
} from "../source-control";
import type { SessionRepositoryState } from "@open-inspect/shared/types/repositories";
import type { Env, ClientInfo } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionRow, ArtifactRow, SandboxRow } from "./types";
import { SessionCoreRepository } from "./session-core-repository";
import { SandboxRepository } from "./sandbox-repository";
import { SessionAttachmentRepository } from "./session-attachment-repository";
import { ArtifactRepository } from "./artifact-repository";
import { EventRepository } from "./event-repository";
import { MessageRepository } from "./message-repository";
import { ParticipantRepository } from "./participant-repository";
import { WsClientMappingRepository } from "./ws-client-mapping-repository";
import { resolveParticipantName } from "./participant-name";
import { validateReasoningEffort } from "./reasoning-effort";
import { parseTunnelUrls } from "./tunnel-urls";
import { SessionWebSocketManagerImpl, type SessionWebSocketManager } from "./websocket-manager";
import { DurableObjectSessionConnections } from "./durable-object-session-connections";
import { SessionPullRequestStore } from "../db/session-pull-request-store";
import { PullRequestCreationClaims, SessionPullRequestService } from "./pull-request-service";
import { refreshSessionPullRequests } from "./pull-request-refresh";
import { findPrArtifactForRepo } from "./pr-artifacts";
import { RepoSecretsStore } from "../db/repo-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { EnvironmentStore } from "../db/environments";
import {
  auditSecretsMerge,
  mergeSecretSources,
  parseSecretsCapMode,
} from "../db/secrets-validation";
import { buildSessionTargetSecretSources } from "./session-target-secrets";
import type { RepoIdentity, SessionRepositoryEntry } from "./repository-target";
import { OpenAITokenRefreshService } from "./openai-token-refresh-service";
import { XaiTokenRefreshService } from "./xai-token-refresh-service";
import { prepareManagedProviderEnv } from "../sandbox/managed-provider-env";
import { ScmCredentialsService } from "./scm-credentials-service";
import { ParticipantService, getAvatarUrl } from "./participant-service";
import { UserScmTokenStore } from "../db/user-scm-tokens";
import { CallbackNotificationService } from "./callback-notification-service";
import { DOFetcherAdapter } from "../scheduler/do-fetcher-adapter";
import { createCloudflareBackgroundJobDispatcher } from "../cloudflare/background-job-dispatcher";
import type { AlarmScheduler, BackgroundJobDispatcher } from "../platform-ports";
import { PresenceService } from "./presence-service";
import { SessionMessageQueue } from "./message-queue";
import { SessionSandboxEventProcessor } from "./sandbox-events";
import { SessionTerminalMessageProjection } from "./terminal-message-projection";
import { SessionEventStream } from "./event-stream";
import { createSessionInternalRoutes } from "./http/routes";
import { createMessagesHandler, type MessagesHandler } from "./http/handlers/messages.handler";
import {
  createChildSessionsHandler,
  type ChildSessionsHandler,
} from "./http/handlers/child-sessions.handler";
import { createSandboxHandler, type SandboxHandler } from "./http/handlers/sandbox.handler";
import { AttachmentsHandler } from "./http/handlers/attachments.handler";
import { createWsTokenHandler, type WsTokenHandler } from "./http/handlers/ws-token.handler";
import {
  createSessionLifecycleHandler,
  type SessionLifecycleHandler,
} from "./http/handlers/session-lifecycle.handler";
import {
  normalizeSessionTitle,
  type SessionTitleUpdateOptions,
  type SessionTitleUpdateResult,
} from "./title";
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
import { createEarliestAlarmScheduler } from "./alarm/scheduler";
import { SessionDiffStore } from "./diffs/store";
import { SessionDiffService } from "./diffs/service";
import { SessionDiffsHandler } from "./http/handlers/session-diffs.handler";
import { SessionMessengerImpl, type SessionMessenger } from "./messenger";
import { SessionStatusService } from "./session-status-service";
import { parseArtifactMetadataJson } from "./artifact-metadata";
import { SessionServer } from "./server";
import { SessionHttpDispatcher } from "./http/dispatcher";
import { SessionMessageRouter, type SessionClientCommands } from "./message-router";
import { SessionDisconnectHandler } from "./disconnect-handler";
import type { Clock, SandboxDisconnectMonitor, SessionBroadcaster, SocketRegistry } from "./ports";

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

interface SessionSnapshotEnrichment {
  environmentId: string | null;
  environmentName: string | null;
}

type ClientPrompt = Extract<ClientMessage, { type: "prompt" }>;

export class SessionDO extends DurableObject<Env> {
  private sql: SqlStorage;
  /**
   * The DO's global-database handle — the single point where env.DB is read.
   * Nullable to preserve the existing defensive guards against a missing
   * binding at runtime. Distinct from `this.sql`, the DO-embedded SQLite.
   */
  private readonly db: SqlDatabase | null;
  private readonly backgroundJobs: BackgroundJobDispatcher;
  private sessionCoreRepository: SessionCoreRepository;
  private sandboxRepository: SandboxRepository;
  private attachmentRepository: SessionAttachmentRepository;
  private artifactRepository: ArtifactRepository;
  private eventRepository: EventRepository;
  private messageRepository: MessageRepository;
  private participantRepository: ParticipantRepository;
  private wsClientMappingRepository: WsClientMappingRepository;
  private initialized = false;
  // Session-scoped logger. Assigned during initialization only — never
  // per-request. Request-serving code receives a request-scoped child
  // (with trace_id / request_id) threaded explicitly from fetch().
  private log: Logger;
  // WebSocket manager (lazily initialized like lifecycleManager)
  private _wsManager: SessionWebSocketManager | null = null;
  private _connections: DurableObjectSessionConnections | null = null;
  // Session messenger (constructed in ensureInitialized once the session logger exists)
  private messenger!: SessionMessenger;
  // Session diff service (constructed in ensureInitialized once the session logger exists)
  private diffService!: SessionDiffService;
  // Session diffs HTTP handler (constructed in ensureInitialized alongside the service)
  private diffsHandler!: SessionDiffsHandler;
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
  private _eventStream: SessionEventStream | null = null;
  // Messages handler (lazily initialized)
  private _messagesHandler: MessagesHandler | null = null;
  // Child sessions handler (lazily initialized)
  private _childSessionsHandler: ChildSessionsHandler | null = null;
  // Sandbox handler (lazily initialized)
  private _sandboxHandler: SandboxHandler | null = null;
  // Session attachments handler (lazily initialized)
  private _attachmentsHandler: AttachmentsHandler | null = null;
  // WebSocket token handler (lazily initialized)
  private _wsTokenHandler: WsTokenHandler | null = null;
  // Session lifecycle handler (lazily initialized)
  private _sessionLifecycleHandler: SessionLifecycleHandler | null = null;
  // Pull request handler (lazily initialized)
  private _pullRequestHandler: PullRequestHandler | null = null;
  private readonly prCreationClaims = new PullRequestCreationClaims();
  // Participants handler (lazily initialized)
  private _participantsHandler: ParticipantsHandler | null = null;
  // Alarm handler (lazily initialized)
  private _alarmHandler: AlarmHandler | null = null;
  private _alarmScheduler: AlarmScheduler | null = null;
  // Sandbox event processor (lazily initialized)
  private _sandboxEventProcessor: SessionSandboxEventProcessor | null = null;
  // Session status service (lazily initialized)
  private _statusService: SessionStatusService | null = null;
  private _terminalMessageProjection: SessionTerminalMessageProjection | null = null;
  private readonly server: SessionServer<WebSocket, ClientInfo>;

  // Internal HTTP route table (transport wiring only; handlers remain on SessionDO).
  private readonly routes = createSessionInternalRoutes({
    init: (request, _url, log) => this.sessionLifecycleHandler.init(request, log),
    state: () => this.sessionLifecycleHandler.getState(),
    snapshot: () => this.handleSnapshot(),
    sandboxAccess: () => this.handleSandboxAccess(),
    prompt: (request, _url, log) => this.messagesHandler.enqueuePrompt(request, log),
    stop: () => this.messagesHandler.stop(),
    sandboxEvent: (request) => this.sandboxHandler.sandboxEvent(request),
    createMediaArtifact: (request) => this.sandboxHandler.createMediaArtifact(request),
    recordAttachment: (request) => {
      const session = this.getSession();
      return this.attachmentsHandler.recordAttachment(
        request,
        session ? this.getPublicSessionId(session) : null
      );
    },
    listParticipants: () => this.participantsHandler.listParticipants(),
    addParticipant: (request) => this.sandboxHandler.addParticipant(request),
    listEvents: (_request, url) => this.messagesHandler.listEvents(url),
    listArtifacts: (_request, url) => this.messagesHandler.listArtifacts(url),
    listMessages: (_request, url) => this.messagesHandler.listMessages(url),
    createPr: (request, _url, log) => this.pullRequestHandler.createPr(request, log),
    pullRequestArtifactSnapshot: (request, url) =>
      this.pullRequestHandler.pullRequestArtifactSnapshot(request, url),
    pullRequestsRefresh: () => this.pullRequestHandler.refreshPullRequests(),
    wsToken: (request, _url, log) => this.wsTokenHandler.generateWsToken(request, log),
    updateTitle: (request) => this.sessionLifecycleHandler.updateTitle(request),
    archive: (request) => this.sessionLifecycleHandler.archive(request),
    unarchive: (request) => this.sessionLifecycleHandler.unarchive(request),
    expireDraft: () => this.sessionLifecycleHandler.expireDraft(),
    verifySandboxToken: (request, _url, log) =>
      this.sandboxHandler.verifySandboxToken(request, log),
    openaiTokenRefresh: (_request, _url, log) => this.sandboxHandler.openaiTokenRefresh(log),
    xaiTokenRefresh: (_request, _url, log) => this.sandboxHandler.xaiTokenRefresh(log),
    scmCredentials: (_request, _url, log) => this.sandboxHandler.scmCredentials(log),
    tunnelUrls: (_request, _url, log) => this.sandboxHandler.tunnelUrls(log),
    spawnContext: () => this.childSessionsHandler.getSpawnContext(),
    activePromptAuthor: () => this.childSessionsHandler.getActivePromptAuthor(),
    childSummary: (_request, url) => this.childSessionsHandler.getChildSummary(url),
    parentPrompt: (request) => this.childSessionsHandler.parentPrompt(request),
    cancel: () => this.sessionLifecycleHandler.cancel(),
    childSessionUpdate: (request) => this.childSessionsHandler.childSessionUpdate(request),
    diffState: () => this.diffsHandler.state(),
    diffStore: (request) => this.diffsHandler.storeBundle(request),
    diffFailure: (request) => this.diffsHandler.recordFailure(request),
    diffResolveFile: (_request, url) => this.diffsHandler.resolveFile(url),
    diffRetry: () => this.diffsHandler.retry(),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // eslint-disable-next-line no-restricted-syntax -- composition root: the DO's one env.DB read
    this.db = env.DB ?? null;
    this.backgroundJobs = createCloudflareBackgroundJobDispatcher(ctx);
    this.sql = ctx.storage.sql;
    this.attachmentRepository = new SessionAttachmentRepository(this.sql);
    this.artifactRepository = new ArtifactRepository(this.sql);
    this.eventRepository = new EventRepository(this.sql, (closure) =>
      ctx.storage.transactionSync(closure)
    );
    this.messageRepository = new MessageRepository(
      this.sql,
      (closure) => ctx.storage.transactionSync(closure),
      this.attachmentRepository,
      this.eventRepository
    );
    this.participantRepository = new ParticipantRepository(this.sql);
    this.wsClientMappingRepository = new WsClientMappingRepository(this.sql);
    this.sandboxRepository = new SandboxRepository(this.sql);
    this.sessionCoreRepository = new SessionCoreRepository(this.sql, (closure) =>
      ctx.storage.transactionSync(closure)
    );
    this.log = createLogger("session-do", {}, parseLogLevel(env.LOG_LEVEL));
    const ensureInitialized = () => this.ensureInitialized();
    const clock: Clock = {
      nowMs: () => Date.now(),
      monotonicNowMs: () => performance.now(),
    };
    const sockets: SocketRegistry<WebSocket, ClientInfo> = {
      classify: (ws) => this.wsManager.classify(ws),
      send: (ws, message) => this.safeSend(ws, message),
      getClient: (ws) => this.getClientInfo(ws),
      close: (ws, code, reason) => this.wsManager.close(ws, code, reason),
      clearSandboxIfMatch: (ws) => this.wsManager.clearSandboxSocketIfMatch(ws),
      removeClient: (ws) => this.wsManager.removeClient(ws),
      hasParticipant: (participantId) =>
        Array.from(this.wsManager.getAuthenticatedClients()).some(
          (client) => client.participantId === participantId
        ),
    };
    const clientCommands: SessionClientCommands<WebSocket, ClientInfo> = {
      subscribe: (ws, message) => this.handleSubscribe(ws, message),
      submitPrompt: (ws, client, message) => this.handlePromptMessage(ws, client, message),
      cancelPrompt: (ws, message) => this.messageQueue.cancelQueuedPrompt(ws, message),
      stopExecution: () => this.stopExecution(),
      notifyTyping: () => this.presenceService.handleTyping(),
      updatePresence: (client, message) => this.presenceService.updatePresence(client, message),
      getHistoryPage: (message) => this.eventStream.getHistoryPage(message),
    };
    const sandboxDisconnects: SandboxDisconnectMonitor = {
      getStatus: () => this.getSandbox()?.status,
      scheduleCheck: () => this.lifecycleManager.scheduleDisconnectCheck(),
    };
    const broadcaster: SessionBroadcaster = {
      broadcastPresence: () => this.presenceService.broadcastPresence(),
      broadcast: (message) => this.broadcast(message),
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
        processSandboxEvent: (event) => this.processSandboxEvent(event),
        clock,
      }),
      disconnects: new SessionDisconnectHandler({
        getLogger: () => this.log,
        sockets,
        sandbox: sandboxDisconnects,
        broadcaster,
      }),
      handleScheduledDeadline: () => this.alarmHandler.handle(),
    });
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
        this.db && this.env.TOKEN_ENCRYPTION_KEY
          ? new UserScmTokenStore(this.db, this.env.TOKEN_ENCRYPTION_KEY)
          : null;
      this._participantService = new ParticipantService({
        repository: this.participantRepository,
        getProcessingMessageAuthor: () => this.messageRepository.getProcessingMessageAuthor(),
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
        repository: this.sessionCoreRepository,
        messageRepository: this.messageRepository,
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
        messenger: this.messenger,
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
      this._wsManager = new SessionWebSocketManagerImpl(
        this.ctx,
        this.sandboxRepository,
        this.wsClientMappingRepository,
        this.log,
        { authTimeoutMs: WS_AUTH_TIMEOUT_MS }
      );
    }
    return this._wsManager;
  }

  private get connections(): DurableObjectSessionConnections {
    if (!this._connections) {
      this._connections = new DurableObjectSessionConnections(this.ctx, this.wsManager);
    }
    return this._connections;
  }

  private get executionTimeoutMs(): number {
    try {
      const sandboxTimeoutMs = parsePersistedSandboxSettings(
        this.sessionCoreRepository.getSession()?.sandbox_settings ?? null
      ).sandboxTimeoutMs;
      // This watchdog starts before bridge setup, so it must not race the
      // bridge's earlier snapshot-reserved prompt deadline.
      if (sandboxTimeoutMs !== undefined) return sandboxTimeoutMs;
    } catch {
      this.log.warn("Failed to parse sandbox_settings for execution timeout, using fallback");
    }
    return parseInt(
      this.env.EXECUTION_TIMEOUT_MS || String(DEFAULT_SANDBOX_TIMEOUT_SECONDS * 1000),
      10
    );
  }

  private get alarmScheduler(): AlarmScheduler {
    if (!this._alarmScheduler) {
      this._alarmScheduler = createEarliestAlarmScheduler(this.ctx.storage);
    }
    return this._alarmScheduler;
  }

  private get messageQueue(): SessionMessageQueue {
    if (!this._messageQueue) {
      this._messageQueue = new SessionMessageQueue(
        this.backgroundJobs,
        this.log,
        this.sessionCoreRepository,
        this.messageRepository,
        this.participantRepository,
        this.attachmentRepository,
        this.wsManager,
        this.messenger,
        this.participantService,
        this.callbackService,
        this.statusService,
        (messageId, messageCreatedAt, completedAt) =>
          this.terminalMessageProjection.recordTerminalMessage({
            messageId,
            messageCreatedAt,
            terminalMessageCompletedAt: completedAt,
          }),
        this.lifecycleManager,
        this.db ? new SessionIndexStore(this.db) : null,
        resolveScmProviderFromEnv(this.env.SCM_PROVIDER),
        this.alarmScheduler,
        this.executionTimeoutMs
      );
    }

    return this._messageQueue;
  }

  private get terminalMessageProjection(): SessionTerminalMessageProjection {
    if (!this._terminalMessageProjection) {
      this._terminalMessageProjection = new SessionTerminalMessageProjection(
        this.db ? new SessionIndexStore(this.db) : null,
        () => {
          const session = this.getSession();
          return session ? this.getPublicSessionId(session) : null;
        },
        this.log
      );
    }
    return this._terminalMessageProjection;
  }

  private get messageService(): MessageService {
    if (!this._messageService) {
      this._messageService = new MessageService({
        repository: this.messageRepository,
        eventRepository: this.eventRepository,
        artifactRepository: this.artifactRepository,
        messageQueue: this.messageQueue,
        stopExecution: () => this.stopExecution(),
        parseArtifactMetadata: (artifact) => this.parseArtifactMetadata(artifact),
      });
    }

    return this._messageService;
  }

  private get eventStream(): SessionEventStream {
    if (!this._eventStream) {
      this._eventStream = new SessionEventStream(this.eventRepository);
    }

    return this._eventStream;
  }

  private get messagesHandler(): MessagesHandler {
    if (!this._messagesHandler) {
      this._messagesHandler = createMessagesHandler({
        messageService: this.messageService,
      });
    }

    return this._messagesHandler;
  }

  private get childSessionsHandler(): ChildSessionsHandler {
    if (!this._childSessionsHandler) {
      this._childSessionsHandler = createChildSessionsHandler({
        messageRepository: this.messageRepository,
        eventRepository: this.eventRepository,
        participantRepository: this.participantRepository,
        artifactRepository: this.artifactRepository,
        getSession: () => this.getSession(),
        getSandbox: () => this.getSandbox(),
        getPublicSessionId: (session) => this.getPublicSessionId(session),
        parseArtifactMetadata: (artifact) => this.parseArtifactMetadata(artifact),
        messenger: this.messenger,
        messageService: this.messageService,
      });
    }

    return this._childSessionsHandler;
  }

  private get sandboxHandler(): SandboxHandler {
    if (!this._sandboxHandler) {
      this._sandboxHandler = createSandboxHandler({
        messageRepository: this.messageRepository,
        eventRepository: this.eventRepository,
        participantRepository: this.participantRepository,
        artifactRepository: this.artifactRepository,
        processSandboxEvent: (event) => this.processSandboxEvent(event),
        getSandbox: () => this.getSandbox(),
        isValidSandboxToken: (token, sandbox) => this.isValidSandboxToken(token, sandbox),
        getSession: () => this.getSession(),
        refreshOpenAIToken: async (session, log) => {
          const service = new OpenAITokenRefreshService(
            this.db!,
            this.env.REPO_SECRETS_ENCRYPTION_KEY!,
            (sessionRow) => this.ensureRepoId(sessionRow),
            log
          );
          return service.refresh(session);
        },
        refreshXaiToken: async (session, log) => {
          const service = new XaiTokenRefreshService(
            this.db!,
            this.env.REPO_SECRETS_ENCRYPTION_KEY!,
            (sessionRow) => this.ensureRepoId(sessionRow),
            log
          );
          return service.refresh(session);
        },
        isManagedSecretsConfigured: () => Boolean(this.db && this.env.REPO_SECRETS_ENCRYPTION_KEY),
        getScmCredentials: (log) =>
          new ScmCredentialsService(this.sourceControlProvider, log).getCredentials(),
        messenger: this.messenger,
        generateId: () => generateId(),
        now: () => Date.now(),
      });
    }

    return this._sandboxHandler;
  }

  private get attachmentsHandler(): AttachmentsHandler {
    if (!this._attachmentsHandler) {
      this._attachmentsHandler = new AttachmentsHandler(this.attachmentRepository, this.log);
    }

    return this._attachmentsHandler;
  }

  private get wsTokenHandler(): WsTokenHandler {
    if (!this._wsTokenHandler) {
      this._wsTokenHandler = createWsTokenHandler({
        repository: this.participantRepository,
        getParticipantByUserId: (userId) => this.participantService.getByUserId(userId),
        generateId: (bytes) => generateId(bytes),
        hashToken: (token) => hashToken(token),
        now: () => Date.now(),
      });
    }

    return this._wsTokenHandler;
  }

  private get sessionLifecycleHandler(): SessionLifecycleHandler {
    if (!this._sessionLifecycleHandler) {
      this._sessionLifecycleHandler = createSessionLifecycleHandler({
        sessionCoreRepository: this.sessionCoreRepository,
        sandboxRepository: this.sandboxRepository,
        messageRepository: this.messageRepository,
        participantRepository: this.participantRepository,
        getDurableObjectId: () => this.ctx.id.toString(),
        tokenEncryptionKey: this.env.TOKEN_ENCRYPTION_KEY,
        encryptToken: (token, encryptionKey) => encryptToken(token, encryptionKey),
        validateReasoningEffort: (model, effort) =>
          validateReasoningEffort(model, effort, this.log),
        generateId: (bytes) => generateId(bytes),
        now: () => Date.now(),
        scheduleWarmSandbox: () =>
          this.backgroundJobs.submit(
            this.warmSandbox().catch((error) => {
              this.log.error("sandbox.warm.background_error", {
                error: error instanceof Error ? error : String(error),
              });
            })
          ),
        getSession: () => this.getSession(),
        getSandbox: () => this.getSandbox(),
        getPublicSessionId: (session) => this.getPublicSessionId(session),
        getParticipantByUserId: (userId) => this.participantService.getByUserId(userId),
        statusService: this.statusService,
        applySessionTitleUpdate: (title, options) => this.applySessionTitleUpdate(title, options),
        cancelSession: async () => {
          await this.statusService.cancel(() => this.messageQueue.cancelExecution());
        },
        getSandboxSocket: () => this.wsManager.getSandboxSocket(),
        sendToSandbox: (ws, message) => this.wsManager.send(ws, message),
        updateSandboxStatus: (status) => this.updateSandboxStatus(status),
      });
    }

    return this._sessionLifecycleHandler;
  }

  private get pullRequestHandler(): PullRequestHandler {
    if (!this._pullRequestHandler) {
      this._pullRequestHandler = createPullRequestHandler({
        getSession: () => this.getSession(),
        getSessionRepositories: () => this.sessionCoreRepository.getSessionRepositories(),
        getPromptingParticipantForPR: () => this.participantService.getPromptingParticipantForPR(),
        resolveAuthForPR: (participant) => this.participantService.resolveAuthForPR(participant),
        getSessionUrl: (session) => {
          const sessionId = session.session_name || session.id;
          const webAppUrl = this.env.WEB_APP_URL || this.env.WORKER_URL || "";
          return webAppUrl + "/session/" + sessionId;
        },
        createPullRequest: async (input, log) => {
          const pullRequestService = new SessionPullRequestService({
            repository: this.sessionCoreRepository,
            artifactRepository: this.artifactRepository,
            claims: this.prCreationClaims,
            sourceControlProvider: this.sourceControlProvider,
            log,
            generateId: () => generateId(),
            pushBranchToRemote: (pushSpec) => this.pushBranchToRemote(pushSpec),
            messenger: this.messenger,
            appName: resolveAppName(this.env),
            sessionPullRequests: this.db ? new SessionPullRequestStore(this.db) : undefined,
            resolveScmSettings: (repo) => this.resolveScmSettings(repo),
          });

          return pullRequestService.createPullRequest(input);
        },
        getArtifactById: (artifactId) => this.artifactRepository.getArtifactById(artifactId),
        updateArtifact: (artifactId, data) =>
          this.artifactRepository.updateArtifact(artifactId, data),
        messenger: this.messenger,
        now: () => Date.now(),
        triggerPullRequestRefresh: () => this.schedulePullRequestRefresh("manual"),
      });
    }

    return this._pullRequestHandler;
  }

  /** Fire a background read-through refresh; failures only log. */
  private schedulePullRequestRefresh(trigger: "open" | "manual"): void {
    this.backgroundJobs.submit(
      refreshSessionPullRequests(
        this.sessionCoreRepository,
        this.artifactRepository,
        this.sourceControlProvider,
        this.db ? new SessionPullRequestStore(this.db) : null
      )
        .then(({ updated, failures }) => {
          for (const artifact of updated) {
            this.broadcast({ type: "artifact_updated", artifact });
          }
          for (const failure of failures) {
            this.log.error("Pull request refresh failed for artifact", {
              trigger,
              reason: failure.reason,
              artifact_id: failure.artifactId,
              pr_number: failure.prNumber,
              repo_owner: failure.repoOwner,
              repo_name: failure.repoName,
              error: failure.error instanceof Error ? failure.error : String(failure.error),
            });
          }
        })
        .catch((error) => {
          this.log.error("Pull request refresh failed", {
            trigger,
            error: error instanceof Error ? error : String(error),
          });
        })
    );
  }

  private get participantsHandler(): ParticipantsHandler {
    if (!this._participantsHandler) {
      this._participantsHandler = createParticipantsHandler({
        repository: this.participantRepository,
      });
    }

    return this._participantsHandler;
  }

  /**
   * Resolves SCM settings (global defaults merged with the per-repo override)
   * for the pull request's target repository. A deployment without D1 cannot
   * have this policy configured, so it retains the built-in defaults; storage
   * failures propagate to fail closed.
   */
  private async resolveScmSettings(repo: RepoIdentity): Promise<ScmSettings> {
    if (!this.db) return {};
    const scmSettingsStore = new ScmSettingsStore(this.db);
    return scmSettingsStore.getResolvedSettings(`${repo.repoOwner}/${repo.repoName}`);
  }

  private get alarmHandler(): AlarmHandler {
    if (!this._alarmHandler) {
      this._alarmHandler = createAlarmHandler({
        repository: this.messageRepository,
        messageQueue: this.messageQueue,
        lifecycleManager: this.lifecycleManager,
        alarmScheduler: this.alarmScheduler,
        executionTimeoutMs: this.executionTimeoutMs,
        now: () => Date.now(),
        log: this.log,
      });
    }

    return this._alarmHandler;
  }

  private get sandboxEventProcessor(): SessionSandboxEventProcessor {
    if (!this._sandboxEventProcessor) {
      this._sandboxEventProcessor = new SessionSandboxEventProcessor(
        this.backgroundJobs,
        () => this.log,
        this.sessionCoreRepository,
        this.sandboxRepository,
        this.messageRepository,
        this.eventRepository,
        this.artifactRepository,
        this.callbackService,
        this.wsManager,
        this.messenger,
        this.diffService,
        (title, options) => this.applySessionTitleUpdate(title, options),
        (reason) => this.triggerSnapshot(reason),
        (messageId, messageCreatedAt, completedAt) =>
          this.terminalMessageProjection.recordTerminalMessage({
            messageId,
            messageCreatedAt,
            terminalMessageCompletedAt: completedAt,
          }),
        this.statusService,
        (timestamp) => this.updateLastActivity(timestamp),
        () => this.scheduleInactivityCheck(),
        () => this.messageQueue.processMessageQueue(),
        () => this.messageQueue.broadcastPromptQueue()
      );
    }

    return this._sandboxEventProcessor;
  }

  /**
   * Get the session status service, creating it lazily if needed.
   * Lazy initialization ensures the session-scoped logger and messenger
   * (set by ensureInitialized()) exist by the time the service is created.
   */
  private get statusService(): SessionStatusService {
    if (!this._statusService) {
      this._statusService = new SessionStatusService(
        this.backgroundJobs,
        this.log,
        this.sessionCoreRepository,
        this.messageRepository,
        this.artifactRepository,
        this.messenger,
        this.db ? new SessionIndexStore(this.db) : null,
        this.env.SESSION ?? null
      );
    }

    return this._statusService;
  }

  /**
   * Create the source control provider.
   */
  private createSourceControlProvider(): SourceControlProvider {
    return createSourceControlProviderFromEnv(this.env);
  }

  /**
   * Create the lifecycle manager with all required adapters.
   */
  private createLifecycleManager(): SandboxLifecycleManager {
    const sandboxBackend = resolveSandboxBackendName(this.env.SANDBOX_PROVIDER);

    const provider = createSandboxProviderFromEnv(this.env, sandboxBackend);

    // Storage adapter
    const storage: SandboxStorage = {
      getSandbox: () => this.sandboxRepository.getSandbox(),
      getSandboxWithCircuitBreaker: () => this.sandboxRepository.getSandboxWithCircuitBreaker(),
      getSession: () => this.sessionCoreRepository.getSession(),
      getSessionRepositories: () =>
        this.sessionCoreRepository.getSessionRepositories().map((entry) => ({
          repoOwner: entry.repoOwner,
          repoName: entry.repoName,
          baseBranch: entry.baseBranch ?? "main",
          baseSha: entry.row?.base_sha ?? null,
        })),
      getUserEnvVars: () => this.getUserEnvVars(),
      updateSandboxStatus: (status) => this.updateSandboxStatus(status),
      updateSandboxForSpawn: (data) => this.sandboxRepository.updateSandboxForSpawn(data),
      updateSandboxForResume: (data) => this.sandboxRepository.updateSandboxForResume(data),
      updateSandboxModalObjectId: (id) => this.sandboxRepository.updateSandboxModalObjectId(id),
      updateSandboxSnapshotImageId: (sandboxId, imageId) =>
        this.sandboxRepository.updateSandboxSnapshotImageId(sandboxId, imageId),
      updateSandboxLastActivity: (timestamp) =>
        this.sandboxRepository.updateSandboxLastActivity(timestamp),
      incrementCircuitBreakerFailure: (timestamp) =>
        this.sandboxRepository.incrementCircuitBreakerFailure(timestamp),
      resetCircuitBreaker: () => this.sandboxRepository.resetCircuitBreaker(),
      setLastSpawnError: (error, timestamp) =>
        this.sandboxRepository.updateSandboxSpawnError(error, timestamp),
      updateSandboxCodeServer: async (url, password) => {
        const encrypted = this.env.REPO_SECRETS_ENCRYPTION_KEY
          ? await encryptToken(password, this.env.REPO_SECRETS_ENCRYPTION_KEY)
          : password;
        this.sandboxRepository.updateSandboxCodeServer(url, encrypted);
      },
      clearSandboxCodeServer: () => this.sandboxRepository.clearSandboxCodeServer(),
      clearSandboxCodeServerUrl: () => this.sandboxRepository.clearSandboxCodeServerUrl(),
      updateSandboxVnc: async (url, password) => {
        const encrypted = this.env.REPO_SECRETS_ENCRYPTION_KEY
          ? await encryptToken(password, this.env.REPO_SECRETS_ENCRYPTION_KEY)
          : password;
        this.sandboxRepository.updateSandboxVnc(url, encrypted);
      },
      clearSandboxVnc: () => this.sandboxRepository.clearSandboxVnc(),
      clearSandboxVncUrl: () => this.sandboxRepository.clearSandboxVncUrl(),
      updateSandboxTunnelUrls: (urls) => this.sandboxRepository.updateSandboxTunnelUrls(urls),
      clearSandboxTunnelUrls: () => this.sandboxRepository.clearSandboxTunnelUrls(),
      updateSandboxTtyd: async (url, token) => {
        const encrypted = this.env.REPO_SECRETS_ENCRYPTION_KEY
          ? await encryptToken(token, this.env.REPO_SECRETS_ENCRYPTION_KEY)
          : token;
        this.sandboxRepository.updateSandboxTtyd(url, encrypted);
      },
      clearSandboxTtyd: () => this.sandboxRepository.clearSandboxTtyd(),
    };

    // Broadcaster adapter
    const broadcaster: SandboxBroadcaster = {
      broadcast: (message) => this.broadcast(message as ServerMessage),
    };

    // WebSocket manager adapter — thin delegation to wsManager
    const wsManager: WebSocketManager = {
      getSandboxWebSocket: () => this.wsManager.getSandboxSocket(),
      detachSandboxWebSocket: (code, reason) => this.wsManager.detachSandboxSocket(code, reason),
      sendToSandbox: (message) => {
        const ws = this.wsManager.getSandboxSocket();
        return ws ? this.wsManager.send(ws, message) : false;
      },
      getConnectedClientCount: () => this.wsManager.getConnectedClientCount(),
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
    const session = this.sessionCoreRepository.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();

    // Create D1-backed lookups if database is available
    let mcpServerLookup: McpServerLookup | undefined;
    if (this.db) {
      const mcpStore = new McpServerStore(this.db, this.env.REPO_SECRETS_ENCRYPTION_KEY);
      mcpServerLookup = {
        getDecryptedForSession: (repositories) => mcpStore.getDecryptedForSession(repositories),
      };
    }

    // Session-scoped gate: resolved from the primary member (the scalar mirror
    // this lookup is called with) — see resolveSessionScopedSettings for the
    // per-feature scope rules. Token absence short-circuits to false so a
    // misconfigured deployment never installs a tool that would 503 on every call.
    let slackAgentNotifyLookup: SlackAgentNotifyLookup | undefined;
    if (this.db) {
      const tokenPresent = !!this.env.SLACK_BOT_TOKEN;
      const settingsStore = new IntegrationSettingsStore(this.db);
      slackAgentNotifyLookup = {
        isEnabledForRepo: async (repoOwner, repoName) => {
          if (!tokenPresent) return false;
          const settings =
            repoOwner && repoName
              ? (await settingsStore.getResolvedConfig("slack", `${repoOwner}/${repoName}`))
                  .settings
              : ((await settingsStore.getGlobal("slack"))?.defaults ?? {});
          return resolveSlackSettings(settings).agentNotificationsEnabled;
        },
      };
    }

    const sandboxDashboardUrlBuilder =
      sandboxBackend === "modal"
        ? (providerObjectId: string) => this.getSandboxDashboardUrl(providerObjectId)
        : undefined;

    const config = {
      ...DEFAULT_LIFECYCLE_CONFIG,
      controlPlaneUrl,
      model: DEFAULT_MODEL,
      sessionId,
      inactivity: {
        ...DEFAULT_LIFECYCLE_CONFIG.inactivity,
        timeoutMs: parseInt(this.env.SANDBOX_INACTIVITY_TIMEOUT_MS || "600000", 10),
      },
      mcpServerLookup,
      slackAgentNotifyLookup,
      sandboxDashboardUrlBuilder,
    };

    // Create the image lookup if D1 is available and the provider supports
    // prebuilt images.
    let imageBuildLookup: ImageBuildLookup | undefined;
    const imageBuildProvider = resolveImageBuildProvider(sandboxBackend);
    if (this.db && imageBuildProvider) {
      imageBuildLookup = createImageBuildLookup(this.db, imageBuildProvider);
    }

    return new SandboxLifecycleManager(
      provider,
      storage,
      broadcaster,
      wsManager,
      this.alarmScheduler,
      idGenerator,
      config,
      {
        onSandboxTerminating: () => this.messageQueue.failStuckProcessingMessage(),
        onSandboxTerminated: () => this.messageQueue.resumeAfterSandboxTermination(),
      },
      imageBuildLookup
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
    const session = this.sessionCoreRepository.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();
    this.log = createLogger(
      "session-do",
      { session_id: sessionId },
      parseLogLevel(this.env.LOG_LEVEL)
    );
    // Constructed here rather than in the constructor so they (and the
    // WebSocket manager they force) capture the session-scoped logger,
    // never the request-scoped child installed by fetch().
    this.messenger = new SessionMessengerImpl(this.connections);
    this.diffService = new SessionDiffService(
      new SessionDiffStore(this.sql),
      this.sessionCoreRepository,
      this.messenger,
      this.log
    );
    this.diffsHandler = new SessionDiffsHandler(this.diffService);
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
      const sandbox = this.getSandbox();
      const expectedSandboxId = sandbox?.modal_sandbox_id;

      // Reject connection if sandbox should be stopped (prevents reconnection after inactivity timeout).
      // Deliberately narrower than isDeadSandboxStatus: a "failed" sandbox may
      // still connect — a slow boot that outlived the connecting watchdog
      // self-heals here by flipping the status back to ready.
      if (sandbox && isSandboxReconnectBlockedStatus(sandbox.status)) {
        log.warn("ws.connect", {
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
      const tokenMatches = await this.isValidSandboxToken(providedToken, sandbox);
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

      // Auth passed — continue to WebSocket accept below
      // The success ws.connect event is emitted after the WebSocket is accepted
    }

    try {
      const { client, server } = this.connections.createUpgradeSockets();

      const sandboxId = request.headers.get("X-Sandbox-ID");

      if (isSandbox) {
        // The lifecycle manager publishes access after any pending provider
        // startup has persisted its URLs and credentials.
        const accessIsPersisted = !this.lifecycleManager.isProviderStartupPending();
        const { replaced } = this.wsManager.acceptAndSetSandboxSocket(
          server,
          sandboxId ?? undefined
        );
        // Notify manager that sandbox connected so it can reset the spawning flag
        this.lifecycleManager.onSandboxConnected();
        this.updateSandboxStatus("ready");
        this.broadcast({ type: "sandbox_status", status: "ready" });
        if (accessIsPersisted) {
          this.broadcast({ type: "sandbox_access_changed" });
        }

        // Set initial activity timestamp and schedule inactivity check
        // IMPORTANT: Must await to ensure alarm is scheduled before returning
        const now = Date.now();
        this.updateLastActivity(now);
        this.sandboxRepository.updateSandboxHeartbeat(now);
        await this.scheduleInactivityCheck();

        log.info("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "success",
          sandbox_id: sandboxId,
          replaced_existing: replaced,
          duration_ms: Date.now() - now,
        });

        // Process any pending messages now that sandbox is connected
        this.backgroundJobs.submit(
          this.processMessageQueue().catch((error) => {
            log.error("message_queue.process.background_error", {
              error: error instanceof Error ? error : String(error),
            });
          })
        );
      } else {
        const wsId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        this.wsManager.acceptClientSocket(server, wsId);
        this.backgroundJobs.submit(this.wsManager.enforceAuthTimeout(server, wsId));
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
   * Handle client subscription with token validation.
   */
  private async handleSubscribe(
    ws: WebSocket,
    data: {
      token: string;
      clientId: string;
    }
  ): Promise<void> {
    // Validate the WebSocket auth token
    if (!data.token) {
      this.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "auth_failed",
        reject_reason: "no_token",
      });
      this.wsManager.close(ws, 4001, "Authentication required");
      return;
    }

    if (this.wsManager.isClientAuthenticated(ws) || this.wsManager.isClientSynchronizing(ws)) {
      this.wsManager.close(ws, 4003, "Already subscribed");
      return;
    }
    this.wsManager.setClientSynchronizing(ws, true);

    try {
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
        this.wsManager.close(ws, 4001, "Invalid authentication token");
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
        this.wsManager.close(ws, 4001, "Token expired");
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
        this.wsManager.close(ws, 4009, "Session synchronization failed");
        return;
      }

      this.presenceService.sendPresence(ws);
      this.presenceService.broadcastPresence();
      this.schedulePullRequestRefresh("open");
    } finally {
      this.wsManager.setClientSynchronizing(ws, false);
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
    const snapshot = this.readSessionSnapshot(enrichment);
    if (!snapshot) return false;

    if (
      !this.safeSend(ws, {
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

    this.wsManager.setClient(ws, client);
    const parsed = this.wsManager.classify(ws);
    if (parsed.kind === "client" && parsed.wsId) {
      this.wsManager.persistClientMapping(parsed.wsId, client.participantId, client.clientId);
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
      userId: mapping.canonical_user_id ?? mapping.user_id,
      name: resolveParticipantName(mapping),
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
    client: ClientInfo,
    data: ClientPrompt
  ): Promise<void> {
    await this.messageQueue.handlePromptMessage(ws, client, data);
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
    pushSpec: GitPushSpec
  ): Promise<{ success: true } | { success: false; error: string }> {
    return await this.sandboxEventProcessor.pushBranchToRemote(pushSpec);
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
    this.messenger.broadcast(message);
  }

  private getPublicSessionId(session?: SessionRow | null): string {
    const resolved = session ?? this.getSession();
    return resolved?.session_name || resolved?.id || this.ctx.id.toString();
  }

  private syncSessionIndexTitle(sessionId: string, title: string, updatedAt: number): void {
    if (!this.db) return;
    const sessionStore = new SessionIndexStore(this.db);
    this.backgroundJobs.submit(
      sessionStore.updateTitleIfNewer(sessionId, title, updatedAt).catch((error) => {
        this.log.error("session_index.update_title.background_error", {
          session_id: sessionId,
          title,
          updated_at: updatedAt,
          error,
        });
      })
    );
  }

  private applySessionTitleUpdate(
    title: string,
    options: SessionTitleUpdateOptions = {}
  ): SessionTitleUpdateResult {
    const normalized = normalizeSessionTitle(title);
    if (!normalized.ok) {
      return { ok: false, reason: "invalid", error: normalized.error };
    }
    const titleText = normalized.title;

    const session = this.getSession();
    if (!session) {
      return { ok: false, reason: "not_found", error: "Session not found" };
    }

    const updatedAt = Math.max(Date.now(), session.updated_at + 1);
    if (options.onlyIfUnset) {
      const didUpdate = this.sessionCoreRepository.updateSessionTitleIfUnset(
        session.id,
        titleText,
        updatedAt
      );
      if (!didUpdate) {
        return { ok: false, reason: "already_set", error: "Session title is already set" };
      }
    } else {
      this.sessionCoreRepository.updateSessionTitle(session.id, titleText, updatedAt);
    }

    const publicSessionId = this.getPublicSessionId(session);
    this.syncSessionIndexTitle(publicSessionId, titleText, updatedAt);
    this.broadcast({ type: "session_title", title: titleText });

    if (session.parent_session_id) {
      this.statusService.notifyParentOfChildUpdate(
        { ...session, title: titleText },
        publicSessionId,
        {
          status: session.status,
          title: titleText,
        }
      );
    }

    return { ok: true, title: titleText };
  }

  private async resolveSessionSnapshotEnrichment(): Promise<SessionSnapshotEnrichment> {
    const session = this.getSession();
    const environmentId = session?.environment_id ?? null;
    const environmentName = await this.resolveEnvironmentName(environmentId);
    return { environmentId, environmentName };
  }

  private async decryptStoredAccessValue(value: string | null): Promise<string | null> {
    if (!value) return null;
    if (!this.env.REPO_SECRETS_ENCRYPTION_KEY) return value;
    try {
      return await decryptToken(value, this.env.REPO_SECRETS_ENCRYPTION_KEY);
    } catch (error) {
      this.log.warn("Failed to decrypt stored sandbox access value", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private readSessionState(
    enrichment: SessionSnapshotEnrichment
  ): { session: SessionSnapshotState; sandbox: SandboxRow | null } | null {
    const session = this.getSession();
    if (!session) return null;
    const sandbox = this.getSandbox();
    const publicSession: SessionSnapshotState = {
      id: this.getPublicSessionId(session),
      title: session.title,
      repoOwner: session.repo_owner,
      repoName: session.repo_name,
      baseBranch: session.base_branch,
      branchName: session.branch_name,
      status: session.status,
      sandboxStatus: sandbox?.status ?? "pending",
      messageCount: this.messageRepository.getMessageCount(),
      createdAt: session.created_at,
      model: session.model ?? DEFAULT_MODEL,
      reasoningEffort: session.reasoning_effort ?? undefined,
      isProcessing: this.getIsProcessing(),
      parentSessionId: session.parent_session_id,
      totalCost: session.total_cost ?? 0,
      codeServerUrl: sandbox?.code_server_url ?? null,
      vncUrl: sandbox?.vnc_url ?? null,
      tunnelUrls: sandbox?.tunnel_urls ? this.safeParseTunnelUrls(sandbox.tunnel_urls) : null,
      ttydUrl: sandbox?.ttyd_url ?? null,
      sandboxDashboardUrl: this.getSandboxDashboardUrl(sandbox?.modal_object_id),
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
        artifacts: this.messageService.listArtifacts().artifacts,
        timeline: this.eventStream.getReplay(),
        promptQueue: this.messageRepository.listPromptQueue(),
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
    if (!this.getSession()) {
      return Response.json({ error: "Session not found" }, { status: 404, headers });
    }
    const sandbox = this.getSandbox();
    if (!sandbox || (sandbox.status !== "ready" && sandbox.status !== "running")) {
      return Response.json({ error: "Sandbox access is unavailable" }, { status: 409, headers });
    }

    const [codeServerPassword, vncPassword, ttydToken] = await Promise.all([
      this.decryptStoredAccessValue(sandbox.code_server_password),
      this.decryptStoredAccessValue(sandbox.vnc_password),
      this.decryptStoredAccessValue(sandbox.ttyd_token),
    ]);
    const current = this.getSandbox();
    if (
      !current ||
      current.id !== sandbox.id ||
      (current.status !== "ready" && current.status !== "running") ||
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
    return this.sessionCoreRepository.getSessionRepositories().map((member) => ({
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
    const artifacts = this.artifactRepository
      .listArtifacts()
      .filter((artifact) => artifact.url !== null);
    return (repoOwner, repoName, isPrimary) =>
      findPrArtifactForRepo(artifacts, { repoOwner, repoName }, isPrimary)?.url ?? null;
  }

  private getSandboxDashboardUrl(providerObjectId: string | null | undefined): string | null {
    if (resolveSandboxBackendName(this.env.SANDBOX_PROVIDER) !== "modal") return null;
    return buildModalSandboxDashboardUrl({
      workspace: this.env.MODAL_WORKSPACE,
      modalEnvironment: this.env.MODAL_ENVIRONMENT,
      providerObjectId,
    });
  }

  /**
   * Check if any message is currently being processed.
   */
  private getIsProcessing(): boolean {
    return this.messageRepository.getProcessingMessage() !== null;
  }

  private safeParseTunnelUrls(raw: string): Record<string, string> | null {
    const urls = parseTunnelUrls(raw);
    if (!urls) {
      this.log.warn("Invalid sandbox tunnel_urls JSON");
    }
    return urls;
  }

  // Database helpers

  private getSession(): SessionRow | null {
    return this.sessionCoreRepository.getSession();
  }

  private getSandbox(): SandboxRow | null {
    return this.sandboxRepository.getSandbox();
  }

  private async ensureRepoId(session: SessionRow): Promise<number> {
    if (session.repo_id) {
      return session.repo_id;
    }
    if (!session.repo_owner || !session.repo_name) {
      throw new Error("Session has no repository context");
    }

    const result = await this.sourceControlProvider.checkRepositoryAccess({
      owner: session.repo_owner,
      name: session.repo_name,
    });
    if (!result) {
      throw new Error("Repository is not accessible for the configured SCM provider");
    }

    this.sessionCoreRepository.updateSessionRepoId(result.repoId);
    return result.repoId;
  }

  private async getUserEnvVars(): Promise<Record<string, string> | undefined> {
    const session = this.getSession();
    if (!session) {
      this.log.warn("Cannot load secrets: no session");
      return undefined;
    }

    if (!this.db || !this.env.REPO_SECRETS_ENCRYPTION_KEY) {
      this.log.debug("Secrets not configured, skipping", {
        has_db: !!this.db,
        has_encryption_key: !!this.env.REPO_SECRETS_ENCRYPTION_KEY,
      });
      return undefined;
    }

    // Fail hard on secret loading — sandboxes must not silently lose secrets
    const encryptionKey = this.env.REPO_SECRETS_ENCRYPTION_KEY;
    const globalStore = new GlobalSecretsStore(this.db, encryptionKey);
    const globalSecrets = await globalStore.getDecryptedSecrets();

    const repoStore = new RepoSecretsStore(this.db, encryptionKey);
    const environmentSecretsStore = new EnvironmentSecretsStore(this.db, encryptionKey);
    const members = this.sessionCoreRepository.getSessionRepositories();
    const sources = await buildSessionTargetSecretSources({
      environmentId: session.environment_id,
      globalSecrets,
      members,
      loadMemberSecrets: (member) => this.loadMemberRepoSecrets(session, member, repoStore),
      loadEnvironmentSecrets: (environmentId) =>
        environmentSecretsStore.getDecryptedSecrets(environmentId),
    });

    const merge = mergeSecretSources(sources);
    auditSecretsMerge({
      merge,
      mode: parseSecretsCapMode(this.env.SECRETS_CAP_ENFORCEMENT),
      log: this.log,
      context: { session_id: session.id },
    });

    const mergedCount = Object.keys(merge.merged).length;
    if (mergedCount > 0) {
      this.log.info("Secrets merged for sandbox", {
        source_count: sources.length,
        merged_count: mergedCount,
        payload_bytes: merge.totalBytes,
        exceeds_limit: merge.exceedsLimit,
      });
    }

    if (mergedCount === 0) return undefined;
    const primary = members.find((member) => member.isPrimary);
    const managedSources = session.environment_id
      ? sources
      : sources.filter(
          (source) =>
            source.label === "global" ||
            (primary && source.label === `${primary.repoOwner}/${primary.repoName}`)
        );
    const managedSecrets = mergeSecretSources(managedSources).merged;
    const sandboxEnv = prepareManagedProviderEnv({
      exposedSecrets: merge.merged,
      brokerSecrets: managedSecrets,
    });
    return Object.keys(sandboxEnv).length === 0 ? undefined : sandboxEnv;
  }

  /**
   * Decrypt one member repo's secrets — the injected leaf loader for
   * buildSessionTargetSecretSources. The member row carries the repo id; a
   * synthesized primary (legacy scalar row) resolves it lazily via ensureRepoId.
   * A member without a resolvable id (a secondary with a null row id) can't be
   * keyed, so it contributes nothing.
   */
  private async loadMemberRepoSecrets(
    session: SessionRow,
    member: SessionRepositoryEntry,
    repoStore: RepoSecretsStore
  ): Promise<Record<string, string>> {
    const repoId =
      member.row?.repo_id ?? (member.isPrimary ? await this.ensureRepoId(session) : null);
    if (repoId === null) {
      return {};
    }
    return repoStore.getDecryptedSecrets(repoId);
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
    this.sandboxRepository.updateSandboxStatus(status as SandboxStatus);
  }

  // HTTP handlers

  private parseArtifactMetadata(
    artifact: Pick<ArtifactRow, "id" | "metadata">
  ): Record<string, unknown> | null {
    if (!artifact.metadata) {
      return null;
    }

    try {
      const metadata = parseArtifactMetadataJson(artifact.metadata);
      if (!metadata) {
        this.log.warn("Invalid artifact metadata shape", {
          artifact_id: artifact.id,
        });
        return null;
      }
      return metadata;
    } catch (error) {
      this.log.warn("Invalid artifact metadata JSON", {
        artifact_id: artifact.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
