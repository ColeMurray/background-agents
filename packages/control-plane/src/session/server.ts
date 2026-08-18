import type { SessionDisconnectHandler } from "./disconnect-handler";
import type { SessionHttpDispatcher } from "./http/dispatcher";
import type { SessionMessageRouter } from "./message-router";
import type { ConnectedClient } from "./ports";

export interface SessionServerDeps<Connection, Client extends ConnectedClient> {
  ensureInitialized: (rehydrateAlarm?: boolean) => void;
  http: SessionHttpDispatcher;
  messages: SessionMessageRouter<Connection, Client>;
  disconnects: SessionDisconnectHandler<Connection, Client>;
  handleScheduledDeadline: () => Promise<void>;
}

/**
 * Platform-neutral entry point for one session runtime.
 *
 * Runtime adapters call this class instead of invoking application components
 * directly. Initialization stays here so callbacks after eviction or
 * hibernation restore repositories and session-scoped services before use.
 */
export class SessionServer<Connection, Client extends ConnectedClient> {
  constructor(private readonly deps: SessionServerDeps<Connection, Client>) {}

  onRequest(request: Request): Promise<Response> {
    return this.deps.http.dispatch(request);
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    // Hibernating runtimes may deliver a message to a newly reconstructed instance.
    this.deps.ensureInitialized();
    await this.deps.messages.route(connection, message);
  }

  async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    // Classification can require persisted mappings restored during initialization.
    this.deps.ensureInitialized();
    await this.deps.disconnects.handleClose(connection, code, reason, wasClean);
  }

  onError(connection: Connection, error: Error): void {
    this.deps.ensureInitialized();
    this.deps.disconnects.handleError(connection, error);
  }

  async onScheduledDeadline(): Promise<void> {
    // Scheduled work shares the same lazy repositories and services as request callbacks.
    this.deps.ensureInitialized(false);
    await this.deps.handleScheduledDeadline();
  }
}
