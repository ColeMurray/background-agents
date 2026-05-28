import type { SourceControlProvider } from "../source-control";
import { SourceControlProviderError } from "../source-control/errors";
import type { Logger } from "../logger";

export type ScmCredentialsResult =
  | {
      ok: true;
      username: string;
      password: string;
      expiresAtEpochMs: number;
    }
  | { ok: false; status: number; error: string };

/**
 * Service that mints short-lived SCM credentials for the sandbox-side git
 * credential helper.
 *
 * Sits in front of {@link SourceControlProvider.generateCredentialHelperAuth}
 * and adapts upstream errors into a discriminated union that the HTTP handler
 * can map directly to a response. Never logs the returned password.
 */
export class ScmCredentialsService {
  constructor(
    private readonly provider: SourceControlProvider,
    private readonly log: Logger
  ) {}

  async getCredentials(): Promise<ScmCredentialsResult> {
    try {
      const auth = await this.provider.generateCredentialHelperAuth();
      if (
        !auth.username.trim() ||
        !auth.password.trim() ||
        !Number.isFinite(auth.expiresAtEpochMs) ||
        auth.expiresAtEpochMs <= Date.now()
      ) {
        this.log.error("Provider returned invalid SCM credential helper auth", {
          scm_provider: this.provider.name,
        });
        return {
          ok: false,
          status: 500,
          error: "Failed to generate SCM credentials",
        };
      }

      return {
        ok: true,
        username: auth.username,
        password: auth.password,
        expiresAtEpochMs: auth.expiresAtEpochMs,
      };
    } catch (e) {
      if (e instanceof SourceControlProviderError) {
        // Permanent → 500 (config error, retrying won't help).
        // Transient → 502 (upstream/network blip, the helper exits 1 and
        // the next git op will retry).
        const status = e.errorType === "permanent" ? 500 : 502;
        this.log.warn("SCM credential helper auth failed", {
          scm_provider: this.provider.name,
          error_type: e.errorType,
          error: e.message,
        });
        return { ok: false, status, error: e.message };
      }

      this.log.error("Unexpected error generating SCM credentials", {
        scm_provider: this.provider.name,
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        ok: false,
        status: 500,
        error: "Failed to generate SCM credentials",
      };
    }
  }
}
