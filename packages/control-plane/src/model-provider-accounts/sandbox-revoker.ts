import { SessionInternalPaths } from "../session/contracts";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { SandboxRevocationOutcome, SandboxRevoker } from "./credential-cleanup";

/** Sandbox-id-conditional stop through the session runtime's revoke path. */
export class SessionRuntimeSandboxRevoker implements SandboxRevoker {
  constructor(private readonly sessions: SessionRuntimeClient) {}

  async revoke(
    sessionId: string,
    expectedSandboxId: string,
    reason: string
  ): Promise<SandboxRevocationOutcome> {
    const response = await this.sessions.fetch(sessionId, SessionInternalPaths.revokeSandbox, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedSandboxId, reason }),
    });
    if (response.status === 404) return "no_sandbox";
    if (!response.ok) {
      throw new Error(`revoke-sandbox failed for ${sessionId}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { outcome?: unknown };
    switch (body.outcome) {
      case "terminated":
      case "not_current":
      case "no_sandbox":
        return body.outcome;
      default:
        throw new Error(`revoke-sandbox returned an unknown outcome for ${sessionId}`);
    }
  }
}
