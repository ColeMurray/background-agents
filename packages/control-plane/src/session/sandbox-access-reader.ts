import type { Logger } from "../logger";
import { isSandboxAccessAvailable } from "../sandbox/lifecycle/decisions";
import { decryptStoredAccessValue, decryptStoredAccessValueOrPlaintext } from "./sandbox-access";
import type { SandboxStateReader } from "./sandbox-ports";
import type { SessionCoreRepository } from "./session-core-repository";
import { resolveSandboxDashboardUrl, type SandboxDashboardSettings } from "./sandbox-access";
import { safeParseTunnelUrls } from "./tunnel-urls";

export interface SessionAccessReaderDeps {
  sessionCoreRepository: Pick<SessionCoreRepository, "getSession">;
  sandboxRepository: SandboxStateReader;
  repoSecretsEncryptionKey: string;
  sandboxDashboardSettings: SandboxDashboardSettings;
  log: Logger;
}

/**
 * Serves the sandbox access credentials (code-server, VNC, ttyd) for a ready
 * sandbox, decrypting stored secrets and re-checking the row after the async
 * decrypts so a mid-flight replacement cannot leak mismatched credentials.
 */
export class SessionAccessReader {
  constructor(private readonly deps: SessionAccessReaderDeps) {}

  async handleSandboxAccess(): Promise<Response> {
    const headers = { "Cache-Control": "private, no-store" };
    if (!this.deps.sessionCoreRepository.getSession()) {
      return Response.json({ error: "Session not found" }, { status: 404, headers });
    }
    const sandbox = this.deps.sandboxRepository.getSandbox();
    if (!sandbox || !isSandboxAccessAvailable(sandbox.status)) {
      return Response.json({ error: "Sandbox access is unavailable" }, { status: 409, headers });
    }

    const encryptionKey = this.deps.repoSecretsEncryptionKey;
    const [codeServerUrl, codeServerPassword, vncUrl, vncPassword, ttydUrl, ttydToken, tunnelUrls] =
      await Promise.all([
        decryptStoredAccessValueOrPlaintext(sandbox.code_server_url, encryptionKey, this.deps.log),
        decryptStoredAccessValue(sandbox.code_server_password, encryptionKey, this.deps.log),
        decryptStoredAccessValueOrPlaintext(sandbox.vnc_url, encryptionKey, this.deps.log),
        decryptStoredAccessValue(sandbox.vnc_password, encryptionKey, this.deps.log),
        decryptStoredAccessValueOrPlaintext(sandbox.ttyd_url, encryptionKey, this.deps.log),
        decryptStoredAccessValue(sandbox.ttyd_token, encryptionKey, this.deps.log),
        decryptStoredAccessValueOrPlaintext(sandbox.tunnel_urls, encryptionKey, this.deps.log),
      ]);
    const current = this.deps.sandboxRepository.getSandbox();
    if (
      !current ||
      current.id !== sandbox.id ||
      !isSandboxAccessAvailable(current.status) ||
      current.code_server_url !== sandbox.code_server_url ||
      current.code_server_password !== sandbox.code_server_password ||
      current.vnc_url !== sandbox.vnc_url ||
      current.vnc_password !== sandbox.vnc_password ||
      current.ttyd_url !== sandbox.ttyd_url ||
      current.ttyd_token !== sandbox.ttyd_token ||
      current.tunnel_urls !== sandbox.tunnel_urls ||
      current.modal_object_id !== sandbox.modal_object_id
    ) {
      return Response.json({ error: "Sandbox access changed; retry" }, { status: 409, headers });
    }
    return Response.json(
      {
        codeServer:
          codeServerUrl && codeServerPassword
            ? { url: codeServerUrl, password: codeServerPassword }
            : null,
        vnc: vncUrl && vncPassword ? { url: vncUrl, password: vncPassword } : null,
        ttyd: ttydUrl && ttydToken ? { url: ttydUrl, token: ttydToken } : null,
        tunnelUrls: tunnelUrls ? safeParseTunnelUrls(tunnelUrls, this.deps.log) : null,
        sandboxDashboardUrl: resolveSandboxDashboardUrl(
          this.deps.sandboxDashboardSettings,
          current.modal_object_id
        ),
      },
      { headers }
    );
  }
}
