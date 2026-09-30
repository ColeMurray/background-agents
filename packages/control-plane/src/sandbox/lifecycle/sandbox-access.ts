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
export interface SandboxAccess {
  clearAccess(): void;
  retireShutdownAccess(): void;
  storeCodeServer(url: string, password: string): Promise<void>;
  storeVnc(url: string, password: string): Promise<void>;
  storeAndBroadcastTunnelUrls(urls: Record<string, string> | undefined): Promise<void>;
  storeTtyd(
    url: string,
    sandboxAuthToken: string,
    sessionId: string,
    sandboxId: string
  ): Promise<void>;
  mintTtydToken(sandboxAuthToken: string, sessionId: string, sandboxId: string): Promise<string>;
  reusableTtydToken(
    token: string | null,
    url: string | undefined,
    providerObjectId: string
  ): string | null;
  broadcastSandboxDashboardUrl(providerObjectId: string): boolean;
  broadcastProviderAccessIfConnected(): void;
}

/** Stateless operations; callers retain their existing awaits and failure boundaries. */
export function createSandboxAccess({
  storage,
  broadcaster,
  sockets,
  canResumeAfterStop,
  getLogger,
  sandboxDashboardUrlBuilder,
}: SandboxAccessDependencies): SandboxAccess {
  const access: SandboxAccess = {
    clearAccess() {
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
    },

    retireShutdownAccess() {
      access.clearAccess();
      sockets.detachSandboxWebSocket(1000, "Sandbox state preserved");
    },

    async storeCodeServer(url, password) {
      getLogger().info("Storing code-server info", { url });
      await storage.updateSandboxAccess("codeServer", url, password);
    },

    async storeVnc(url, password) {
      getLogger().info("Storing VNC info", { url });
      await storage.updateSandboxAccess("vnc", url, password);
    },

    async storeAndBroadcastTunnelUrls(urls) {
      if (!urls || Object.keys(urls).length === 0) return;
      getLogger().info("Storing and broadcasting tunnel URLs", { ports: Object.keys(urls) });
      await storage.updateSandboxTunnelUrls(urls);
      broadcaster.broadcast({ type: "sandbox_access_changed" });
    },

    async storeTtyd(url, sandboxAuthToken, sessionId, sandboxId) {
      const token = await access.mintTtydToken(sandboxAuthToken, sessionId, sandboxId);
      getLogger().info("Storing ttyd info", { url });
      await storage.updateSandboxAccess("ttyd", url, token);
    },

    mintTtydToken(sandboxAuthToken, sessionId, sandboxId) {
      return mintJwt(
        {
          sub: sessionId,
          sid: sandboxId,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + TERMINAL_TOKEN_TTL_SECONDS,
        },
        sandboxAuthToken
      );
    },

    reusableTtydToken(token, url, providerObjectId) {
      const validToken = token && isJwtUnexpired(token) ? token : null;
      if (url && !validToken) {
        // The signing key is transient; its persisted hash cannot renew terminal access.
        getLogger().warn("Terminal credential unavailable; resuming without terminal access", {
          event: "sandbox.resume_terminal_credential_unavailable",
          provider_object_id: providerObjectId,
          reason: token ? "invalid_or_expired" : "missing",
        });
      }
      return validToken;
    },

    broadcastSandboxDashboardUrl(providerObjectId) {
      const url = sandboxDashboardUrlBuilder?.(providerObjectId);
      if (url) {
        getLogger().debug("Broadcasting sandbox dashboard URL", {
          provider_object_id: providerObjectId,
        });
        broadcaster.broadcast({ type: "sandbox_access_changed" });
        return true;
      }
      return false;
    },

    broadcastProviderAccessIfConnected() {
      if (sockets.getSandboxWebSocket()) {
        broadcaster.broadcast({ type: "sandbox_access_changed" });
      }
    },
  };
  return access;
}
