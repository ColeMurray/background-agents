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
import {
  DEFAULT_MODEL,
  clientMessageSchema,
  isValidReasoningEffort,
  resolveAppName,
  sandboxEventSchema,
  timingSafeEqual,
  type SessionAttachmentReference,
} from "@open-inspect/shared";
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
  type AlarmScheduler,
  type IdGenerator,
  type ImageBuildLookup,
  type McpServerLookup,
  type SlackAgentNotifyLookup,
} from "../sandbox/lifecycle/manager";
import { McpServerStore } from "../db/mcp-servers";
import { IntegrationSettingsStore, resolveSlackSettings } from "../db/integration-settings";
import { ScmSettingsStore } from "../db/scm-settings";
import { SessionIndexStore } from "../db/session-index";
import { DEFAULT_EXECUTION_TIMEOUT_MS } from "../sandbox/lifecycle/decisions";
import {
  createSourceControlProviderFromEnv,
  resolveScmProviderFromEnv,
  type SourceControlProvider,
  type GitPushSpec,
} from "../source-control";
import type {
  Env,
  ClientInfo,
  ServerMessage,
  SandboxEvent,
  SessionRepositoryState,
  SessionState,
  SessionStatus,
  SandboxStatus,
} from "../types";
import type { SessionRow, ArtifactRow, SandboxRow } from "./types";
import { SessionRepository } from "./repository";
import { SessionAttachmentRepository } from "./session-attachment-repository";
import { resolveParticipantName } from "./participant-name";
import { parseTunnelUrls } from "./tunnel-urls";
import { SessionWebSocketManagerImpl, type SessionWebSocketManager } from "./websocket-manager";
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
import type { SessionRepositoryEntry } from "./repository-target";
import { OpenAITokenRefreshService } from "./openai-token-refresh-service";
import { ScmCredentialsService } from "./scm-credentials-service";
import { ParticipantService, getAvatarUrl } from "./participant-service";
import { UserScmTokenStore } from "../db/user-scm-tokens";
import { CallbackNotificationService } from "./callback-notification-service";
import { DOFetcherAdapter } from "../scheduler/do-fetcher-adapter";
import { PresenceService } from "./presence-service";
import { SessionMessageQueue } from "./message-queue";
import { SessionSandboxEventProcessor } from "./sandbox-events";
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
import { SessionDiffStore } from "./diffs/store";
import { SessionDiffService } from "./diffs/service";

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

/** Statuses that indicate a session is finished — metrics are synced to D1 on these transitions. */
const TERMINAL_STATUSES: SessionStatus[] = ["completed", "failed", "cancelled"];

type BoundarySchema<T> = {
  safeParse(
    input: unknown
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
};

export class SessionDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private repository: SessionRepository;
  private attachmentRepository: SessionAttachmentRepository;
  private diffService: SessionDiffService;
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
  // Sandbox event processor (lazily initialized)
  private _sandboxEventProcessor: SessionSandboxEventProcessor | null = null;

  // Internal HTTP route table (transport wiring only; handlers remain on SessionDO).
  private readonly routes = createSessionInternalRoutes({
    init: (request) => this.sessionLifecycleHandler.init(request),
    state: () => this.sessionLifecycleHandler.getState(),
    prompt: (request) => this.messagesHandler.enqueuePrompt(request),
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
    createPr: (request) => this.pullRequestHandler.createPr(request),
    pullRequestArtifactSnapshot: (request, url) =>
      this.pullRequestHandler.pullRequestArtifactSnapshot(request, url),
    pullRequestsRefresh: () => this.pullRequestHandler.refreshPullRequests(),
    wsToken: (request) => this.wsTokenHandler.generateWsToken(request),
    updateTitle: (request) => this.sessionLifecycleHandler.updateTitle(request),
    archive: (request) => this.sessionLifecycleHandler.archive(request),
    unarchive: (request) => this.sessionLifecycleHandler.unarchive(request),
    verifySandboxToken: (request) => this.sandboxHandler.verifySandboxToken(request),
    openaiTokenRefresh: () => this.sandboxHandler.openaiTokenRefresh(),
    scmCredentials: () => this.sandboxHandler.scmCredentials(),
    tunnelUrls: () => this.sandboxHandler.tunnelUrls(),
    spawnContext: () => this.childSessionsHandler.getSpawnContext(),
    childSummary: (_request, url) => this.childSessionsHandler.getChildSummary(url),
    cancel: () => this.sessionLifecycleHandler.cancel(),
    childSessionUpdate: (request) => this.childSessionsHandler.childSessionUpdate(request),
    diffState: () => this.diffService.handleState(),
    diffStore: (request) => this.diffService.handleUpload(request),
    diffFailure: (request) => this.diffService.handleFailure(request),
    diffResolveFile: (_request, url) => this.diffService.handleResolveFile(url),
    diffRetry: () => this.diffService.handleRetry(),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.attachmentRepository = new SessionAttachmentRepository(this.sql);
    this.repository = new SessionRepository(
      this.sql,
      (closure) => ctx.storage.transactionSync(closure),
      this.attachmentRepository
    );
    this.log = createLogger("session-do", {}, parseLogLevel(env.LOG_LEVEL));
    this.diffService = new SessionDiffService({
      store: new SessionDiffStore(this.sql),
      repository: this.repository,
      storage: ctx.storage,
      log: this.log,
      generateId: () => generateId(),
      now: () => Date.now(),
      hasSandboxConnection: () => Boolean(this.wsManager.getSandboxSocket()),
      sendRefreshCommand: (command) => {
        const sandboxSocket = this.wsManager.getSandboxSocket();
        return sandboxSocket ? this.wsManager.send(sandboxSocket, command) : false;
      },
      broadcast: (message) => this.broadcast(message),
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
        attachmentRepository: this.attachmentRepository,
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

  private get eventStream(): SessionEventStream {
    if (!this._eventStream) {
      this._eventStream = new SessionEventStream(this.repository);
    }

    return this._eventStream;
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
        parseArtifactMetadata: (artifact) => this.parseArtifactMetadata(artifact),
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
        getScmCredentials: () =>
          new ScmCredentialsService(this.sourceControlProvider, this.log).getCredentials(),
        broadcast: (message) => this.broadcast(message),
        generateId: () => generateId(),
        now: () => Date.now(),
        getLog: () => this.log,
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
        applySessionTitleUpdate: (title, options) => this.applySessionTitleUpdate(title, options),
        stopExecution: (options) => this.stopExecution(options),
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
        getSessionRepositories: () => this.repository.getSessionRepositories(),
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
            claims: this.prCreationClaims,
            sourceControlProvider: this.sourceControlProvider,
            log: this.log,
            generateId: () => generateId(),
            pushBranchToRemote: (pushSpec) => this.pushBranchToRemote(pushSpec),
            broadcastSessionBranch: (branchName, repo) => {
              this.broadcast({
                type: "session_branch",
                branchName,
                repoOwner: repo.repoOwner,
                repoName: repo.repoName,
              });
            },
            broadcastArtifactCreated: (artifact) => {
              this.broadcast({
                type: "artifact_created",
                artifact,
              });
            },
            appName: resolveAppName(this.env),
            sessionPullRequests: this.env.DB ? new SessionPullRequestStore(this.env.DB) : undefined,
            resolveAlwaysDraftDefault: () => this.resolveAlwaysDraftDefault(),
          });

          return pullRequestService.createPullRequest(input);
        },
        getArtifactById: (artifactId) => this.repository.getArtifactById(artifactId),
        updateArtifact: (artifactId, data) => this.repository.updateArtifact(artifactId, data),
        broadcastArtifactUpdated: (artifact) => {
          this.broadcast({
            type: "artifact_updated",
            artifact,
          });
        },
        now: () => Date.now(),
        triggerPullRequestRefresh: () => this.schedulePullRequestRefresh("manual"),
      });
    }

    return this._pullRequestHandler;
  }

  /** Fire a background read-through refresh; failures only log. */
  private schedulePullRequestRefresh(trigger: "open" | "manual"): void {
    this.ctx.waitUntil(
      refreshSessionPullRequests(
        this.repository,
        this.sourceControlProvider,
        this.env.DB ? new SessionPullRequestStore(this.env.DB) : null
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
        repository: this.repository,
      });
    }

    return this._participantsHandler;
  }

  /**
   * Resolves the "always use draft mode" SCM setting (global default merged
   * with the per-repo override) for this session's repository. Returns false
   * when D1 is unavailable so PR creation never blocks on settings.
   */
  private async resolveAlwaysDraftDefault(): Promise<boolean> {
    if (!this.env.DB) return false;
    const session = this.getSession();
    if (!session) return false;
    try {
      const scmSettingsStore = new ScmSettingsStore(this.env.DB);
      const settings = await scmSettingsStore.getResolvedSettings(
        `${session.repo_owner}/${session.repo_name}`
      );
      return settings.alwaysUseDraftMode === true;
    } catch (error) {
      this.log.error("Failed to resolve always-draft setting", {
        error: error instanceof Error ? error : String(error),
      });
      return false;
    }
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
        applySessionTitleUpdate: (title, options) => this.applySessionTitleUpdate(title, options),
        getIsProcessing: () => this.getIsProcessing(),
        triggerSnapshot: (reason) => this.triggerSnapshot(reason),
        reconcileSessionStatusAfterExecution: async (success) => {
          await this.reconcileSessionStatusAfterExecution(success);
        },
        updateLastActivity: (timestamp) => this.updateLastActivity(timestamp),
        scheduleInactivityCheck: () => this.scheduleInactivityCheck(),
        processMessageQueue: () => this.messageQueue.processMessageQueue(),
        handleReady: (event) => this.diffService.handleReady(event),
      });
    }

    return this._sandboxEventProcessor;
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
      getSandbox: () => this.repository.getSandbox(),
      getSandboxWithCircuitBreaker: () => this.repository.getSandboxWithCircuitBreaker(),
      getSession: () => this.repository.getSession(),
      getSessionRepositories: () =>
        this.repository.getSessionRepositories().map((entry) => ({
          repoOwner: entry.repoOwner,
          repoName: entry.repoName,
          baseBranch: entry.baseBranch ?? "main",
          baseSha: entry.row?.base_sha ?? null,
        })),
      getUserEnvVars: () => this.getUserEnvVars(),
      updateSandboxStatus: (status) => this.updateSandboxStatus(status),
      updateSandboxForSpawn: (data) => this.repository.updateSandboxForSpawn(data),
      updateSandboxForResume: (data) => this.repository.updateSandboxForResume(data),
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
      clearSandboxCodeServerUrl: () => this.repository.clearSandboxCodeServerUrl(),
      updateSandboxTunnelUrls: (urls) => this.repository.updateSandboxTunnelUrls(urls),
      clearSandboxTunnelUrls: () => this.repository.clearSandboxTunnelUrls(),
      updateSandboxTtyd: async (url, token) => {
        const encrypted = this.env.REPO_SECRETS_ENCRYPTION_KEY
          ? await encryptToken(token, this.env.REPO_SECRETS_ENCRYPTION_KEY)
          : token;
        this.repository.updateSandboxTtyd(url, encrypted);
      },
      clearSandboxTtyd: () => this.repository.clearSandboxTtyd(),
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

    // Create D1-backed lookups if database is available
    let mcpServerLookup: McpServerLookup | undefined;
    if (this.env.DB) {
      const mcpStore = new McpServerStore(this.env.DB, this.env.REPO_SECRETS_ENCRYPTION_KEY);
      mcpServerLookup = {
        getDecryptedForSession: (repositories) => mcpStore.getDecryptedForSession(repositories),
      };
    }

    // Session-scoped gate: resolved from the primary member (the scalar mirror
    // this lookup is called with) — see resolveSessionScopedSettings for the
    // per-feature scope rules. Token absence short-circuits to false so a
    // misconfigured deployment never installs a tool that would 503 on every call.
    let slackAgentNotifyLookup: SlackAgentNotifyLookup | undefined;
    if (this.env.DB) {
      const tokenPresent = !!this.env.SLACK_BOT_TOKEN;
      const settingsStore = new IntegrationSettingsStore(this.env.DB);
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
    if (this.env.DB && imageBuildProvider) {
      imageBuildLookup = createImageBuildLookup(this.env.DB, imageBuildProvider);
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

      // Reject connection if sandbox should be stopped (prevents reconnection after inactivity timeout).
      // Deliberately narrower than isDeadSandboxStatus: a "failed" sandbox may
      // still connect — a slow boot that outlived the connecting watchdog
      // self-heals here by flipping the status back to ready.
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
          // If the participant still has other authenticated sockets (e.g. another
          // browser tab), don't send presence_leave — the client filters by userId
          // and would remove them entirely. Broadcast a refresh instead.
          const stillPresent = Array.from(this.wsManager.getAuthenticatedClients()).some(
            (c) => c.participantId === client.participantId
          );
          if (stillPresent) {
            this.presenceService.broadcastPresence();
          } else {
            this.broadcast({ type: "presence_leave", userId: client.userId });
          }
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
    const event = this.parseWebSocketMessage(message, "sandbox", sandboxEventSchema);
    if (!event) return;

    try {
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
      const data = this.parseWebSocketMessage(message, "client", clientMessageSchema);
      if (!data) {
        this.safeSend(ws, {
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Failed to process message",
        });
        return;
      }

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

  private parseWebSocketMessage<T>(
    message: string,
    boundary: "client" | "sandbox",
    schema: BoundarySchema<T>
  ): T | null {
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch (e) {
      this.log.error("Invalid WebSocket JSON", {
        boundary,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      this.log.warn("Invalid WebSocket message", {
        boundary,
        issues: result.error.issues,
      });
      return null;
    }

    return result.data;
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
      name: resolveParticipantName(participant),
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
    const artifacts = this.messageService.listArtifacts();
    const replay = this.eventStream.getReplay();

    this.safeSend(ws, {
      type: "subscribed",
      sessionId: state.id,
      state,
      artifacts: artifacts.artifacts,
      participantId: participant.id,
      participant: {
        participantId: participant.id,
        name: resolveParticipantName(participant),
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

    // Read-through backstop (design §5.3): opening the session refreshes its
    // PR state from the provider; changes arrive as artifact_updated.
    this.schedulePullRequestRefresh("open");
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
    data: {
      content: string;
      model?: string;
      reasoningEffort?: string;
      attachments?: SessionAttachmentReference[];
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

    const page = this.eventStream.getHistoryPage({
      cursor: data.cursor,
      limit: data.limit,
    });

    this.safeSend(ws, {
      type: "history_page",
      items: page.items,
      hasMore: page.hasMore,
      cursor: page.cursor,
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

  private async syncSessionIndexStatus(
    sessionId: string,
    status: SessionStatus,
    updatedAt: number
  ): Promise<void> {
    if (!this.env.DB) return;
    const sessionStore = new SessionIndexStore(this.env.DB);
    await sessionStore.updateStatus(sessionId, status, updatedAt);
  }

  private logSessionIndexStatusSyncError(
    sessionId: string,
    status: SessionStatus,
    updatedAt: number,
    error: unknown
  ): void {
    this.log.error("session_index.update_status.background_error", {
      session_id: sessionId,
      status,
      updated_at: updatedAt,
      error,
    });
  }

  private syncSessionMetrics(sessionId: string): void {
    if (!this.env.DB) return;

    const session = this.repository.getSession();
    if (!session) return;

    const messageCount = this.repository.getMessageCount();
    const activeDurationMs = this.repository.getActiveDurationMs();
    const artifacts = this.repository.listArtifacts();
    const prCount = artifacts.filter((a) => a.type === "pr").length;

    const sessionStore = new SessionIndexStore(this.env.DB);
    this.ctx.waitUntil(
      sessionStore
        .updateMetrics(sessionId, {
          totalCost: session.total_cost ?? 0,
          activeDurationMs,
          messageCount,
          prCount,
        })
        .catch((error) => {
          this.log.error("session_index.update_metrics.background_error", {
            session_id: sessionId,
            error,
          });
        })
    );
  }

  private syncSessionIndexTitle(sessionId: string, title: string, updatedAt: number): void {
    if (!this.env.DB) return;
    const sessionStore = new SessionIndexStore(this.env.DB);
    this.ctx.waitUntil(
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

  private async transitionSessionStatus(status: SessionStatus): Promise<boolean> {
    const session = this.getSession();
    if (!session) return false;

    const publicSessionId = this.getPublicSessionId(session);
    if (session.status === status) {
      await this.syncSessionIndexStatus(publicSessionId, status, session.updated_at).catch(
        (error) =>
          this.logSessionIndexStatusSyncError(publicSessionId, status, session.updated_at, error)
      );
      if (TERMINAL_STATUSES.includes(status)) {
        this.syncSessionMetrics(publicSessionId);
      }
      return false;
    }

    const updatedAt = Math.max(Date.now(), session.updated_at + 1);
    this.repository.updateSessionStatus(session.id, status, updatedAt);
    await this.syncSessionIndexStatus(publicSessionId, status, updatedAt).catch((error) =>
      this.logSessionIndexStatusSyncError(publicSessionId, status, updatedAt, error)
    );

    this.broadcast({ type: "session_status", status });

    if (TERMINAL_STATUSES.includes(status)) {
      this.syncSessionMetrics(publicSessionId);
    }

    // Notify parent session (if this is a child) so its UI can refresh
    this.notifyParentOfStatusChange(session, publicSessionId, status);

    return true;
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
      const didUpdate = this.repository.updateSessionTitleIfUnset(session.id, titleText, updatedAt);
      if (!didUpdate) {
        return { ok: false, reason: "already_set", error: "Session title is already set" };
      }
    } else {
      this.repository.updateSessionTitle(session.id, titleText, updatedAt);
    }

    const publicSessionId = this.getPublicSessionId(session);
    this.syncSessionIndexTitle(publicSessionId, titleText, updatedAt);
    this.broadcast({ type: "session_title", title: titleText });

    if (session.parent_session_id) {
      this.notifyParentOfChildUpdate({ ...session, title: titleText }, publicSessionId, {
        status: session.status,
        title: titleText,
      });
    }

    return { ok: true, title: titleText };
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
    this.notifyParentOfChildUpdate(session, childSessionId, {
      status,
      title: session.title,
    });
  }

  private notifyParentOfChildUpdate(
    session: Pick<SessionRow, "parent_session_id" | "title">,
    childSessionId: string,
    update: { status: SessionStatus; title: string | null }
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
              status: update.status,
              title: update.title,
            }),
          })
        )
        .catch((error) => {
          this.log.error("notify_parent.failed", {
            parent_id: parentId,
            child_id: childSessionId,
            status: update.status,
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

    // Decrypt ttyd token if stored encrypted
    let ttydToken: string | null = sandbox?.ttyd_token ?? null;
    if (ttydToken && this.env.REPO_SECRETS_ENCRYPTION_KEY) {
      try {
        ttydToken = await decryptToken(ttydToken, this.env.REPO_SECRETS_ENCRYPTION_KEY);
      } catch {
        ttydToken = null;
      }
    }

    // Environment provenance: the id is stored on the session; the name is
    // resolved live (resolveEnvironmentName) so a deleted environment surfaces
    // as null — the UI renders "environment deleted" (§7.6).
    const environmentId = session?.environment_id ?? null;
    const environmentName = await this.resolveEnvironmentName(environmentId);

    return {
      id: this.getPublicSessionId(session),
      title: session?.title ?? null,
      repoOwner: session?.repo_owner ?? null,
      repoName: session?.repo_name ?? null,
      baseBranch: session?.base_branch ?? null,
      branchName: session?.branch_name ?? null,
      status: session?.status ?? "created",
      sandboxStatus: sandbox?.status ?? "pending",
      messageCount,
      createdAt: session?.created_at ?? Date.now(),
      model: session?.model ?? DEFAULT_MODEL,
      reasoningEffort: session?.reasoning_effort ?? undefined,
      isProcessing,
      parentSessionId: session?.parent_session_id ?? null,
      totalCost: session?.total_cost ?? 0,
      codeServerUrl: sandbox?.code_server_url ?? null,
      codeServerPassword,
      tunnelUrls: sandbox?.tunnel_urls ? this.safeParseTunnelUrls(sandbox.tunnel_urls) : null,
      ttydUrl: sandbox?.ttyd_url ?? null,
      ttydToken,
      sandboxDashboardUrl: this.getSandboxDashboardUrl(sandbox?.modal_object_id),
      repositories: this.getSessionRepositoryStates(session),
      environmentId,
      environmentName,
    };
  }

  /**
   * The launch environment's current display name, or null when the session has
   * no environment or the environment was deleted after launch (§7.6). Resolved
   * live rather than snapshotted so deletion is reflected; best-effort, so a
   * lookup failure resolves null rather than failing the whole state read.
   */
  private async resolveEnvironmentName(environmentId: string | null): Promise<string | null> {
    if (!environmentId || !this.env.DB) {
      return null;
    }
    try {
      const environment = await new EnvironmentStore(this.env.DB).getById(environmentId);
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
    return this.repository.getSessionRepositories().map((member) => ({
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
    const artifacts = this.repository.listArtifacts().filter((artifact) => artifact.url !== null);
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
    return this.repository.getProcessingMessage() !== null;
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
    return this.repository.getSession();
  }

  private getSandbox(): SandboxRow | null {
    return this.repository.getSandbox();
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

    // Fail hard on secret loading — sandboxes must not silently lose secrets
    const encryptionKey = this.env.REPO_SECRETS_ENCRYPTION_KEY;
    const globalStore = new GlobalSecretsStore(this.env.DB, encryptionKey);
    const globalSecrets = await globalStore.getDecryptedSecrets();

    const repoStore = new RepoSecretsStore(this.env.DB, encryptionKey);
    const environmentSecretsStore = new EnvironmentSecretsStore(this.env.DB, encryptionKey);
    const sources = await buildSessionTargetSecretSources({
      environmentId: session.environment_id,
      globalSecrets,
      members: this.repository.getSessionRepositories(),
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

    return mergedCount === 0 ? undefined : merge.merged;
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
