/**
 * Composition root for one session runtime.
 *
 * `createSessionRuntime` builds the entire collaborator graph eagerly, in
 * topological order, with exactly one session-scoped logger created before
 * anything can capture it — and returns only the narrow surface the platform
 * adapter needs: the server entry points, the log, and alarm rehydration.
 * Repositories, services, and handlers stay local to this factory;
 * `SessionRuntime.internals` exposes them for integration-test introspection
 * only. `SessionDO.ensureInitialized()` is the single call site; the schema
 * must already be applied when this runs, because the factory reads the
 * session row to derive the logger's `session_id`.
 *
 * Everything is constructed eagerly, including the two provider factories.
 * Both throw on misconfigured deployments (`createSandboxProviderFromEnv` on
 * missing provider credentials, `createSourceControlProviderFromEnv` on an
 * invalid `SCM_PROVIDER`, GitLab without a token, or Bitbucket) — and that
 * throw is deliberate: a misconfigured deployment fails every session request
 * at initialization, before any session state is written, instead of running
 * degraded and surfacing the error at the first spawn or PR operation.
 * Deployment-time validation is the gate for configuration, not the runtime.
 */

import { resolveAppName } from "@open-inspect/shared/app-name";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import { generateId, hashToken, encryptToken } from "../auth/crypto";
import { resolveSandboxBackendName } from "../sandbox/provider-name";
import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import { DEFAULT_SANDBOX_TIMEOUT_SECONDS } from "../sandbox/provider";
import { createImageBuildLookup } from "../image-builds/lookup";
import { resolveImageBuildProvider } from "../image-builds/provider-policy";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxStorage,
  type SessionContextReader,
  type IdGenerator,
  type ImageBuildLookup,
  type McpServerLookup,
  type SlackAgentNotifyLookup,
} from "../sandbox/lifecycle/manager";
import { McpServerStore } from "../db/mcp-servers";
import { IntegrationSettingsStore, resolveSlackSettings } from "../db/integration-settings";
import { SessionIndexStore } from "../db/session-index";
import { parsePersistedSandboxSettings } from "../sandbox/settings";
import { createSourceControlProviderFromEnv, type SourceControlProvider } from "../source-control";
import { requireRepoSecretsEncryptionKey, requireTokenEncryptionKey } from "../env-validation";
import type { Env, ClientInfo } from "../types";
import type { SessionRow } from "./types";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionPlatform } from "./platform";
import { SessionCoreRepository } from "./session-core-repository";
import { SandboxRepository } from "./sandbox-repository";
import { SessionAttachmentRepository } from "./session-attachment-repository";
import { ArtifactRepository } from "./artifact-repository";
import { EventRepository } from "./event-repository";
import { MessageRepository } from "./message-repository";
import { ParticipantRepository } from "./participant-repository";
import { WsClientMappingRepository } from "./ws-client-mapping-repository";
import { createLatchedPublicSessionIdResolver, resolvePublicSessionId } from "./public-session-id";
import { resolveScmSettings } from "./scm-settings-resolution";
import {
  isValidSandboxToken,
  resolveSandboxDashboardUrl,
  type SandboxDashboardSettings,
} from "./sandbox-access";
import { SessionWebSocketManagerImpl, type SessionWebSocketManager } from "./websocket-manager";
import { LifecycleSessionContext, LifecycleSocketAdapter } from "./sandbox-lifecycle-adapters";
import { SessionClientCommandFacade } from "./client-command-facade";
import { SessionPullRequestStore } from "../db/session-pull-request-store";
import { PullRequestCreationClaims, SessionPullRequestService } from "./pull-request-service";
import { refreshSessionPullRequests } from "./pull-request-refresh";
import { OpenAITokenRefreshService } from "./openai-token-refresh-service";
import { XaiTokenRefreshService } from "./xai-token-refresh-service";
import { ScmCredentialsService } from "./scm-credentials-service";
import { ParticipantService } from "./participant-service";
import { UserScmTokenStore } from "../db/user-scm-tokens";
import { CallbackNotificationService } from "./callback-notification-service";
import { UserEnvResolver } from "./user-env-resolver";
import { resolveSessionRepoId } from "./repo-id-resolution";
import { Scheduler } from "../scheduler/scheduler";
import { PresenceService } from "./presence-service";
import { SessionMessageQueue } from "./message-queue";
import { SandboxArtifactEventHandler } from "./sandbox-events/artifact.handler";
import { SandboxExecutionEventHandler } from "./sandbox-events/execution.handler";
import { SessionSandboxEventProcessor } from "./sandbox-events/processor";
import { SandboxRuntimeEventHandler } from "./sandbox-events/runtime.handler";
import { SandboxStreamingEventHandler } from "./sandbox-events/streaming.handler";
import { SandboxPushService } from "./sandbox-push-service";
import { SessionTerminalMessageProjection } from "./terminal-message-projection";
import { PersistedTerminalMessageProjectionStore } from "./terminal-message-projection-store";
import { SessionEventStream } from "./event-stream";
import { AutofixHandler } from "./http/handlers/autofix.handler";
import { MessagesHandler } from "./http/handlers/messages.handler";
import { ChildSessionsHandler } from "./http/handlers/child-sessions.handler";
import { ChildSummaryHandler } from "./http/handlers/child-summary.handler";
import { SessionInitHandler } from "./http/handlers/session-init.handler";
import { SandboxHandler } from "./http/handlers/sandbox.handler";
import { AttachmentsHandler } from "./http/handlers/attachments.handler";
import { WsTokenHandler } from "./http/handlers/ws-token.handler";
import { SessionLifecycleHandler } from "./http/handlers/session-lifecycle.handler";
import { PullRequestHandler } from "./http/handlers/pull-request.handler";
import { ParticipantsHandler } from "./http/handlers/participants.handler";
import { MessageService } from "./services/message.service";
import { createAlarmHandler } from "./alarm/handler";
import {
  createEarliestAlarmScheduler,
  handleAlarmDelivery,
  PersistedAlarmDeadlineStore,
  type RehydratableAlarmScheduler,
} from "./alarm/scheduler";
import { createSessionInternalRoutes } from "./http/routes";
import { SessionServer } from "./server";
import { SessionHttpDispatcher } from "./http/dispatcher";
import { SessionMessageRouter } from "./message-router";
import { SessionDisconnectHandler } from "./disconnect-handler";
import type { Clock, SandboxDisconnectMonitor, SessionBroadcaster, SocketRegistry } from "./ports";
import {
  SessionConnectionAuthenticator,
  type SessionUpgradeAdmission,
} from "./connection-authenticator";
import { SessionSnapshotReader } from "./snapshot-reader";
import { SessionAccessReader } from "./sandbox-access-reader";
import { createSessionScopedLogger } from "./session-logger";
import { SessionDiffStore } from "./diffs/store";
import { SessionDiffService } from "./diffs/service";
import { SessionDiffsHandler } from "./http/handlers/session-diffs.handler";
import { SessionMessengerImpl, type SessionMessenger } from "./messenger";
import { SessionStatusService } from "./session-status-service";
import { SessionTitleService } from "./title-service";
import { parseArtifactMetadata } from "./artifact-metadata";
import { AuthorizationError, AuthorizationService } from "../authorization/service";

/**
 * Timeout for WebSocket authentication (in milliseconds).
 * Client WebSockets must send a valid 'subscribe' message within this time
 * or the connection will be closed. This prevents resource abuse from
 * unauthenticated connections that never complete the handshake.
 */
const WS_AUTH_TIMEOUT_MS = 30000; // 30 seconds

/**
 * What the platform adapter (SessionDO) is allowed to touch. Everything else
 * stays inside the factory; `internals` exists for integration tests that
 * spy on or substitute live collaborators, and production code must not
 * reach through it.
 */
export interface SessionRuntime {
  readonly log: Logger;
  readonly server: SessionServer<WebSocket, ClientInfo>;
  /** Admission of WebSocket upgrades; the host completes the handshake and attaches its socket. */
  readonly upgrades: SessionUpgradeAdmission;
  readonly alarms: {
    /** Expire stale authorization leases and re-arm persisted deadlines after a cold start. */
    rehydrate(): void;
  };
  readonly internals: SessionComponents;
}

/**
 * The live-DO integration seams. Every field here is reached by an
 * integration test through `SessionRuntime.internals` (spying on a live
 * collaborator or, for `sourceControlProvider`, substituting one); nothing in
 * production reads this record. Add a field only together with the test that
 * consumes it — everything else stays local to the factory.
 */
export interface SessionComponents {
  sandboxRepository: SandboxRepository;
  /**
   * Assignable — the setter swaps the underlying cell for tests. Substitution
   * swaps operations only: the provider NAME was captured at construction and
   * passed by value to its consumers, so stubs must model the configured
   * provider family (every current stub is github-shaped, matching the env).
   */
  sourceControlProvider: SourceControlProvider;
  userEnvResolver: UserEnvResolver;
  lifecycleManager: SandboxLifecycleManager;
  messageQueue: SessionMessageQueue;
  presenceService: PresenceService;
  sandboxEventProcessor: SessionSandboxEventProcessor;
  pushService: SandboxPushService;
  sessionLifecycleHandler: SessionLifecycleHandler;
}

/**
 * The execution watchdog deadline for the current session settings. Resolved
 * per use (not at construction) so a deadline armed after `init` persists the
 * session row honors that row's `sandbox_settings` override.
 */
function resolveExecutionTimeoutMs(
  sessionCoreRepository: SessionCoreRepository,
  env: Env,
  log: Logger
): number {
  try {
    const sandboxTimeoutMs = parsePersistedSandboxSettings(
      sessionCoreRepository.getSession()?.sandbox_settings ?? null
    ).sandboxTimeoutMs;
    // This watchdog starts before bridge setup, so it must not race the
    // bridge's earlier snapshot-reserved prompt deadline.
    if (sandboxTimeoutMs !== undefined) return sandboxTimeoutMs;
  } catch {
    log.warn("Failed to parse sandbox_settings for execution timeout, using fallback");
  }
  return parseInt(env.EXECUTION_TIMEOUT_MS || String(DEFAULT_SANDBOX_TIMEOUT_SECONDS * 1000), 10);
}

/** Build the session runtime, including authorization verification and lease expiry handling. */
export function createSessionRuntime(platform: SessionPlatform, env: Env): SessionRuntime {
  const {
    id: durableObjectId,
    storage,
    db,
    alarmStore,
    sockets: socketHost,
    createBackgroundTasks,
  } = platform;
  const { sql } = storage;
  const transaction = <T>(closure: () => T): T => storage.transactionSync(closure);

  // Tier 1 — repositories and alarm persistence (leaves over SqlStorage).
  const attachmentRepository = new SessionAttachmentRepository(sql);
  const artifactRepository = new ArtifactRepository(sql);
  const eventRepository = new EventRepository(sql, transaction);
  const messageRepository = new MessageRepository(
    sql,
    transaction,
    attachmentRepository,
    eventRepository
  );
  const participantRepository = new ParticipantRepository(sql);
  const wsClientMappingRepository = new WsClientMappingRepository(sql);
  const sessionCoreRepository = new SessionCoreRepository(sql, transaction);
  const alarmDeadlines = new PersistedAlarmDeadlineStore(sql);
  const terminalMessageProjectionStore = new PersistedTerminalMessageProjectionStore(sql);

  // Secrets-at-rest encryption is not optional. Every consumer below takes
  // the validated key, so no fallback path can persist a secret in plaintext.
  const repoSecretsEncryptionKey = requireRepoSecretsEncryptionKey(env);
  const tokenEncryptionKey = requireTokenEncryptionKey(env);

  // The session-scoped logger, created before anything can capture a logger
  // at all. Its `session_id` is injected per emit through the latched
  // resolver: before `init` writes the session row it is the Durable Object
  // id, and it upgrades to the public id the moment the row exists — for
  // every component in the graph, however early it captured the logger.
  const getPublicSessionId = createLatchedPublicSessionIdResolver(
    () => sessionCoreRepository.getSession(),
    durableObjectId
  );
  const log = createSessionScopedLogger(
    createLogger("session-do", {}, parseLogLevel(env.LOG_LEVEL)),
    getPublicSessionId
  );
  const backgroundTasks = createBackgroundTasks(log);
  // The sandbox repository validates the status it reads and warns on anything
  // unmodelled, so it needs the session logger — and it owns encrypt-at-rest
  // for access secrets, so it takes the key.
  const sandboxRepository = new SandboxRepository(sql, log, repoSecretsEncryptionKey);

  // Tier 2 — sockets and alarm scheduling.
  const alarmScheduler = createEarliestAlarmScheduler(alarmStore, alarmDeadlines);
  const wsManager: SessionWebSocketManager = new SessionWebSocketManagerImpl(
    socketHost,
    sandboxRepository,
    wsClientMappingRepository,
    alarmScheduler,
    log,
    { authTimeoutMs: WS_AUTH_TIMEOUT_MS }
  );
  // Platform-level ping/pong: keepalives are answered without waking the
  // runtime. Session-wide wiring, so it lives here.
  socketHost.setAutoResponse(
    JSON.stringify({ type: "ping" }),
    JSON.stringify({ type: "pong", timestamp: Date.now() })
  );

  // Tier 3 — outbound delivery over the socket registry.
  const messenger: SessionMessenger = new SessionMessengerImpl(wsManager);

  // Constructed eagerly — an invalid SCM configuration fails right here. The
  // cell is a local `let` so live-DO integration tests can substitute a stub
  // after the init request has already built this graph; consumer closures
  // read the cell per call (never through the returned record), and
  // `internals.sourceControlProvider` exposes it as an accessor pair.
  let scmProvider: SourceControlProvider = createSourceControlProviderFromEnv(env);
  const sourceControlProvider = () => scmProvider;
  const scmProviderName = scmProvider.name;

  // Shared single instances/closures — every consumer below takes these
  // rather than re-deriving its own copy.
  const sessionIndexStore = new SessionIndexStore(db);
  const sessionPullRequestStore = new SessionPullRequestStore(db);
  const resolveRepoId = (sessionRow: SessionRow) =>
    resolveSessionRepoId(sessionRow, sessionCoreRepository, sourceControlProvider);

  const sandboxDashboardSettings: SandboxDashboardSettings = {
    sandboxProvider: env.SANDBOX_PROVIDER,
    modalWorkspace: env.MODAL_WORKSPACE,
    modalEnvironment: env.MODAL_ENVIRONMENT,
  };

  // Tier 4 — session-scoped domain services.
  const userEnvResolver = new UserEnvResolver({
    db,
    sessionCoreRepository,
    resolveRepoId,
    durableObjectId,
    repoSecretsEncryptionKey,
    secretsCapEnforcement: env.SECRETS_CAP_ENFORCEMENT,
    log,
  });

  const terminalMessageProjection = new SessionTerminalMessageProjection({
    sessionIndex: sessionIndexStore,
    getSessionId: () => {
      const current = sessionCoreRepository.getSession();
      return current ? resolvePublicSessionId(current, durableObjectId) : null;
    },
    store: terminalMessageProjectionStore,
    alarmScheduler,
    now: () => Date.now(),
    log,
  });
  const recordTerminalMessage = (
    messageId: string,
    messageCreatedAt: number,
    completedAt: number
  ): Promise<void> =>
    terminalMessageProjection.recordTerminalMessage({
      messageId,
      messageCreatedAt,
      terminalMessageCompletedAt: completedAt,
    });

  const userScmTokenStore = new UserScmTokenStore(db, tokenEncryptionKey);
  const participantService = new ParticipantService({
    repository: participantRepository,
    getProcessingMessageAuthor: () => messageRepository.getProcessingMessageAuthor(),
    env,
    log,
    generateId: () => generateId(),
    userScmTokenStore,
  });

  const scheduler = new Scheduler(db, env, backgroundTasks);
  const callbackService = new CallbackNotificationService({
    repository: sessionCoreRepository,
    messageRepository,
    env,
    completeAutomationRun: (completion) => scheduler.runComplete(completion),
    log,
    getSessionId: () => resolvePublicSessionId(sessionCoreRepository.getSession(), durableObjectId),
  });

  const statusService = new SessionStatusService(
    backgroundTasks,
    log,
    sessionCoreRepository,
    messageRepository,
    artifactRepository,
    messenger,
    sessionIndexStore,
    env.SESSION ?? null
  );

  const titleService = new SessionTitleService({
    sessionCoreRepository,
    messenger,
    statusService,
    backgroundTasks,
    sessionIndexStore,
    durableObjectId,
    now: () => Date.now(),
  });

  const diffService = new SessionDiffService(
    new SessionDiffStore(sql),
    sessionCoreRepository,
    messenger,
    log
  );
  const diffsHandler = new SessionDiffsHandler(diffService);
  const eventStream = new SessionEventStream(eventRepository);

  // Tier 5 — the lifecycle manager.
  const lifecycleManager = createLifecycleManager({
    env,
    db,
    getSessionId: getPublicSessionId,
    storage: sandboxRepository,
    sessionContext: new LifecycleSessionContext(sessionCoreRepository, userEnvResolver),
    repoSecretsEncryptionKey,
    messenger,
    wsManager,
    alarmScheduler,
    sandboxDashboardSettings,
  });

  // Tier 6 — the message queue.
  const getExecutionTimeoutMs = () => resolveExecutionTimeoutMs(sessionCoreRepository, env, log);
  const messageQueue = new SessionMessageQueue(
    backgroundTasks,
    log,
    sessionCoreRepository,
    messageRepository,
    participantRepository,
    attachmentRepository,
    wsManager,
    messenger,
    participantService,
    callbackService,
    statusService,
    (model) => userEnvResolver.getProviderAuthenticationError(model),
    recordTerminalMessage,
    lifecycleManager,
    sessionIndexStore,
    scmProviderName,
    alarmScheduler,
    getExecutionTimeoutMs
  );

  // Tier 7 — services over the queue and lifecycle.
  const presenceService = new PresenceService({
    getAuthenticatedClients: () => wsManager.getAuthenticatedClients(),
    messenger,
    send: (ws, msg) => wsManager.send(ws, msg),
    getSandboxSocket: () => wsManager.getSandboxSocket(),
    isSpawning: () => lifecycleManager.isSpawning(),
    spawnSandbox: () => lifecycleManager.spawnSandbox(),
    log,
  });

  const messageService = new MessageService({
    repository: messageRepository,
    eventRepository,
    artifactRepository,
    messageQueue,
    stopExecution: () => messageQueue.stopExecution(),
    parseArtifactMetadata: (artifact) => parseArtifactMetadata(artifact, log),
  });
  const autofixHandler = new AutofixHandler(messageQueue);

  const updateLastActivity = (timestamp: number) => lifecycleManager.updateLastActivity(timestamp);
  const streamingEventHandler = new SandboxStreamingEventHandler(
    backgroundTasks,
    sessionCoreRepository,
    eventRepository,
    callbackService,
    messenger,
    updateLastActivity
  );
  const artifactEventHandler = new SandboxArtifactEventHandler(
    artifactRepository,
    eventRepository,
    messenger,
    updateLastActivity
  );
  const executionEventHandler = new SandboxExecutionEventHandler(
    backgroundTasks,
    log,
    messageRepository,
    callbackService,
    messenger,
    recordTerminalMessage,
    statusService,
    (reason) => lifecycleManager.triggerSnapshot(reason),
    updateLastActivity,
    () => lifecycleManager.scheduleInactivityCheck(),
    () => messageQueue.processMessageQueue(),
    () => messageQueue.broadcastPromptQueue()
  );
  const runtimeEventHandler = new SandboxRuntimeEventHandler(
    sessionCoreRepository,
    sandboxRepository,
    eventRepository,
    messenger,
    diffService,
    (title, options) => titleService.applySessionTitleUpdate(title, options),
    updateLastActivity
  );
  const pushService = new SandboxPushService(log, wsManager);
  const sandboxEventProcessor = new SessionSandboxEventProcessor(
    log,
    messageRepository,
    wsManager,
    streamingEventHandler,
    artifactEventHandler,
    executionEventHandler,
    runtimeEventHandler,
    pushService
  );

  const alarmHandler = createAlarmHandler({
    repository: messageRepository,
    messageQueue,
    lifecycleManager,
    terminalMessageProjection,
    alarmScheduler,
    getExecutionTimeoutMs,
    now: () => Date.now(),
    log,
  });

  const schedulePullRequestRefresh = (trigger: "open" | "manual"): void => {
    backgroundTasks.submit(
      () =>
        refreshSessionPullRequests(
          sessionCoreRepository,
          artifactRepository,
          sourceControlProvider(),
          sessionPullRequestStore
        ).then(({ updated, failures }) => {
          for (const artifact of updated) {
            messenger.broadcast({ type: "artifact_updated", artifact });
          }
          for (const failure of failures) {
            log.error("Pull request refresh failed for artifact", {
              trigger,
              reason: failure.reason,
              artifact_id: failure.artifactId,
              pr_number: failure.prNumber,
              repo_owner: failure.repoOwner,
              repo_name: failure.repoName,
              error: failure.error instanceof Error ? failure.error : String(failure.error),
            });
          }
        }),
      {
        name: "pull_request.refresh",
        context: { trigger },
      }
    );
  };

  // Tier 8 — internal HTTP handlers.
  const messagesHandler = new MessagesHandler(messageService);

  const childSessionsHandler = new ChildSessionsHandler(
    messageRepository,
    participantRepository,
    sessionCoreRepository,
    messenger,
    messageService
  );
  const childSummaryHandler = new ChildSummaryHandler(
    sessionCoreRepository,
    sandboxRepository,
    messageRepository,
    eventRepository,
    artifactRepository,
    durableObjectId,
    log
  );

  // Per-request adapters: each token/credential refresh constructs its
  // service around the request-scoped log, so these stay functions.
  const refreshOpenAIToken = async (sessionRow: SessionRow, requestLog: Logger) => {
    const service = new OpenAITokenRefreshService(
      db,
      repoSecretsEncryptionKey,
      resolveRepoId,
      requestLog
    );
    return service.refresh(sessionRow);
  };
  const refreshXaiToken = async (sessionRow: SessionRow, requestLog: Logger) => {
    const service = new XaiTokenRefreshService(
      db,
      repoSecretsEncryptionKey,
      resolveRepoId,
      requestLog
    );
    return service.refresh(sessionRow);
  };
  const getScmCredentials = (requestLog: Logger) =>
    new ScmCredentialsService(sourceControlProvider(), requestLog).getCredentials();

  const sandboxHandler = new SandboxHandler(
    messageRepository,
    eventRepository,
    artifactRepository,
    sessionCoreRepository,
    sandboxRepository,
    sandboxEventProcessor,
    messenger,
    refreshOpenAIToken,
    refreshXaiToken,
    getScmCredentials,
    isValidSandboxToken,
    (reason) => messageQueue.handleFatalSandboxFailure(reason),
    generateId
  );

  const attachmentsHandler = new AttachmentsHandler(attachmentRepository, log);

  const wsTokenHandler = new WsTokenHandler(participantRepository, generateId, hashToken);

  const lifecycleWsManager = new LifecycleSocketAdapter(wsManager);
  const sessionInitHandler = new SessionInitHandler(
    sessionCoreRepository,
    sandboxRepository,
    participantRepository,
    durableObjectId,
    () =>
      backgroundTasks.submit(() => lifecycleManager.warmSandbox(), {
        name: "sandbox.warm",
      }),
    (token) => encryptToken(token, tokenEncryptionKey),
    generateId
  );
  const sessionLifecycleHandler = new SessionLifecycleHandler(
    sessionCoreRepository,
    sandboxRepository,
    messageRepository,
    statusService,
    titleService,
    lifecycleWsManager,
    durableObjectId,
    async () => {
      await statusService.cancel(() => messageQueue.cancelExecution());
    }
  );

  const prCreationClaims = new PullRequestCreationClaims();
  const pullRequestHandler = new PullRequestHandler(
    sessionCoreRepository,
    participantService,
    artifactRepository,
    messenger,
    (sessionRow) => {
      const sessionId = sessionRow.session_name || sessionRow.id;
      const webAppUrl = env.WEB_APP_URL || env.WORKER_URL || "";
      return webAppUrl + "/session/" + sessionId;
    },
    async (input, requestLog) => {
      const pullRequestService = new SessionPullRequestService({
        repository: sessionCoreRepository,
        artifactRepository,
        claims: prCreationClaims,
        sourceControlProvider: sourceControlProvider(),
        log: requestLog,
        generateId: () => generateId(),
        pushBranchToRemote: (pushSpec) => pushService.pushBranchToRemote(pushSpec),
        messenger,
        appName: resolveAppName(env),
        sessionPullRequests: sessionPullRequestStore,
        resolveScmSettings: (repo) => resolveScmSettings(db, repo),
      });

      return pullRequestService.createPullRequest(input);
    },
    () => schedulePullRequestRefresh("manual")
  );

  const participantsHandler = new ParticipantsHandler(participantRepository);

  // Tier 9 — the read models, connection admission, and the server stack.
  const snapshotReader = new SessionSnapshotReader({
    sessionCoreRepository,
    sandboxRepository,
    messageRepository,
    artifactRepository,
    messageService,
    eventStream,
    sandboxDashboardSettings,
    db,
    durableObjectId,
    transaction,
    log,
  });

  const accessReader = new SessionAccessReader({
    sessionCoreRepository,
    sandboxRepository,
    repoSecretsEncryptionKey,
    sandboxDashboardSettings,
    log,
  });

  const connectionAuthenticator = new SessionConnectionAuthenticator({
    wsManager,
    sessionCoreRepository,
    sandboxRepository,
    lifecycleManager,
    messenger,
    backgroundTasks,
    messageQueue,
    participantService,
    presenceService,
    snapshotReader,
    schedulePullRequestRefresh,
    scmProviderName,
    resolveAuthorization: async (userId) => {
      try {
        const authorization = await new AuthorizationService(db).getEffectiveAuthorization(userId);
        return authorization.suspendedAt === null
          ? { kind: "valid", authorization }
          : { kind: "rejected" };
      } catch (error) {
        if (error instanceof AuthorizationError) return { kind: "rejected" };
        log.error("WebSocket authorization verification failed", {
          user_id: userId,
          error: error instanceof Error ? error : String(error),
        });
        return { kind: "unavailable" };
      }
    },
    log,
  });

  // Internal HTTP route table (transport wiring only).
  const routes = createSessionInternalRoutes({
    init: (request, _url, requestLog) => sessionInitHandler.init(request, requestLog),
    state: () => sessionLifecycleHandler.getState(),
    snapshot: () => snapshotReader.handleSnapshot(),
    sandboxAccess: () => accessReader.handleSandboxAccess(),
    prompt: (request, _url, requestLog) => messagesHandler.enqueuePrompt(request, requestLog),
    autofix: (request, _url, requestLog) => autofixHandler.handle(request, requestLog),
    stop: () => messagesHandler.stop(),
    sandboxEvent: (request) => sandboxHandler.sandboxEvent(request),
    sandboxError: (request) => sandboxHandler.sandboxError(request),
    createMediaArtifact: (request) => sandboxHandler.createMediaArtifact(request),
    recordAttachment: (request) => {
      const session = sessionCoreRepository.getSession();
      return attachmentsHandler.recordAttachment(
        request,
        session ? resolvePublicSessionId(session, durableObjectId) : null
      );
    },
    listParticipants: () => participantsHandler.listParticipants(),
    listEvents: (_request, url) => messagesHandler.listEvents(url),
    listArtifacts: (_request, url) => messagesHandler.listArtifacts(url),
    listMessages: (_request, url) => messagesHandler.listMessages(url),
    createPr: (request, _url, requestLog) => pullRequestHandler.createPr(request, requestLog),
    pullRequestArtifactSnapshot: (request, url) =>
      pullRequestHandler.pullRequestArtifactSnapshot(request, url),
    pullRequestsRefresh: () => pullRequestHandler.refreshPullRequests(),
    wsToken: (request, _url, requestLog) => wsTokenHandler.generateWsToken(request, requestLog),
    updateTitle: (request) => sessionLifecycleHandler.updateTitle(request),
    archive: () => sessionLifecycleHandler.archive(),
    unarchive: () => sessionLifecycleHandler.unarchive(),
    expireDraft: () => sessionLifecycleHandler.expireDraft(),
    verifySandboxToken: (request, _url, requestLog) =>
      sandboxHandler.verifySandboxToken(request, requestLog),
    openaiTokenRefresh: (_request, _url, requestLog) =>
      sandboxHandler.openaiTokenRefresh(requestLog),
    xaiTokenRefresh: (_request, _url, requestLog) => sandboxHandler.xaiTokenRefresh(requestLog),
    scmCredentials: (_request, _url, requestLog) => sandboxHandler.scmCredentials(requestLog),
    tunnelUrls: (_request, _url, requestLog) => sandboxHandler.tunnelUrls(requestLog),
    spawnContext: () => childSessionsHandler.getSpawnContext(),
    activePromptAuthor: () => childSessionsHandler.getActivePromptAuthor(),
    childSummary: (_request, url) => childSummaryHandler.getChildSummary(url),
    parentPrompt: (request) => childSessionsHandler.parentPrompt(request),
    cancel: () => sessionLifecycleHandler.cancel(),
    childSessionUpdate: (request) => childSessionsHandler.childSessionUpdate(request),
    diffState: () => diffsHandler.state(),
    diffStore: (request) => diffsHandler.storeBundle(request),
    diffFailure: (request) => diffsHandler.recordFailure(request),
    diffResolveFile: (_request, url) => diffsHandler.resolveFile(url),
    diffRetry: () => diffsHandler.retry(),
  });

  const clock: Clock = {
    nowMs: () => Date.now(),
    monotonicNowMs: () => performance.now(),
  };
  const sockets: SocketRegistry<WebSocket, ClientInfo> = {
    classify: (ws) => wsManager.classify(ws),
    send: (ws, message) => wsManager.send(ws, message),
    getClient: (ws) => connectionAuthenticator.getClientInfo(ws),
    close: (ws, code, reason) => wsManager.close(ws, code, reason),
    clearSandboxIfMatch: (ws) => wsManager.clearSandboxSocketIfMatch(ws),
    removeClient: (ws) => wsManager.removeClient(ws),
    hasParticipant: (participantId) =>
      Array.from(wsManager.getAuthenticatedClients()).some(
        (client) => client.participantId === participantId
      ),
  };
  const clientCommands = new SessionClientCommandFacade(
    connectionAuthenticator,
    messageQueue,
    presenceService,
    eventStream
  );
  const sandboxDisconnects: SandboxDisconnectMonitor = {
    getStatus: () => sandboxRepository.getSandbox()?.status,
    scheduleCheck: () => lifecycleManager.scheduleDisconnectCheck(),
  };
  const disconnectBroadcaster: SessionBroadcaster = {
    broadcastPresence: () => presenceService.broadcastPresence(),
    broadcast: (message) => messenger.broadcast(message),
  };

  const server = new SessionServer<WebSocket, ClientInfo>({
    http: new SessionHttpDispatcher({ log, routes, clock }),
    messages: new SessionMessageRouter({
      log,
      sockets,
      clientCommands,
      processSandboxEvent: (event) => sandboxEventProcessor.processSandboxEvent(event),
      clock,
    }),
    disconnects: new SessionDisconnectHandler({
      log,
      sockets,
      sandbox: sandboxDisconnects,
      broadcaster: disconnectBroadcaster,
    }),
    handleScheduledDeadline: () =>
      handleAlarmDelivery(
        alarmDeadlines,
        async () => {
          await wsManager.expireAuthorizationLeases(Date.now());
          await alarmHandler.handle();
        },
        () => alarmScheduler.rearmPending()
      ),
  });

  const components: SessionComponents = {
    sandboxRepository,
    // Accessor pair over the local cell: production reads never go through
    // this property; the setter is the live-DO integration seam.
    get sourceControlProvider() {
      return scmProvider;
    },
    set sourceControlProvider(next: SourceControlProvider) {
      scmProvider = next;
    },
    userEnvResolver,
    lifecycleManager,
    messageQueue,
    presenceService,
    sandboxEventProcessor,
    pushService,
    sessionLifecycleHandler,
  };

  return {
    log,
    server,
    upgrades: connectionAuthenticator,
    alarms: {
      rehydrate: () =>
        backgroundTasks.submit(
          async () => {
            await wsManager.expireAuthorizationLeases(Date.now());
            await alarmScheduler.rehydrate();
            await terminalMessageProjection.rearm();
          },
          {
            name: "alarm.rehydrate",
          }
        ),
    },
    internals: components,
  };
}

interface LifecycleManagerDeps {
  env: Env;
  db: SqlDatabase;
  /** The latched public-session-id resolver shared with the session logger. */
  getSessionId: () => string;
  /** The repository, satisfying the manager's storage port structurally. */
  storage: SandboxStorage;
  sessionContext: SessionContextReader;
  repoSecretsEncryptionKey: string;
  messenger: SessionMessenger;
  wsManager: SessionWebSocketManager;
  alarmScheduler: RehydratableAlarmScheduler;
  sandboxDashboardSettings: SandboxDashboardSettings;
}

/** Create the lifecycle manager with all required adapters. */
function createLifecycleManager(deps: LifecycleManagerDeps): SandboxLifecycleManager {
  const {
    env,
    db,
    getSessionId,
    storage,
    sessionContext,
    repoSecretsEncryptionKey,
    messenger,
    wsManager,
    alarmScheduler,
    sandboxDashboardSettings,
  } = deps;
  // Both throw on a misconfigured deployment — deliberately at graph
  // construction, so every session request fails at initialization instead of
  // the error surfacing later at the first spawn.
  const sandboxBackend = resolveSandboxBackendName(env.SANDBOX_PROVIDER);
  const provider = createSandboxProviderFromEnv(env, sandboxBackend);

  const lifecycleWsManager = new LifecycleSocketAdapter(wsManager);

  // ID generator adapter
  const idGenerator: IdGenerator = {
    generateId: () => generateId(),
  };

  // Build configuration
  const controlPlaneUrl =
    env.WORKER_URL ||
    `https://open-inspect-control-plane.${env.CF_ACCOUNT_ID || "workers"}.workers.dev`;

  const mcpStore = new McpServerStore(db, repoSecretsEncryptionKey);
  const mcpServerLookup: McpServerLookup = {
    getDecryptedForSession: (repositories) => mcpStore.getDecryptedForSession(repositories),
  };

  // Session-scoped gate: resolved from the primary member (the scalar mirror
  // this lookup is called with) — see resolveSessionScopedSettings for the
  // per-feature scope rules. Token absence short-circuits to false so a
  // misconfigured deployment never installs a tool that would 503 on every call.
  const tokenPresent = !!env.SLACK_BOT_TOKEN;
  const settingsStore = new IntegrationSettingsStore(db);
  const slackAgentNotifyLookup: SlackAgentNotifyLookup = {
    isEnabledForRepo: async (repoOwner, repoName) => {
      if (!tokenPresent) return false;
      const settings =
        repoOwner && repoName
          ? (await settingsStore.getResolvedConfig("slack", `${repoOwner}/${repoName}`)).settings
          : ((await settingsStore.getGlobal("slack"))?.defaults ?? {});
      return resolveSlackSettings(settings).agentNotificationsEnabled;
    },
  };

  const sandboxDashboardUrlBuilder =
    sandboxBackend === "modal"
      ? (providerObjectId: string) =>
          resolveSandboxDashboardUrl(sandboxDashboardSettings, providerObjectId)
      : undefined;

  const config = {
    ...DEFAULT_LIFECYCLE_CONFIG,
    controlPlaneUrl,
    model: DEFAULT_MODEL,
    // Re-derived per use until the session row exists: on the first-ever
    // activation the manager is built during the init request, before the row
    // is written. Latched afterwards — the manager derives log context from
    // this on every log line, and the id is immutable once row-backed.
    getSessionId,
    inactivity: {
      ...DEFAULT_LIFECYCLE_CONFIG.inactivity,
      timeoutMs: parseInt(env.SANDBOX_INACTIVITY_TIMEOUT_MS || "600000", 10),
    },
    mcpServerLookup,
    slackAgentNotifyLookup,
    sandboxDashboardUrlBuilder,
  };

  // The image lookup exists only for providers that support prebuilt images.
  const imageBuildProvider = resolveImageBuildProvider(sandboxBackend);
  const imageBuildLookup: ImageBuildLookup | undefined = imageBuildProvider
    ? createImageBuildLookup(db, imageBuildProvider)
    : undefined;

  return new SandboxLifecycleManager(
    provider,
    storage,
    sessionContext,
    messenger,
    lifecycleWsManager,
    alarmScheduler,
    idGenerator,
    config,
    imageBuildLookup
  );
}
