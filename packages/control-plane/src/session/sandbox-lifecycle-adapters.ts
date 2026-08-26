/**
 * Composition-root adapters for the sandbox lifecycle manager's ports.
 *
 * `DurableObjectSandboxStorage` satisfies the manager's `SandboxStorage` port
 * without a forwarding layer: the sandbox-row surface (encryption included) is
 * the repository itself, inherited; this class adds only the session-context
 * reads the port bundles with it. Keeping the `implements` here — not on the
 * repository — keeps the manager-port dependency at the composition edge.
 */

import type { SandboxStorage, WebSocketManager } from "../sandbox/lifecycle/manager";
import type { SessionRepositoryInfo } from "../sandbox/provider";
import type { Logger } from "../logger";
import { SandboxRepository } from "./sandbox-repository";
import type { SqlStorage } from "./sql-storage";
import type { SessionCoreRepository } from "./session-core-repository";
import type { UserEnvResolver } from "./user-env-resolver";
import type { SessionRow } from "./types";
import type { SessionWebSocketManager } from "./websocket-manager";

export class DurableObjectSandboxStorage extends SandboxRepository implements SandboxStorage {
  constructor(
    sql: SqlStorage,
    log: Logger,
    encryptionKey: string,
    private readonly sessions: SessionCoreRepository,
    private readonly userEnv: UserEnvResolver
  ) {
    super(sql, log, encryptionKey);
  }

  getSession(): SessionRow | null {
    return this.sessions.getSession();
  }

  getSessionRepositories(): SessionRepositoryInfo[] {
    return this.sessions.getSessionRepositories().map((entry) => ({
      repoOwner: entry.repoOwner,
      repoName: entry.repoName,
      baseBranch: entry.baseBranch ?? "main",
      baseSha: entry.row?.base_sha ?? null,
    }));
  }

  getUserEnvVars(): Promise<Record<string, string> | undefined> {
    return this.userEnv.getUserEnvVars();
  }
}

/**
 * The slice of the socket registry the lifecycle manager's port needs —
 * narrowed like the messenger's `DeliverySockets` so lifecycle wiring cannot
 * grow dependencies on admission, identity, or teardown operations.
 */
type LifecycleSockets = Pick<
  SessionWebSocketManager,
  "getSandboxSocket" | "detachSandboxSocket" | "send" | "getConnectedClientCount"
>;

/** The lifecycle manager's view of the session socket registry. */
export class LifecycleSocketAdapter implements WebSocketManager {
  constructor(private readonly sockets: LifecycleSockets) {}

  getSandboxWebSocket(): WebSocket | null {
    return this.sockets.getSandboxSocket();
  }

  detachSandboxWebSocket(code: number, reason: string): void {
    this.sockets.detachSandboxSocket(code, reason);
  }

  sendToSandbox(message: object): boolean {
    const ws = this.sockets.getSandboxSocket();
    return ws ? this.sockets.send(ws, message) : false;
  }

  getConnectedClientCount(): number {
    return this.sockets.getConnectedClientCount();
  }
}
