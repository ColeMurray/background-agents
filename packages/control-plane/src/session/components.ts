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
import type { Env, ClientInfo } from "../types";
import type { SessionRow } from "./types";
import type { SqlDatabase } from "../db/sql-database";
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
import { validateReasoningEffort } from "./reasoning-effort";
import {
  isValidSandboxToken,
  resolveSandboxDashboardUrl,
  type SandboxDashboardSettings,
} from "./sandbox-access";
import { SessionWebSocketManagerImpl, type SessionWebSocketManager } from "./websocket-manager";
import { DurableObjectSandboxStorage, LifecycleSocketAdapter } from "./sandbox-lifecycle-adapters";
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
import { createCloudflareBackgroundTasks } from "../cloudflare/background-tasks";
import { PresenceService } from "./presence-service";
import { SessionMessageQueue } from "./message-queue";
import { SessionSandboxEventProcessor } from "./sandbox-events";
import { SessionTerminalMessageProjection } from "./terminal-message-projection";
import { SessionEventStream } from "./event-stream";
import { createMessagesHandler } from "./http/handlers/messages.handler";
import { createChildSessionsHandler } from "./http/handlers/child-sessions.handler";
import { createSandboxHandler } from "./http/handlers/sandbox.handler";
import { AttachmentsHandler } from "./http/handlers/attachments.handler";
import { createWsTokenHandler } from "./http/handlers/ws-token.handler";
import {
  createSessionLifecycleHandler,
  type SessionLifecycleHandler,
} from "./http/handlers/session-lifecycle.handler";
import { createPullRequestHandler } from "./http/handlers/pull-request.handler";
import { createParticipantsHandler } from "./http/handlers/participants.handler";
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
import { SessionConnectionAuthenticator } from "./connection-authenticator";
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

/**
 * Timeout for WebSocket authentication (in milliseconds).
 * Client WebSockets must send a valid 'subscribe' message within this time
 * or the connection will be closed. This prevents resource abuse from
 * unauthenticated connections that never complete the handshake.
 */
const WS_AUTH_TIMEOUT_MS = 30000; // 30 seconds

/** The platform surface the session graph is built over. */
export interface SessionPlatform {
  ctx: DurableObjectState;
  sql: SqlStorage;
  db: SqlDatabase | null;
}

/**
 * What the platform adapter (SessionDO) is allowed to touch. Everything else
 * stays inside the factory; `internals` exists for integration tests that
 * spy on or substitute live collaborators, and production code must not
 * reach through it.
 */
export interface SessionRuntime {
  readonly log: Logger;
  readonly server: SessionServer<WebSocket, ClientInfo>;
  readonly alarms: {
    /** Re-arm any persisted alarm deadline after a cold start. */
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

export function createSessionRuntime(platform: SessionPlatform, env: Env): SessionRuntime {
  const { ctx, sql, db } = platform;
  const durableObjectId = ctx.id.toString();
  const transaction = <T>(closure: () => T): T => ctx.storage.transactionSync(closure);

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
  const backgroundTasks = createCloudflareBackgroundTasks(ctx, () => log);
  // The sandbox repository validates the status it reads and warns on anything
  // unmodelled, so it needs the session logger.
  const sandboxRepository = new SandboxRepository(sql, log);

  // Tier 2 — sockets and alarm scheduling.
  const wsManager: SessionWebSocketManager = new SessionWebSocketManagerImpl(
    ctx,
    sandboxRepository,
    wsClientMappingRepository,
    log,
    { authTimeoutMs: WS_AUTH_TIMEOUT_MS }
  );
  const alarmScheduler = createEarliestAlarmScheduler(ctx.storage, alarmDeadlines);
  // Hibernation-level ping/pong: the runtime answers keepalives without
  // waking the Durable Object. Platform-global wiring, so it lives here.
  ctx.setWebSocketAutoResponse(
    new WebSocketRequestResponsePair(
      JSON.stringify({ type: "ping" }),
      JSON.stringify({ type: "pong", timestamp: Date.now() })
    )
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
  const sessionIndexStore = db ? new SessionIndexStore(db) : null;
  const sessionPullRequestStore = db ? new SessionPullRequestStore(db) : null;
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
    repoSecretsEncryptionKey: env.REPO_SECRETS_ENCRYPTION_KEY,
    secretsCapEnforcement: env.SECRETS_CAP_ENFORCEMENT,
    log,
  });

  const terminalMessageProjection = new SessionTerminalMessageProjection(
    sessionIndexStore,
    () => {
      const current = sessionCoreRepository.getSession();
      return current ? resolvePublicSessionId(current, durableObjectId) : null;
    },
    log
  );
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

  const userScmTokenStore =
    db && env.TOKEN_ENCRYPTION_KEY ? new UserScmTokenStore(db, env.TOKEN_ENCRYPTION_KEY) : null;
  const participantService = new ParticipantService({
    repository: participantRepository,
    getProcessingMessageAuthor: () => messageRepository.getProcessingMessageAuthor(),
    env,
    log,
    generateId: () => generateId(),
    userScmTokenStore,
  });

  const scheduler = db ? new Scheduler(db, env, backgroundTasks) : undefined;
  const callbackService = new CallbackNotificationService({
    repository: sessionCoreRepository,
    messageRepository,
    env,
    completeAutomationRun: scheduler
      ? (completion) => scheduler.runComplete(completion)
      : undefined,
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
    sessionCoreRepository,
    sandboxRepository,
    userEnvResolver,
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

  const sandboxEventProcessor = new SessionSandboxEventProcessor(
    backgroundTasks,
    () => log,
    sessionCoreRepository,
    sandboxRepository,
    messageRepository,
    eventRepository,
    artifactRepository,
    callbackService,
    wsManager,
    messenger,
    diffService,
    (title, options) => titleService.applySessionTitleUpdate(title, options),
    (reason) => lifecycleManager.triggerSnapshot(reason),
    recordTerminalMessage,
    statusService,
    (timestamp) => lifecycleManager.updateLastActivity(timestamp),
    () => lifecycleManager.scheduleInactivityCheck(),
    () => messageQueue.processMessageQueue(),
    () => messageQueue.broadcastPromptQueue()
  );

  const alarmHandler = createAlarmHandler({
    repository: messageRepository,
    messageQueue,
    lifecycleManager,
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
  const messagesHandler = createMessagesHandler({
    messageService,
  });

  const childSessionsHandler = createChildSessionsHandler({
    messageRepository,
    eventRepository,
    participantRepository,
    artifactRepository,
    getSession: () => sessionCoreRepository.getSession(),
    getSandbox: () => sandboxRepository.getSandbox(),
    getPublicSessionId: (sessionRow) => resolvePublicSessionId(sessionRow, durableObjectId),
    parseArtifactMetadata: (artifact) => parseArtifactMetadata(artifact, log),
    messenger,
    messageService,
  });

  const sandboxHandler = createSandboxHandler({
    messageRepository,
    eventRepository,
    participantRepository,
    artifactRepository,
    processSandboxEvent: (event) => sandboxEventProcessor.processSandboxEvent(event),
    getSandbox: () => sandboxRepository.getSandbox(),
    isValidSandboxToken: (token, sandbox) => isValidSandboxToken(token, sandbox),
    getSession: () => sessionCoreRepository.getSession(),
    refreshOpenAIToken: async (sessionRow, requestLog) => {
      const service = new OpenAITokenRefreshService(
        db!,
        env.REPO_SECRETS_ENCRYPTION_KEY!,
        resolveRepoId,
        requestLog
      );
      return service.refresh(sessionRow);
    },
    refreshXaiToken: async (sessionRow, requestLog) => {
      const service = new XaiTokenRefreshService(
        db!,
        env.REPO_SECRETS_ENCRYPTION_KEY!,
        resolveRepoId,
        requestLog
      );
      return service.refresh(sessionRow);
    },
    isManagedSecretsConfigured: () => Boolean(db && env.REPO_SECRETS_ENCRYPTION_KEY),
    getScmCredentials: (requestLog) =>
      new ScmCredentialsService(sourceControlProvider(), requestLog).getCredentials(),
    messenger,
    generateId: () => generateId(),
    now: () => Date.now(),
  });

  const attachmentsHandler = new AttachmentsHandler(attachmentRepository, log);

  const wsTokenHandler = createWsTokenHandler({
    repository: participantRepository,
    getParticipantByUserId: (userId) => participantService.getByUserId(userId),
    generateId: (bytes) => generateId(bytes),
    hashToken: (token) => hashToken(token),
    now: () => Date.now(),
  });

  const sessionLifecycleHandler = createSessionLifecycleHandler({
    sessionCoreRepository,
    sandboxRepository,
    messageRepository,
    participantRepository,
    getDurableObjectId: () => durableObjectId,
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    encryptToken: (token, encryptionKey) => encryptToken(token, encryptionKey),
    validateReasoningEffort: (model, effort) => validateReasoningEffort(model, effort, log),
    generateId: (bytes) => generateId(bytes),
    now: () => Date.now(),
    scheduleWarmSandbox: () =>
      backgroundTasks.submit(() => lifecycleManager.warmSandbox(), {
        name: "sandbox.warm",
      }),
    getSession: () => sessionCoreRepository.getSession(),
    getSandbox: () => sandboxRepository.getSandbox(),
    getPublicSessionId: (sessionRow) => resolvePublicSessionId(sessionRow, durableObjectId),
    getParticipantByUserId: (userId) => participantService.getByUserId(userId),
    statusService,
    applySessionTitleUpdate: (title, options) =>
      titleService.applySessionTitleUpdate(title, options),
    cancelSession: async () => {
      await statusService.cancel(() => messageQueue.cancelExecution());
    },
    getSandboxSocket: () => wsManager.getSandboxSocket(),
    sendToSandbox: (ws, message) => wsManager.send(ws, message),
    updateSandboxStatus: (status) => sandboxRepository.updateSandboxStatus(status),
  });

  const prCreationClaims = new PullRequestCreationClaims();
  const pullRequestHandler = createPullRequestHandler({
    getSession: () => sessionCoreRepository.getSession(),
    getSessionRepositories: () => sessionCoreRepository.getSessionRepositories(),
    getPromptingParticipantForPR: () => participantService.getPromptingParticipantForPR(),
    resolveAuthForPR: (participant) => participantService.resolveAuthForPR(participant),
    getSessionUrl: (sessionRow) => {
      const sessionId = sessionRow.session_name || sessionRow.id;
      const webAppUrl = env.WEB_APP_URL || env.WORKER_URL || "";
      return webAppUrl + "/session/" + sessionId;
    },
    createPullRequest: async (input, requestLog) => {
      const pullRequestService = new SessionPullRequestService({
        repository: sessionCoreRepository,
        artifactRepository,
        claims: prCreationClaims,
        sourceControlProvider: sourceControlProvider(),
        log: requestLog,
        generateId: () => generateId(),
        pushBranchToRemote: (pushSpec) => sandboxEventProcessor.pushBranchToRemote(pushSpec),
        messenger,
        appName: resolveAppName(env),
        sessionPullRequests: sessionPullRequestStore ?? undefined,
        resolveScmSettings: (repo) => resolveScmSettings(db, repo),
      });

      return pullRequestService.createPullRequest(input);
    },
    getArtifactById: (artifactId) => artifactRepository.getArtifactById(artifactId),
    updateArtifact: (artifactId, data) => artifactRepository.updateArtifact(artifactId, data),
    messenger,
    now: () => Date.now(),
    triggerPullRequestRefresh: () => schedulePullRequestRefresh("manual"),
  });

  const participantsHandler = createParticipantsHandler({
    repository: participantRepository,
  });

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
    repoSecretsEncryptionKey: env.REPO_SECRETS_ENCRYPTION_KEY,
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
    log,
  });

  // Internal HTTP route table (transport wiring only).
  const routes = createSessionInternalRoutes({
    init: (request, _url, requestLog) => sessionLifecycleHandler.init(request, requestLog),
    state: () => sessionLifecycleHandler.getState(),
    snapshot: () => snapshotReader.handleSnapshot(),
    sandboxAccess: () => accessReader.handleSandboxAccess(),
    prompt: (request, _url, requestLog) => messagesHandler.enqueuePrompt(request, requestLog),
    stop: () => messagesHandler.stop(),
    sandboxEvent: (request) => sandboxHandler.sandboxEvent(request),
    createMediaArtifact: (request) => sandboxHandler.createMediaArtifact(request),
    recordAttachment: (request) => {
      const session = sessionCoreRepository.getSession();
      return attachmentsHandler.recordAttachment(
        request,
        session ? resolvePublicSessionId(session, durableObjectId) : null
      );
    },
    listParticipants: () => participantsHandler.listParticipants(),
    addParticipant: (request) => sandboxHandler.addParticipant(request),
    listEvents: (_request, url) => messagesHandler.listEvents(url),
    listArtifacts: (_request, url) => messagesHandler.listArtifacts(url),
    listMessages: (_request, url) => messagesHandler.listMessages(url),
    createPr: (request, _url, requestLog) => pullRequestHandler.createPr(request, requestLog),
    pullRequestArtifactSnapshot: (request, url) =>
      pullRequestHandler.pullRequestArtifactSnapshot(request, url),
    pullRequestsRefresh: () => pullRequestHandler.refreshPullRequests(),
    wsToken: (request, _url, requestLog) => wsTokenHandler.generateWsToken(request, requestLog),
    updateTitle: (request) => sessionLifecycleHandler.updateTitle(request),
    archive: (request) => sessionLifecycleHandler.archive(request),
    unarchive: (request) => sessionLifecycleHandler.unarchive(request),
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
    childSummary: (_request, url) => childSessionsHandler.getChildSummary(url),
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
    http: new SessionHttpDispatcher({
      getLogger: () => log,
      routes,
      handleWebSocketUpgrade: (request, url, requestLog) =>
        connectionAuthenticator.handleWebSocketUpgrade(request, url, requestLog),
      clock,
    }),
    messages: new SessionMessageRouter({
      getLogger: () => log,
      sockets,
      clientCommands,
      processSandboxEvent: (event) => sandboxEventProcessor.processSandboxEvent(event),
      clock,
    }),
    disconnects: new SessionDisconnectHandler({
      getLogger: () => log,
      sockets,
      sandbox: sandboxDisconnects,
      broadcaster: disconnectBroadcaster,
    }),
    handleScheduledDeadline: () =>
      handleAlarmDelivery(
        alarmDeadlines,
        () => alarmHandler.handle(),
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
    sessionLifecycleHandler,
  };

  return {
    log,
    server,
    alarms: {
      rehydrate: () =>
        backgroundTasks.submit(() => alarmScheduler.rehydrate(), {
          name: "alarm.rehydrate",
        }),
    },
    internals: components,
  };
}

interface LifecycleManagerDeps {
  env: Env;
  db: SqlDatabase | null;
  /** The latched public-session-id resolver shared with the session logger. */
  getSessionId: () => string;
  sessionCoreRepository: SessionCoreRepository;
  sandboxRepository: SandboxRepository;
  userEnvResolver: UserEnvResolver;
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
    sessionCoreRepository,
    sandboxRepository,
    userEnvResolver,
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

  const storage = new DurableObjectSandboxStorage(
    sandboxRepository,
    sessionCoreRepository,
    userEnvResolver,
    env.REPO_SECRETS_ENCRYPTION_KEY
  );
  const lifecycleWsManager = new LifecycleSocketAdapter(wsManager);

  // ID generator adapter
  const idGenerator: IdGenerator = {
    generateId: () => generateId(),
  };

  // Build configuration
  const controlPlaneUrl =
    env.WORKER_URL ||
    `https://open-inspect-control-plane.${env.CF_ACCOUNT_ID || "workers"}.workers.dev`;

  // Create D1-backed lookups if database is available
  let mcpServerLookup: McpServerLookup | undefined;
  if (db) {
    const mcpStore = new McpServerStore(db, env.REPO_SECRETS_ENCRYPTION_KEY);
    mcpServerLookup = {
      getDecryptedForSession: (repositories) => mcpStore.getDecryptedForSession(repositories),
    };
  }

  // Session-scoped gate: resolved from the primary member (the scalar mirror
  // this lookup is called with) — see resolveSessionScopedSettings for the
  // per-feature scope rules. Token absence short-circuits to false so a
  // misconfigured deployment never installs a tool that would 503 on every call.
  let slackAgentNotifyLookup: SlackAgentNotifyLookup | undefined;
  if (db) {
    const tokenPresent = !!env.SLACK_BOT_TOKEN;
    const settingsStore = new IntegrationSettingsStore(db);
    slackAgentNotifyLookup = {
      isEnabledForRepo: async (repoOwner, repoName) => {
        if (!tokenPresent) return false;
        const settings =
          repoOwner && repoName
            ? (await settingsStore.getResolvedConfig("slack", `${repoOwner}/${repoName}`)).settings
            : ((await settingsStore.getGlobal("slack"))?.defaults ?? {});
        return resolveSlackSettings(settings).agentNotificationsEnabled;
      },
    };
  }

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

  // Create the image lookup if D1 is available and the provider supports
  // prebuilt images.
  let imageBuildLookup: ImageBuildLookup | undefined;
  const imageBuildProvider = resolveImageBuildProvider(sandboxBackend);
  if (db && imageBuildProvider) {
    imageBuildLookup = createImageBuildLookup(db, imageBuildProvider);
  }

  return new SandboxLifecycleManager(
    provider,
    storage,
    messenger,
    lifecycleWsManager,
    alarmScheduler,
    idGenerator,
    config,
    imageBuildLookup
  );
}
