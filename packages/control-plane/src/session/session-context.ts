import type { Logger } from "../logger";
import type { Env } from "../types";
import type { SourceControlProvider } from "../source-control";
import type { SessionRepository } from "./repository";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { ParticipantService } from "./participant-service";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { PresenceService } from "./presence-service";
import type { SandboxLifecycleManager } from "../sandbox/lifecycle/manager";

export interface SessionContext {
  env: Env;
  ctx: DurableObjectState;
  log: Logger;
  repository: SessionRepository;
  wsManager: SessionWebSocketManager;
  lifecycleManager: SandboxLifecycleManager;
  sourceControlProvider: SourceControlProvider;
  participantService: ParticipantService;
  callbackService: CallbackNotificationService;
  presenceService: PresenceService;
  now: () => number;
  generateId: (bytes?: number) => string;
}
