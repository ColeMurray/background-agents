import type { SessionDisconnectHandler } from "./disconnect-handler";
import type { SessionHttpDispatcher } from "./http/dispatcher";
import type { SessionMessageRouter } from "./message-router";
import type { ConnectedClient } from "./ports";

export interface SessionServerDeps<Connection, Client extends ConnectedClient> {
  http: SessionHttpDispatcher;
  messages: SessionMessageRouter<Connection, Client>;
  disconnects: SessionDisconnectHandler<Connection, Client>;
  handleScheduledDeadline: () => Promise<void>;
}

/**
 * Platform-neutral entry point for one session runtime.
 *
 * Runtime adapters call this class instead of invoking application components
 * directly. The adapter initializes the runtime before any entry point here
 * is reachable — including callbacks delivered to a hibernation-restored
 * instance, which reconstruct the runtime on first touch.
 */
export class SessionServer<Connection, Client extends ConnectedClient> {
  constructor(private readonly deps: SessionServerDeps<Connection, Client>) {}

  onRequest(request: Request): Promise<Response> {
    return this.deps.http.dispatch(request);
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    await this.deps.messages.route(connection, message);
  }

  async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    await this.deps.disconnects.handleClose(connection, code, reason, wasClean);
  }

  onError(connection: Connection, error: Error): void {
    this.deps.disconnects.handleError(connection, error);
  }

  async onScheduledDeadline(): Promise<void> {
    await this.deps.handleScheduledDeadline();
  }
}
