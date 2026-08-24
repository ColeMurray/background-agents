import type { Logger } from "../logger";
import { decryptStoredAccessValue } from "./sandbox-access";
import type { SandboxRepository } from "./sandbox-repository";
import type { SessionCoreRepository } from "./session-core-repository";

export interface SessionAccessReaderDeps {
  sessionCoreRepository: SessionCoreRepository;
  sandboxRepository: SandboxRepository;
  repoSecretsEncryptionKey: string | undefined;
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
    if (!sandbox || sandbox.status !== "ready") {
      return Response.json({ error: "Sandbox access is unavailable" }, { status: 409, headers });
    }

    const encryptionKey = this.deps.repoSecretsEncryptionKey;
    const [codeServerPassword, vncPassword, ttydToken] = await Promise.all([
      decryptStoredAccessValue(sandbox.code_server_password, encryptionKey, this.deps.log),
      decryptStoredAccessValue(sandbox.vnc_password, encryptionKey, this.deps.log),
      decryptStoredAccessValue(sandbox.ttyd_token, encryptionKey, this.deps.log),
    ]);
    const current = this.deps.sandboxRepository.getSandbox();
    if (
      !current ||
      current.id !== sandbox.id ||
      current.status !== "ready" ||
      current.code_server_url !== sandbox.code_server_url ||
      current.code_server_password !== sandbox.code_server_password ||
      current.vnc_url !== sandbox.vnc_url ||
      current.vnc_password !== sandbox.vnc_password ||
      current.ttyd_url !== sandbox.ttyd_url ||
      current.ttyd_token !== sandbox.ttyd_token
    ) {
      return Response.json({ error: "Sandbox access changed; retry" }, { status: 409, headers });
    }
    return Response.json(
      {
        codeServer:
          current.code_server_url && codeServerPassword
            ? { url: current.code_server_url, password: codeServerPassword }
            : null,
        vnc:
          current.vnc_url && vncPassword ? { url: current.vnc_url, password: vncPassword } : null,
        ttyd: current.ttyd_url && ttydToken ? { url: current.ttyd_url, token: ttydToken } : null,
      },
      { headers }
    );
  }
}
