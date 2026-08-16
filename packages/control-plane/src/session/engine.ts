import type { SessionConnectionLifecycle } from "./connection-lifecycle";
import type { SessionHttpDispatcher } from "./http/dispatcher";
import type { SessionRuntimeClient } from "./runtime-contracts";
import type { SessionSocketProtocol } from "./socket-protocol";

export interface SessionEngineDeps<Connection, Client extends SessionRuntimeClient> {
  initialize: () => void;
  http: SessionHttpDispatcher;
  socketProtocol: SessionSocketProtocol<Connection, Client>;
  connectionLifecycle: SessionConnectionLifecycle<Connection, Client>;
  handleAlarm: () => Promise<void>;
}

/** Coordinates runtime callbacks across focused, platform-neutral session components. */
export class SessionEngine<Connection, Client extends SessionRuntimeClient> {
  constructor(private readonly deps: SessionEngineDeps<Connection, Client>) {}

  fetch(request: Request): Promise<Response> {
    return this.deps.http.fetch(request, this.deps.initialize);
  }

  async webSocketMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    this.deps.initialize();
    await this.deps.socketProtocol.handleMessage(connection, message);
  }

  async webSocketClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    this.deps.initialize();
    await this.deps.connectionLifecycle.handleClose(connection, code, reason, wasClean);
  }

  webSocketError(connection: Connection, error: Error): void {
    this.deps.initialize();
    this.deps.connectionLifecycle.handleError(connection, error);
  }

  async alarm(): Promise<void> {
    this.deps.initialize();
    await this.deps.handleAlarm();
  }
}
