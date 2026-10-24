import type { CredentialScope } from "../source-control/credential-scope";
import type { SourceControlProvider } from "../source-control";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import type { EventRepository } from "./event-repository";
import type { MessageRepository } from "./message-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionIndexStore } from "../db/session-index";
import type { MessageService } from "./services/message.service";
import type { RehydratableAlarmScheduler } from "./alarm/scheduler";
import type { SessionPlatform } from "./platform";
import type { SqlStorage, TransactionSync } from "./sql-storage";
import {
  createSessionInternalRoutes,
  type SessionInternalRoute,
  type SessionInternalRouteHandlers,
} from "./http/routes";

export interface SessionExtensionServicesContext {
  env: Env;
  db: SqlDatabase;
  sql: SqlStorage;
  transaction: TransactionSync;
  durableObjectId: SessionPlatform["id"];
  repoSecretsEncryptionKey: string;
  getPublicSessionId(): string;
  resolveCredentialScope(sessionId: string): Promise<CredentialScope>;
  sourceControlProvider(): SourceControlProvider;
  sessionIndexStore: SessionIndexStore;
  sessionCoreRepository: SessionCoreRepository;
  messageRepository: MessageRepository;
  eventRepository: EventRepository;
  messageService: MessageService;
  alarmScheduler: RehydratableAlarmScheduler;
  activeOperation(request: Request): boolean;
  turnAuthorMayAct(operationId: string): Promise<boolean>;
}

export interface SessionExtensionServices {
  createRoutes(handlers: SessionInternalRouteHandlers): SessionInternalRoute[];
  alarm?: { recoverDue(): Promise<void>; nextDeadline(): number | null };
  contextContributions(): Promise<Record<string, unknown>>;
  components: Record<string, unknown>;
  rehydrate(): Promise<void>;
}

export type SessionExtensionServicesFactory = (
  context: SessionExtensionServicesContext
) => SessionExtensionServices;

let registeredFactory: SessionExtensionServicesFactory | undefined;

/** Install deployment-only session services without importing them from core. */
export function registerSessionExtensionServicesFactory(
  factory: SessionExtensionServicesFactory
): void {
  registeredFactory = factory;
}

export function createRegisteredSessionExtensionServices(
  context: SessionExtensionServicesContext
): SessionExtensionServices {
  return (
    registeredFactory?.(context) ?? {
      createRoutes: createSessionInternalRoutes,
      contextContributions: async () => ({}),
      components: {},
      rehydrate: async () => undefined,
    }
  );
}
