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

  async updateSandboxCodeServer(url: string, password: string): Promise<void> {
    this.sandboxes.updateSandboxCodeServer(url, await this.encryptIfConfigured(password));
  }

  clearSandboxCodeServer(): void {
    this.sandboxes.clearSandboxCodeServer();
  }

  clearSandboxCodeServerUrl(): void {
    this.sandboxes.clearSandboxCodeServerUrl();
  }

  async updateSandboxVnc(url: string, password: string): Promise<void> {
    this.sandboxes.updateSandboxVnc(url, await this.encryptIfConfigured(password));
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

  async updateSandboxTtyd(url: string, token: string): Promise<void> {
    this.sandboxes.updateSandboxTtyd(url, await this.encryptIfConfigured(token));
  }

  clearSandboxTtyd(): void {
    this.sandboxes.clearSandboxTtyd();
  }

  private async encryptIfConfigured(value: string): Promise<string> {
    return this.encryptionKey ? encryptToken(value, this.encryptionKey) : value;
  }
}

/** The lifecycle manager's view of the session socket registry. */
export class LifecycleSocketAdapter implements WebSocketManager {
  constructor(private readonly sockets: SessionWebSocketManager) {}

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
