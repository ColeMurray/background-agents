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

/**
 * Platform-neutral entry point for one session runtime.
 *
 * Runtime adapters call this class instead of invoking application components
 * directly. Initialization stays here so callbacks after eviction or
 * hibernation restore repositories and session-scoped services before use.
 */
export class SessionEngine<Connection, Client extends SessionRuntimeClient> {
  constructor(private readonly deps: SessionEngineDeps<Connection, Client>) {}

  fetch(request: Request): Promise<Response> {
    // The dispatcher starts timing before initialization so init latency remains observable.
    return this.deps.http.fetch(request, this.deps.initialize);
  }

  async webSocketMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    // Hibernating runtimes may deliver a message to a newly reconstructed instance.
    this.deps.initialize();
    await this.deps.socketProtocol.handleMessage(connection, message);
  }

  async webSocketClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    // Classification can require persisted mappings restored during initialization.
    this.deps.initialize();
    await this.deps.connectionLifecycle.handleClose(connection, code, reason, wasClean);
  }

  webSocketError(connection: Connection, error: Error): void {
    this.deps.initialize();
    this.deps.connectionLifecycle.handleError(connection, error);
  }

  async alarm(): Promise<void> {
    // Alarm work shares the same lazy repositories and services as request callbacks.
    this.deps.initialize();
    await this.deps.handleAlarm();
  }
}
