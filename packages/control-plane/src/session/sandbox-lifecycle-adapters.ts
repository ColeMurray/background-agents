/**
 * Composition-root adapters for the sandbox lifecycle manager's ports.
 *
 * `SandboxStorage` needs no adapter at all — it is the repository's contract
 * and `SandboxRepository` satisfies it structurally. What lives here are the
 * two ports that genuinely span or narrow other collaborators: the session
 * context the manager reads alongside storage, and the slice of the socket
 * registry it may touch.
 */

import type { SessionContextReader, WebSocketManager } from "../sandbox/lifecycle/manager";
import type { SessionRepositoryInfo } from "../sandbox/provider";
import type { SessionCoreRepository } from "./session-core-repository";
import type { UserEnvResolver } from "./user-env-resolver";
import type { SessionRow } from "./types";
import type { SessionWebSocketManager } from "./websocket-manager";
import { DEFAULT_BASE_BRANCH } from "../repos/default-branch";

/** The session-context reads owned by the session repositories and resolver. */
export class LifecycleSessionContext implements SessionContextReader {
  constructor(
    private readonly sessions: SessionCoreRepository,
    private readonly userEnv: UserEnvResolver
  ) {}

  getSession(): SessionRow | null {
    return this.sessions.getSession();
  }

  getSessionRepositories(): SessionRepositoryInfo[] {
    return this.sessions.getSessionRepositories().map((entry) => ({
      repoOwner: entry.repoOwner,
      repoName: entry.repoName,
      baseBranch: entry.baseBranch ?? DEFAULT_BASE_BRANCH,
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
