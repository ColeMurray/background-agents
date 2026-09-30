import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import { isJwtUnexpired, mintJwt } from "../../auth/jwt";
import type { Logger } from "../../logger";
import type { SessionWebSocket } from "../../platform-ports";
import type { SandboxAccessKind } from "../../session/types";

/** TTL for terminal auth JWTs. */
export const TERMINAL_TOKEN_TTL_SECONDS = 86400;

/** Encryption and persistence remain repository-owned. */
export interface SandboxAccessStorage {
  updateSandboxAccess(kind: SandboxAccessKind, url: string, secret: string): void | Promise<void>;
  clearSandboxAccess(kind: SandboxAccessKind): void;
  clearSandboxAccessUrl?(kind: SandboxAccessKind): void;
  updateSandboxTunnelUrls(urls: Record<string, string>): void | Promise<void>;
  clearSandboxTunnelUrls(): void;
}

export interface SandboxAccessDependencies {
  storage: SandboxAccessStorage;
  broadcaster: { broadcast(message: ServerMessage): void };
  sockets: {
    getSandboxWebSocket(): SessionWebSocket | null;
    detachSandboxWebSocket(code: number, reason: string): void;
  };
  /** Capability check only, not a lifecycle/admission decision. */
  canResumeAfterStop: () => boolean;
  /** Construction may precede session initialization. */
  getLogger: () => Pick<Logger, "info" | "warn" | "debug">;
  sandboxDashboardUrlBuilder?: (providerObjectId: string) => string | null;
}

/** Internal access mechanics, with no readiness, generation or shutdown authority. */
export class SandboxAccess {
  constructor(private readonly deps: SandboxAccessDependencies) {}

  clearAccess(): void {
    const { storage, broadcaster, canResumeAfterStop } = this.deps;
    // Retained executions reuse credentials, while snapshot restores rotate them.
    if (canResumeAfterStop() && storage.clearSandboxAccessUrl) {
      storage.clearSandboxAccessUrl("codeServer");
      storage.clearSandboxAccessUrl("vnc");
      storage.clearSandboxAccessUrl("ttyd");
    } else {
      storage.clearSandboxAccess("codeServer");
      storage.clearSandboxAccess("vnc");
      storage.clearSandboxAccess("ttyd");
    }
    storage.clearSandboxTunnelUrls();
    broadcaster.broadcast({ type: "sandbox_access_changed" });
  }

  retireShutdownAccess(): void {
    this.clearAccess();
    this.deps.sockets.detachSandboxWebSocket(1000, "Sandbox state preserved");
  }

  async storeCodeServer(url: string, password: string): Promise<void> {
    this.deps.getLogger().info("Storing code-server info", { url });
    await this.deps.storage.updateSandboxAccess("codeServer", url, password);
  }

  async storeVnc(url: string, password: string): Promise<void> {
    this.deps.getLogger().info("Storing VNC info", { url });
    await this.deps.storage.updateSandboxAccess("vnc", url, password);
  }

  async storeAndBroadcastTunnelUrls(urls: Record<string, string> | undefined): Promise<void> {
    if (!urls || Object.keys(urls).length === 0) return;
    this.deps
      .getLogger()
      .info("Storing and broadcasting tunnel URLs", { ports: Object.keys(urls) });
    await this.deps.storage.updateSandboxTunnelUrls(urls);
    this.deps.broadcaster.broadcast({ type: "sandbox_access_changed" });
  }

  async storeTtyd(
    url: string,
    sandboxAuthToken: string,
    sessionId: string,
    sandboxId: string
  ): Promise<void> {
    const token = await this.mintTtydToken(sandboxAuthToken, sessionId, sandboxId);
    this.deps.getLogger().info("Storing ttyd info", { url });
    await this.deps.storage.updateSandboxAccess("ttyd", url, token);
  }

  mintTtydToken(sandboxAuthToken: string, sessionId: string, sandboxId: string): Promise<string> {
    return mintJwt(
      {
        sub: sessionId,
        sid: sandboxId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + TERMINAL_TOKEN_TTL_SECONDS,
      },
      sandboxAuthToken
    );
  }

  reusableTtydToken(
    token: string | null,
    url: string | undefined,
    providerObjectId: string
  ): string | null {
    const validToken = token && isJwtUnexpired(token) ? token : null;
    if (url && !validToken) {
      // The signing key is transient; its persisted hash cannot renew terminal access.
      this.deps
        .getLogger()
        .warn("Terminal credential unavailable; resuming without terminal access", {
          event: "sandbox.resume_terminal_credential_unavailable",
          provider_object_id: providerObjectId,
          reason: token ? "invalid_or_expired" : "missing",
        });
    }
    return validToken;
  }

  broadcastSandboxDashboardUrl(providerObjectId: string): boolean {
    const url = this.deps.sandboxDashboardUrlBuilder?.(providerObjectId);
    if (url) {
      this.deps.getLogger().debug("Broadcasting sandbox dashboard URL", {
        provider_object_id: providerObjectId,
      });
      this.deps.broadcaster.broadcast({ type: "sandbox_access_changed" });
      return true;
    }
    return false;
  }

  broadcastProviderAccessIfConnected(): void {
    if (this.deps.sockets.getSandboxWebSocket()) {
      this.deps.broadcaster.broadcast({ type: "sandbox_access_changed" });
    }
  }
}
