import { refreshXaiToken, XaiTokenRefreshError } from "../auth/xai";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";

const XAI_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const XAI_DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const XAI_CONCURRENT_ROTATION_DELAY_MS = 500;

type TokenSecretSource =
  | { kind: "environment"; environmentId: string }
  | { kind: "repo"; repoId: number; repoOwner: string; repoName: string }
  | { kind: "global" };

type XaiTokenState =
  | { type: "cached"; accessToken: string; expiresIn: number }
  | { type: "refresh"; refreshToken: string; source: TokenSecretSource };

export type XaiTokenRefreshResult =
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; status: number; error: string };

export class XaiTokenRefreshService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string,
    private readonly ensureRepoId: (session: SessionRow) => Promise<number>,
    private readonly log: Logger
  ) {}

  async refresh(session: SessionRow): Promise<XaiTokenRefreshResult> {
    const readState = () => this.readTokenState(session);
    let state: XaiTokenState | null;
    try {
      state = await readState();
    } catch (error) {
      this.log.error("Failed to read xAI token state from secrets", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, status: 500, error: "Failed to read token state" };
    }
    if (!state) return { ok: false, status: 404, error: "XAI_OAUTH_REFRESH_TOKEN not configured" };
    if (state.type === "cached") {
      return { ok: true, accessToken: state.accessToken, expiresIn: state.expiresIn };
    }

    try {
      return await this.attemptRefresh(state);
    } catch (error) {
      if (
        error instanceof XaiTokenRefreshError &&
        (error.reason === "invalid_grant" || error.reason === "unauthorized")
      ) {
        return this.handleUnauthorizedRefresh(state, readState);
      }
      this.log.error("xAI token refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, status: 502, error: "xAI token refresh failed" };
    }
  }

  private stateFromSecrets(
    secrets: Record<string, string>,
    source: TokenSecretSource
  ): XaiTokenState | null {
    const refreshToken = secrets.XAI_OAUTH_REFRESH_TOKEN;
    if (!refreshToken) return null;
    const accessToken = secrets.XAI_OAUTH_ACCESS_TOKEN;
    const expiresAt = Number.parseInt(secrets.XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT || "0", 10);
    const now = Date.now();
    if (accessToken && expiresAt - now > XAI_TOKEN_REFRESH_BUFFER_MS) {
      return { type: "cached", accessToken, expiresIn: Math.floor((expiresAt - now) / 1000) };
    }
    return { type: "refresh", refreshToken, source };
  }

  private async sessionSource(session: SessionRow): Promise<TokenSecretSource | null> {
    if (session.environment_id) {
      return { kind: "environment", environmentId: session.environment_id };
    }
    if (session.repo_owner && session.repo_name) {
      return {
        kind: "repo",
        repoId: await this.ensureRepoId(session),
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
      };
    }
    return null;
  }

  private async readSecrets(source: TokenSecretSource): Promise<Record<string, string>> {
    if (source.kind === "environment") {
      return new EnvironmentSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets(
        source.environmentId
      );
    }
    if (source.kind === "repo") {
      return new RepoSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets(source.repoId);
    }
    return new GlobalSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets();
  }

  private async writeSecrets(
    source: TokenSecretSource,
    secrets: Record<string, string>
  ): Promise<void> {
    if (source.kind === "environment") {
      await new EnvironmentSecretsStore(this.db, this.encryptionKey).setSecrets(
        source.environmentId,
        secrets
      );
      return;
    }
    if (source.kind === "repo") {
      await new RepoSecretsStore(this.db, this.encryptionKey).setSecrets(
        source.repoId,
        source.repoOwner,
        source.repoName,
        secrets
      );
      return;
    }
    await new GlobalSecretsStore(this.db, this.encryptionKey).setSecrets(secrets);
  }

  private async readTokenState(session: SessionRow): Promise<XaiTokenState | null> {
    const source = await this.sessionSource(session);
    if (source) {
      const state = this.stateFromSecrets(await this.readSecrets(source), source);
      if (state) return state;
    }
    const globalSource = { kind: "global" } as const;
    return this.stateFromSecrets(await this.readSecrets(globalSource), globalSource);
  }

  private async attemptRefresh(
    state: Extract<XaiTokenState, { type: "refresh" }>
  ): Promise<XaiTokenRefreshResult> {
    const tokens = await refreshXaiToken(state.refreshToken);
    const expiresIn = tokens.expires_in ?? XAI_DEFAULT_TOKEN_LIFETIME_MS / 1000;
    const secrets = {
      XAI_OAUTH_REFRESH_TOKEN: tokens.refresh_token || state.refreshToken,
      XAI_OAUTH_ACCESS_TOKEN: tokens.access_token,
      XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + expiresIn * 1000),
    };
    try {
      await this.writeSecrets(state.source, secrets);
      this.log.info("xAI tokens rotated and cached", { source: state.source.kind });
    } catch (error) {
      this.log.error("xAI token refreshed but failed to persist rotated tokens", {
        source: state.source.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ok: true, accessToken: tokens.access_token, expiresIn };
  }

  private async handleUnauthorizedRefresh(
    state: Extract<XaiTokenState, { type: "refresh" }>,
    readState: () => Promise<XaiTokenState | null>
  ): Promise<XaiTokenRefreshResult> {
    this.log.warn("xAI refresh was rejected, checking for concurrent rotation", {
      source: state.source.kind,
    });
    await new Promise((resolve) => setTimeout(resolve, XAI_CONCURRENT_ROTATION_DELAY_MS));
    try {
      const current = await readState();
      if (current?.type === "cached") {
        return { ok: true, accessToken: current.accessToken, expiresIn: current.expiresIn };
      }
      if (current?.type === "refresh" && current.refreshToken !== state.refreshToken) {
        return this.attemptRefresh(current);
      }
    } catch (error) {
      this.log.error("Retry after xAI 401 failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ok: false, status: 401, error: "xAI token refresh failed: unauthorized" };
  }
}
