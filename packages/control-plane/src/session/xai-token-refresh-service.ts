import { refreshXaiToken, XaiTokenRefreshError } from "../auth/xai";
import { ScopedOAuthSecretsStore, type OAuthSecretScope } from "../auth/scoped-oauth-secrets";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import { resolveSessionOAuthSecretScope } from "./oauth-secret-scope";
import type { SessionRow } from "./types";

const XAI_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const XAI_DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const XAI_CONCURRENT_ROTATION_DELAY_MS = 500;

type XaiTokenState =
  | { type: "cached"; accessToken: string; expiresIn: number }
  | { type: "refresh"; refreshToken: string; scope: OAuthSecretScope };

export type XaiTokenRefreshResult =
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; status: number; error: string };

export class XaiTokenRefreshService {
  private readonly secrets: ScopedOAuthSecretsStore;

  constructor(
    db: SqlDatabase,
    encryptionKey: string,
    private readonly ensureRepoId: (session: SessionRow) => Promise<number>,
    private readonly log: Logger
  ) {
    this.secrets = new ScopedOAuthSecretsStore(db, encryptionKey);
  }

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
    scope: OAuthSecretScope
  ): XaiTokenState | null {
    const refreshToken = secrets.XAI_OAUTH_REFRESH_TOKEN;
    if (!refreshToken) return null;
    const accessToken = secrets.XAI_OAUTH_ACCESS_TOKEN;
    const expiresAt = Number.parseInt(secrets.XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT || "0", 10);
    const now = Date.now();
    if (accessToken && expiresAt - now > XAI_TOKEN_REFRESH_BUFFER_MS) {
      return { type: "cached", accessToken, expiresIn: Math.floor((expiresAt - now) / 1000) };
    }
    return { type: "refresh", refreshToken, scope };
  }

  private async readTokenState(session: SessionRow): Promise<XaiTokenState | null> {
    const scope = await resolveSessionOAuthSecretScope(session, this.ensureRepoId);
    if (scope) {
      const state = this.stateFromSecrets(await this.secrets.read(scope), scope);
      if (state) return state;
    }
    const globalSource = { kind: "global" } as const;
    return this.stateFromSecrets(await this.secrets.read(globalSource), globalSource);
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
      await this.secrets.write(state.scope, secrets);
      this.log.info("xAI tokens rotated and cached", { scope: state.scope.kind });
    } catch (error) {
      this.log.error("xAI token refreshed but failed to persist rotated tokens", {
        scope: state.scope.kind,
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
      scope: state.scope.kind,
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
