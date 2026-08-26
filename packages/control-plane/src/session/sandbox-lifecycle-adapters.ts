/**
 * Composition-root adapters for the sandbox lifecycle manager's ports.
 *
 * The manager owns `SandboxStorage` and `WebSocketManager`; these classes
 * implement them over the session's collaborators so the root wires objects
 * instead of building closure-bag literals inline (deps standard: pass
 * collaborators directly, give shared-collaborator groups a composition
 * class).
 */

import { encryptToken } from "../auth/crypto";
import type { SandboxStorage, WebSocketManager } from "../sandbox/lifecycle/manager";
import type { SessionRepositoryInfo } from "../sandbox/provider";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type {
  SandboxRepository,
  SandboxCircuitBreakerState,
  SpawnSandboxData,
  ResumeSandboxData,
} from "./sandbox-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type { UserEnvResolver } from "./user-env-resolver";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { SandboxRow, SessionRow } from "./types";

export class DurableObjectSandboxStorage implements SandboxStorage {
  constructor(
    private readonly sandboxes: SandboxRepository,
    private readonly sessions: SessionCoreRepository,
    private readonly userEnv: UserEnvResolver,
    /** Absent on deployments without a secrets key — values persist unencrypted. */
    private readonly encryptionKey: string | undefined
  ) {}

  getSandbox(): SandboxRow | null {
    return this.sandboxes.getSandbox();
  }

  getSandboxWithCircuitBreaker(): SandboxCircuitBreakerState | null {
    return this.sandboxes.getSandboxWithCircuitBreaker();
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

  updateSandboxStatus(status: SandboxStatus): void {
    this.sandboxes.updateSandboxStatus(status);
  }

  updateSandboxForSpawn(data: SpawnSandboxData): void {
    this.sandboxes.updateSandboxForSpawn(data);
  }

  updateSandboxAuthTokenHash(modalSandboxId: string, authTokenHash: string): boolean {
    return this.sandboxes.updateSandboxAuthTokenHash(modalSandboxId, authTokenHash);
  }

  updateSandboxForResume(data: ResumeSandboxData): void {
    this.sandboxes.updateSandboxForResume(data);
  }

  updateSandboxModalObjectId(modalObjectId: string | null): void {
    this.sandboxes.updateSandboxModalObjectId(modalObjectId);
  }

  updateSandboxRuntimeVersion(runtimeVersion: string | null): void {
    this.sandboxes.updateSandboxRuntimeVersion(runtimeVersion);
  }

  updateSandboxSnapshotImageId(
    sandboxId: string,
    imageId: string,
    runtimeVersion: string | null
  ): void {
    this.sandboxes.updateSandboxSnapshotImageId(sandboxId, imageId, runtimeVersion);
  }

  updateSandboxLastActivity(timestamp: number): void {
    this.sandboxes.updateSandboxLastActivity(timestamp);
  }

  incrementCircuitBreakerFailure(timestamp: number): void {
    this.sandboxes.incrementCircuitBreakerFailure(timestamp);
  }

  resetCircuitBreaker(): void {
    this.sandboxes.resetCircuitBreaker();
  }

  setLastSpawnError(error: string | null, timestamp: number | null): void {
    this.sandboxes.updateSandboxSpawnError(error, timestamp);
  }

  updateSandboxCodeServer(url: string, password: string): void | Promise<void> {
    return this.persistEncrypted(password, (stored) =>
      this.sandboxes.updateSandboxCodeServer(url, stored)
    );
  }

  clearSandboxCodeServer(): void {
    this.sandboxes.clearSandboxCodeServer();
  }

  clearSandboxCodeServerUrl(): void {
    this.sandboxes.clearSandboxCodeServerUrl();
  }

  updateSandboxVnc(url: string, password: string): void | Promise<void> {
    return this.persistEncrypted(password, (stored) =>
      this.sandboxes.updateSandboxVnc(url, stored)
    );
  }

  clearSandboxVnc(): void {
    this.sandboxes.clearSandboxVnc();
  }

  clearSandboxVncUrl(): void {
    this.sandboxes.clearSandboxVncUrl();
  }

  updateSandboxTunnelUrls(urls: Record<string, string>): void {
    this.sandboxes.updateSandboxTunnelUrls(urls);
  }

  clearSandboxTunnelUrls(): void {
    this.sandboxes.clearSandboxTunnelUrls();
  }

  updateSandboxTtyd(url: string, token: string): void | Promise<void> {
    return this.persistEncrypted(token, (stored) => this.sandboxes.updateSandboxTtyd(url, stored));
  }

  clearSandboxTtyd(): void {
    this.sandboxes.clearSandboxTtyd();
  }

  /**
   * Encrypt-at-rest for access secrets. The keyless branch persists
   * synchronously so callers that do not await still observe the write in the
   * same turn, matching the pre-extraction literal's ordering.
   */
  private persistEncrypted(value: string, persist: (stored: string) => void): void | Promise<void> {
    if (!this.encryptionKey) {
      persist(value);
      return;
    }
    return encryptToken(value, this.encryptionKey).then(persist);
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
