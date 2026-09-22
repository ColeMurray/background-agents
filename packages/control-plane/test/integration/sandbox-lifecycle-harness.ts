import type { SessionDO } from "../../src/cloudflare/durable-object";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  SandboxLifecycleManager,
} from "../../src/sandbox/lifecycle/manager";
import type { SandboxProvider } from "../../src/sandbox/provider";
import { LifecycleSessionContext } from "../../src/session/sandbox-lifecycle-adapters";
import { SandboxShutdownCoordinator } from "../../src/session/sandbox-shutdown";
import {
  SandboxShutdownRepository,
  type ShutdownStore,
} from "../../src/session/sandbox-shutdown-repository";
import { SessionCoreRepository } from "../../src/session/session-core-repository";
import { componentsOf } from "./session-do-access";
import { EventRepository } from "../../src/session/event-repository";
import { recordSessionWarning } from "../../src/session/session-warnings";
import { MessageRepository } from "../../src/session/message-repository";
import { SessionAttachmentRepository } from "../../src/session/session-attachment-repository";
import { MessageFailureService } from "../../src/session/message-failure-service";
import { createLogger } from "../../src/logger";

/** Real lifecycle/persistence; queue admission is observed, not dispatched, and status projection is omitted. */
export function realLifecycleHarness(
  instance: SessionDO,
  durableState: DurableObjectState,
  provider: SandboxProvider,
  options: {
    store?: ShutdownStore;
    onQueueAdmission?: (decision: string) => void;
    onAnnouncement?: (message: object) => void;
    onLifecycleAnnouncement?: (message: object) => void;
    socket?: WebSocket;
  } = {}
) {
  const sandbox = componentsOf(instance).sandboxRepository;
  const sessions = new SessionCoreRepository(durableState.storage.sql, (callback) =>
    durableState.storage.transactionSync(callback)
  );
  const sessionContext = new LifecycleSessionContext(sessions, {
    getUserEnvVars: async () => undefined,
  } as never);
  const shutdownAnnouncements: object[] = [];
  const lifecycleAnnouncements: object[] = [];
  const queueAdmissions: string[] = [];
  const transaction = <T>(operation: () => T) => durableState.storage.transactionSync(operation);
  const messages = new MessageRepository(
    durableState.storage.sql,
    transaction,
    new SessionAttachmentRepository(durableState.storage.sql),
    new EventRepository(durableState.storage.sql, transaction)
  );
  const failures = new MessageFailureService(
    {
      submit: (task) => {
        void task();
      },
    },
    createLogger("retention-test"),
    messages,
    { broadcast: () => undefined, sendToSandbox: async () => undefined },
    { notifyComplete: async () => undefined } as never,
    async () => undefined
  );
  const processQueue = async () => {
    const decision = shutdown.admissionDecision();
    queueAdmissions.push(decision);
    options.onQueueAdmission?.(decision);
  };
  const shutdown = new SandboxShutdownCoordinator({
    store: options.store ?? new SandboxShutdownRepository(durableState.storage.sql),
    provider,
    sandbox,
    session: sessions,
    messages,
    failures,
    messenger: {
      broadcast: (message: object) => {
        options.onAnnouncement?.(message);
        shutdownAnnouncements.push(message);
      },
    },
    sockets: {
      getSandboxSocket: () => null,
      send: () => false,
    },
    alarm: { schedule: async () => undefined },
    background: {
      submit: (task: () => Promise<void>) => {
        void task();
      },
    },
    onLifecycleChange: processQueue,
    reconcileStatusFromMessages: async () => undefined,
    retireAccess: () => manager.retireShutdownAccess(),
  } as never);
  const manager = new SandboxLifecycleManager(
    provider,
    sandbox,
    sessionContext,
    {
      broadcast: (message) => {
        options.onLifecycleAnnouncement?.(message);
        lifecycleAnnouncements.push(message);
      },
    },
    {
      getSandboxWebSocket: () =>
        sandbox.getSandbox()?.active_socket_id === "" ? null : (options.socket ?? null),
      getConnectedClientCount: () => 0,
      sendToSandbox: () => false,
      detachSandboxWebSocket: () => sandbox.revokeActiveSocketId(),
    },
    {
      schedule: async () => undefined,
      cancel: async () => undefined,
      current: async () => null,
    },
    { generateId: () => "integration-sandbox-token" },
    shutdown,
    {
      ...DEFAULT_LIFECYCLE_CONFIG,
      controlPlaneUrl: "https://control-plane.test",
      model: "anthropic/claude-sonnet-4-5",
      recordWarning: (message: string, eventId: string) =>
        recordSessionWarning(
          new EventRepository(durableState.storage.sql, (operation) =>
            durableState.storage.transactionSync(operation)
          ),
          { broadcast: (event) => lifecycleAnnouncements.push(event) },
          message,
          eventId
        ),
    }
  );
  return {
    manager,
    shutdown,
    shutdownAnnouncements,
    lifecycleAnnouncements,
    queueAdmissions,
    processQueue,
    sandbox,
    sessions,
  };
}
