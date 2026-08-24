/**
 * Composition root for one session runtime.
 *
 * `createSessionComponents` builds the entire collaborator graph eagerly, in
 * topological order, with exactly one session-scoped logger created before
 * anything can capture it. `SessionDO.ensureInitialized()` is the single call
 * site; the schema must already be applied when this runs, because the factory
 * reads the session row to derive the logger's `session_id`.
 *
 * The only deferred constructions left are the two provider factories, both of
 * which throw on reachable configurations (`createSandboxProviderFromEnv` on
 * missing provider credentials, `createSourceControlProviderFromEnv` on an
 * invalid `SCM_PROVIDER`, GitLab without a token, or Bitbucket). Deferring
 * them — behind `once()` at this root, not behind lazy getters on the DO —
 * keeps `/internal/init` succeeding on such deployments: the failure surfaces
 * at the operation that needs the provider and is absorbed by the background
 * task boundary, instead of failing every request at initialization.
 */

import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import { resolveAppName } from "@open-inspect/shared/app-name";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import { generateId, hashToken, encryptToken } from "../auth/crypto";
import { resolveSandboxBackendName, type SandboxBackendName } from "../sandbox/provider-name";
import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import type { SandboxProvider } from "../sandbox/provider";
import { DEFAULT_SANDBOX_TIMEOUT_SECONDS } from "../sandbox/provider";
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
import { SessionIndexStore } from "../db/session-index";
import { parsePersistedSandboxSettings } from "../sandbox/settings";
import {
  createSourceControlProviderFromEnv,
  resolveScmProviderFromEnv,
  type SourceControlProvider,
} from "../source-control";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import { SessionCoreRepository } from "./session-core-repository";
import { SandboxRepository } from "./sandbox-repository";
import { SessionAttachmentRepository } from "./session-attachment-repository";
import { ArtifactRepository } from "./artifact-repository";
import { EventRepository } from "./event-repository";
import { MessageRepository } from "./message-repository";
import { ParticipantRepository } from "./participant-repository";
import { WsClientMappingRepository } from "./ws-client-mapping-repository";
import { resolvePublicSessionId } from "./public-session-id";
import { resolveScmSettings } from "./scm-settings-resolution";
import { validateReasoningEffort } from "./reasoning-effort";
import {
  isValidSandboxToken,
  resolveSandboxDashboardUrl,
  type SandboxDashboardSettings,
} from "./sandbox-access";
import { SessionWebSocketManagerImpl, type SessionWebSocketManager } from "./websocket-manager";
import { DurableObjectSessionConnections } from "./durable-object-session-connections";
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
import type { BackgroundTasks } from "../platform-ports";
import { PresenceService } from "./presence-service";
import { SessionMessageQueue } from "./message-queue";
import { SessionSandboxEventProcessor } from "./sandbox-events";
import { SessionTerminalMessageProjection } from "./terminal-message-projection";
import { SessionEventStream } from "./event-stream";
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
  createPullRequestHandler,
  type PullRequestHandler,
} from "./http/handlers/pull-request.handler";
import {
  createParticipantsHandler,
  type ParticipantsHandler,
} from "./http/handlers/participants.handler";
import { MessageService } from "./services/message.service";
import { createAlarmHandler, type AlarmHandler } from "./alarm/handler";
import {
  createEarliestAlarmScheduler,
  PersistedAlarmDeadlineStore,
  type RehydratableAlarmScheduler,
} from "./alarm/scheduler";
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

export interface SessionComponents {
  log: Logger;
  backgroundTasks: BackgroundTasks;
  // Repositories over the DO-embedded SQLite.
  sessionCoreRepository: SessionCoreRepository;
  sandboxRepository: SandboxRepository;
  attachmentRepository: SessionAttachmentRepository;
  artifactRepository: ArtifactRepository;
  eventRepository: EventRepository;
  messageRepository: MessageRepository;
  participantRepository: ParticipantRepository;
  wsClientMappingRepository: WsClientMappingRepository;
  // Alarm persistence and scheduling.
  alarmDeadlines: PersistedAlarmDeadlineStore;
  alarmScheduler: RehydratableAlarmScheduler;
  alarmHandler: AlarmHandler;
  // Sockets and messaging.
  wsManager: SessionWebSocketManager;
  connections: DurableObjectSessionConnections;
  messenger: SessionMessenger;
  // Immutable env projection for the provider dashboard link.
  sandboxDashboardSettings: SandboxDashboardSettings;
  /** Deferred: `createSourceControlProviderFromEnv` throws on reachable configs. */
  sourceControlProvider: () => SourceControlProvider;
  // Domain services.
  userEnvResolver: UserEnvResolver;
  participantService: ParticipantService;
  callbackService: CallbackNotificationService;
  presenceService: PresenceService;
  statusService: SessionStatusService;
  titleService: SessionTitleService;
  terminalMessageProjection: SessionTerminalMessageProjection;
  diffService: SessionDiffService;
  eventStream: SessionEventStream;
  lifecycleManager: SandboxLifecycleManager;
  messageQueue: SessionMessageQueue;
  messageService: MessageService;
  sandboxEventProcessor: SessionSandboxEventProcessor;
  /** Fire a background read-through refresh of the session's PR artifacts. */
  schedulePullRequestRefresh: (trigger: "open" | "manual") => void;
  // Internal HTTP handlers.
  messagesHandler: MessagesHandler;
  childSessionsHandler: ChildSessionsHandler;
  sandboxHandler: SandboxHandler;
  attachmentsHandler: AttachmentsHandler;
  wsTokenHandler: WsTokenHandler;
  sessionLifecycleHandler: SessionLifecycleHandler;
  pullRequestHandler: PullRequestHandler;
  participantsHandler: ParticipantsHandler;
  diffsHandler: SessionDiffsHandler;
}

/** `resolveSandboxBackendName` throws on unsupported values; graph-time uses need null instead. */
function tryResolveSandboxBackendName(value: string | undefined): SandboxBackendName | null {
  try {
    return resolveSandboxBackendName(value);
  } catch {
    return null;
  }
}

/** Memoize a factory so its (possibly throwing) construction runs at most once. */
function once<T>(create: () => T): () => T {
  let value: T | undefined;
  let created = false;
  return () => {
    if (!created) {
      value = create();
      created = true;
    }
    return value as T;
  };
}

/**
 * Adapt a deferred provider factory to the `SandboxProvider` interface.
 *
 * The lifecycle manager takes a provider instance; constructing one throws on
 * deployments missing provider credentials. Every member defers to the real
 * provider on first touch, so the construction error surfaces inside the
 * spawn/snapshot operation that needed it (an absorbed background-task
 * rejection) rather than at graph construction.
 */
export function createDeferredSandboxProvider(create: () => SandboxProvider): SandboxProvider {
  const resolve = once(create);
  return {
    get name() {
      return resolve().name;
    },
    get capabilities() {
      return resolve().capabilities;
    },
    createSandbox: (config) => resolve().createSandbox(config),
    get restoreFromSnapshot() {
      const provider = resolve();
      const restore = provider.restoreFromSnapshot;
      return restore && restore.bind(provider);
    },
    get resumeSandbox() {
      const provider = resolve();
      const resume = provider.resumeSandbox;
      return resume && resume.bind(provider);
    },
    get takeSnapshot() {
      const provider = resolve();
      const snapshot = provider.takeSnapshot;
      return snapshot && snapshot.bind(provider);
    },
    get stopSandbox() {
      const provider = resolve();
      const stop = provider.stopSandbox;
      return stop && stop.bind(provider);
    },
  };
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

export function createSessionComponents(platform: SessionPlatform, env: Env): SessionComponents {
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

  // The session-scoped logger, created before anything can capture a logger at
  // all. Before `init` writes the session row this resolves to the Durable
  // Object id; the lifecycle manager re-derives its log context per use, so it
  // picks up the public session id once the row exists.
  const session = sessionCoreRepository.getSession();
  const log = createLogger(
    "session-do",
    { session_id: resolvePublicSessionId(session, durableObjectId) },
    parseLogLevel(env.LOG_LEVEL)
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

  // Tier 3 — connection fan-out.
  const connections = new DurableObjectSessionConnections(ctx, wsManager);
  const messenger: SessionMessenger = new SessionMessengerImpl(connections);

  // Deferred: `createSourceControlProviderFromEnv` throws on reachable configs.
  // Consumers read it through the returned record rather than capturing the
  // memo directly, so the collaborator-wiring suite can substitute a stub by
  // replacing `components.sourceControlProvider`.
  const scmProviderOnce = once(() => createSourceControlProviderFromEnv(env));
  const sourceControlProvider = () => components.sourceControlProvider();

  const sandboxDashboardSettings: SandboxDashboardSettings = {
    sandboxProvider: env.SANDBOX_PROVIDER,
    modalWorkspace: env.MODAL_WORKSPACE,
    modalEnvironment: env.MODAL_ENVIRONMENT,
  };

  // Tier 4 — session-scoped domain services.
  const userEnvResolver = new UserEnvResolver({
    db,
    sessionCoreRepository,
    resolveRepoId: (sessionRow) =>
      resolveSessionRepoId(sessionRow, sessionCoreRepository, sourceControlProvider),
    durableObjectId,
    repoSecretsEncryptionKey: env.REPO_SECRETS_ENCRYPTION_KEY,
    secretsCapEnforcement: env.SECRETS_CAP_ENFORCEMENT,
    log,
  });

  const terminalMessageProjection = new SessionTerminalMessageProjection(
    db ? new SessionIndexStore(db) : null,
    () => {
      const current = sessionCoreRepository.getSession();
      return current ? resolvePublicSessionId(current, durableObjectId) : null;
    },
    log
  );

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
    db ? new SessionIndexStore(db) : null,
    env.SESSION ?? null
  );

  const titleService = new SessionTitleService({
    sessionCoreRepository,
    messenger,
    statusService,
    backgroundTasks,
    sessionIndexStore: db ? new SessionIndexStore(db) : null,
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
    durableObjectId,
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
    (messageId, messageCreatedAt, completedAt) =>
      terminalMessageProjection.recordTerminalMessage({
        messageId,
        messageCreatedAt,
        terminalMessageCompletedAt: completedAt,
      }),
    lifecycleManager,
    db ? new SessionIndexStore(db) : null,
    once(() => resolveScmProviderFromEnv(env.SCM_PROVIDER)),
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
    (messageId, messageCreatedAt, completedAt) =>
      terminalMessageProjection.recordTerminalMessage({
        messageId,
        messageCreatedAt,
        terminalMessageCompletedAt: completedAt,
      }),
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
          db ? new SessionPullRequestStore(db) : null
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
        (row) => resolveSessionRepoId(row, sessionCoreRepository, sourceControlProvider),
        requestLog
      );
      return service.refresh(sessionRow);
    },
    refreshXaiToken: async (sessionRow, requestLog) => {
      const service = new XaiTokenRefreshService(
        db!,
        env.REPO_SECRETS_ENCRYPTION_KEY!,
        (row) => resolveSessionRepoId(row, sessionCoreRepository, sourceControlProvider),
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
        sessionPullRequests: db ? new SessionPullRequestStore(db) : undefined,
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

  const components: SessionComponents = {
    log,
    backgroundTasks,
    sessionCoreRepository,
    sandboxRepository,
    attachmentRepository,
    artifactRepository,
    eventRepository,
    messageRepository,
    participantRepository,
    wsClientMappingRepository,
    alarmDeadlines,
    alarmScheduler,
    alarmHandler,
    wsManager,
    connections,
    messenger,
    sandboxDashboardSettings,
    sourceControlProvider: scmProviderOnce,
    userEnvResolver,
    participantService,
    callbackService,
    presenceService,
    statusService,
    titleService,
    terminalMessageProjection,
    diffService,
    eventStream,
    lifecycleManager,
    messageQueue,
    messageService,
    sandboxEventProcessor,
    schedulePullRequestRefresh,
    messagesHandler,
    childSessionsHandler,
    sandboxHandler,
    attachmentsHandler,
    wsTokenHandler,
    sessionLifecycleHandler,
    pullRequestHandler,
    participantsHandler,
    diffsHandler,
  };
  return components;
}

interface LifecycleManagerDeps {
  env: Env;
  db: SqlDatabase | null;
  durableObjectId: string;
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
    durableObjectId,
    sessionCoreRepository,
    sandboxRepository,
    userEnvResolver,
    messenger,
    wsManager,
    alarmScheduler,
    sandboxDashboardSettings,
  } = deps;
  // Resolved leniently at graph time: an unsupported SANDBOX_PROVIDER must
  // fail at the spawn that needs it (via the deferred provider below), not at
  // graph construction — the same reachable-throw rule as the provider factory.
  const sandboxBackend = tryResolveSandboxBackendName(env.SANDBOX_PROVIDER);

  const provider = createDeferredSandboxProvider(() =>
    createSandboxProviderFromEnv(env, resolveSandboxBackendName(env.SANDBOX_PROVIDER))
  );

  // Storage adapter
  const storage: SandboxStorage = {
    getSandbox: () => sandboxRepository.getSandbox(),
    getSandboxWithCircuitBreaker: () => sandboxRepository.getSandboxWithCircuitBreaker(),
    getSession: () => sessionCoreRepository.getSession(),
    getSessionRepositories: () =>
      sessionCoreRepository.getSessionRepositories().map((entry) => ({
        repoOwner: entry.repoOwner,
        repoName: entry.repoName,
        baseBranch: entry.baseBranch ?? "main",
        baseSha: entry.row?.base_sha ?? null,
      })),
    getUserEnvVars: () => userEnvResolver.getUserEnvVars(),
    updateSandboxStatus: (status) => sandboxRepository.updateSandboxStatus(status),
    updateSandboxForSpawn: (data) => sandboxRepository.updateSandboxForSpawn(data),
    updateSandboxForResume: (data) => sandboxRepository.updateSandboxForResume(data),
    updateSandboxModalObjectId: (id) => sandboxRepository.updateSandboxModalObjectId(id),
    updateSandboxRuntimeVersion: (runtimeVersion) =>
      sandboxRepository.updateSandboxRuntimeVersion(runtimeVersion),
    updateSandboxSnapshotImageId: (sandboxId, imageId, runtimeVersion) =>
      sandboxRepository.updateSandboxSnapshotImageId(sandboxId, imageId, runtimeVersion),
    updateSandboxLastActivity: (timestamp) =>
      sandboxRepository.updateSandboxLastActivity(timestamp),
    incrementCircuitBreakerFailure: (timestamp) =>
      sandboxRepository.incrementCircuitBreakerFailure(timestamp),
    resetCircuitBreaker: () => sandboxRepository.resetCircuitBreaker(),
    setLastSpawnError: (error, timestamp) =>
      sandboxRepository.updateSandboxSpawnError(error, timestamp),
    updateSandboxCodeServer: async (url, password) => {
      const encrypted = env.REPO_SECRETS_ENCRYPTION_KEY
        ? await encryptToken(password, env.REPO_SECRETS_ENCRYPTION_KEY)
        : password;
      sandboxRepository.updateSandboxCodeServer(url, encrypted);
    },
    clearSandboxCodeServer: () => sandboxRepository.clearSandboxCodeServer(),
    clearSandboxCodeServerUrl: () => sandboxRepository.clearSandboxCodeServerUrl(),
    updateSandboxVnc: async (url, password) => {
      const encrypted = env.REPO_SECRETS_ENCRYPTION_KEY
        ? await encryptToken(password, env.REPO_SECRETS_ENCRYPTION_KEY)
        : password;
      sandboxRepository.updateSandboxVnc(url, encrypted);
    },
    clearSandboxVnc: () => sandboxRepository.clearSandboxVnc(),
    clearSandboxVncUrl: () => sandboxRepository.clearSandboxVncUrl(),
    updateSandboxTunnelUrls: (urls) => sandboxRepository.updateSandboxTunnelUrls(urls),
    clearSandboxTunnelUrls: () => sandboxRepository.clearSandboxTunnelUrls(),
    updateSandboxTtyd: async (url, token) => {
      const encrypted = env.REPO_SECRETS_ENCRYPTION_KEY
        ? await encryptToken(token, env.REPO_SECRETS_ENCRYPTION_KEY)
        : token;
      sandboxRepository.updateSandboxTtyd(url, encrypted);
    },
    clearSandboxTtyd: () => sandboxRepository.clearSandboxTtyd(),
  };

  // Broadcaster adapter
  const broadcaster: SandboxBroadcaster = {
    broadcast: (message) => messenger.broadcast(message as ServerMessage),
  };

  // WebSocket manager adapter — thin delegation to wsManager
  const lifecycleWsManager: WebSocketManager = {
    getSandboxWebSocket: () => wsManager.getSandboxSocket(),
    detachSandboxWebSocket: (code, reason) => wsManager.detachSandboxSocket(code, reason),
    sendToSandbox: (message) => {
      const ws = wsManager.getSandboxSocket();
      return ws ? wsManager.send(ws, message) : false;
    },
    getConnectedClientCount: () => wsManager.getConnectedClientCount(),
  };

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
    // Re-derived per use: on the first-ever activation the manager is built
    // during the init request, before the session row exists.
    getSessionId: () => resolvePublicSessionId(sessionCoreRepository.getSession(), durableObjectId),
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
  const imageBuildProvider = sandboxBackend ? resolveImageBuildProvider(sandboxBackend) : null;
  if (db && imageBuildProvider) {
    imageBuildLookup = createImageBuildLookup(db, imageBuildProvider);
  }

  return new SandboxLifecycleManager(
    provider,
    storage,
    broadcaster,
    lifecycleWsManager,
    alarmScheduler,
    idGenerator,
    config,
    imageBuildLookup
  );
}
