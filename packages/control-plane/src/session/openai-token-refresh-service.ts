import {
  refreshOpenAIToken,
  extractOpenAIAccountId,
  OpenAITokenRefreshError,
} from "../auth/openai";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";

const OPENAI_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Where a session's OpenAI token secrets live: its launch unit (the repo today,
 * an environment in PR-9) or the global store used as fallback. This is the one
 * launch-unit secrets-source seam in this service (design §6.4, §16.2 choke
 * point) — the read/write paths route through it rather than picking a store
 * inline. PR-9 adds `{ kind: "environment"; environmentId: number }`.
 */
type OpenAITokenSource =
  | { kind: "repo"; repoId: number; repoOwner: string; repoName: string }
  | { kind: "global" };

type OpenAITokenState =
  | { type: "cached"; accessToken: string; expiresIn: number; accountId?: string }
  | { type: "refresh"; refreshToken: string; source: OpenAITokenSource };

export type OpenAITokenRefreshResult =
  | { ok: true; accessToken: string; expiresIn?: number; accountId?: string }
  | { ok: false; status: number; error: string };

export class OpenAITokenRefreshService {
  constructor(
    private readonly db: Env["DB"],
    private readonly encryptionKey: string,
    private readonly ensureRepoId: (session: SessionRow) => Promise<number>,
    private readonly log: Logger
  ) {}

  async refresh(session: SessionRow): Promise<OpenAITokenRefreshResult> {
    const readTokenState = () => this.readTokenState(session);

    let tokenState: OpenAITokenState | null;
    try {
      tokenState = await readTokenState();
    } catch (e) {
      this.log.error("Failed to read OpenAI token state from secrets", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 500, error: "Failed to read token state" };
    }

    if (!tokenState) {
      return { ok: false, status: 404, error: "OPENAI_OAUTH_REFRESH_TOKEN not configured" };
    }

    if (tokenState.type === "cached") {
      return {
        ok: true,
        accessToken: tokenState.accessToken,
        expiresIn: tokenState.expiresIn,
        accountId: tokenState.accountId,
      };
    }

    try {
      return await this.attemptRefresh(tokenState);
    } catch (e) {
      if (e instanceof OpenAITokenRefreshError && e.status === 401) {
        return this.handleUnauthorizedRefresh(tokenState, readTokenState);
      }

      this.log.error("OpenAI token refresh failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 502, error: "OpenAI token refresh failed" };
    }
  }

  private getTokenStateFromSecrets(
    secrets: Record<string, string>,
    source: OpenAITokenSource
  ): OpenAITokenState | null {
    if (!secrets.OPENAI_OAUTH_REFRESH_TOKEN) {
      return null;
    }

    const cachedToken = secrets.OPENAI_OAUTH_ACCESS_TOKEN;
    const expiresAt = parseInt(secrets.OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT || "0", 10);
    const now = Date.now();

    if (cachedToken && expiresAt - now > OPENAI_TOKEN_REFRESH_BUFFER_MS) {
      return {
        type: "cached",
        accessToken: cachedToken,
        expiresIn: Math.floor((expiresAt - now) / 1000),
        accountId: secrets.OPENAI_OAUTH_ACCOUNT_ID,
      };
    }

    return {
      type: "refresh",
      refreshToken: secrets.OPENAI_OAUTH_REFRESH_TOKEN,
      source,
    };
  }

  /**
   * Resolve the session's launch-unit secrets source, or null when the session
   * has no launch-unit repo (leaving global as the only source). PR-9 seam:
   * environment-launched sessions resolve to an environment source once
   * sessions.environment_id and the environment secrets store exist; until then
   * every session is repo-launched.
   */
  private async resolveLaunchUnitSource(session: SessionRow): Promise<OpenAITokenSource | null> {
    if (session.repo_owner && session.repo_name) {
      const repoId = await this.ensureRepoId(session);
      return { kind: "repo", repoId, repoOwner: session.repo_owner, repoName: session.repo_name };
    }
    return null;
  }

  private async readSecretsForSource(source: OpenAITokenSource): Promise<Record<string, string>> {
    switch (source.kind) {
      case "repo": {
        const repoStore = new RepoSecretsStore(this.db, this.encryptionKey);
        return repoStore.getDecryptedSecrets(source.repoId);
      }
      case "global": {
        const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
        return globalStore.getDecryptedSecrets();
      }
    }
  }

  private async writeSecretsForSource(
    source: OpenAITokenSource,
    secrets: Record<string, string>
  ): Promise<void> {
    switch (source.kind) {
      case "repo": {
        const repoStore = new RepoSecretsStore(this.db, this.encryptionKey);
        await repoStore.setSecrets(source.repoId, source.repoOwner, source.repoName, secrets);
        break;
      }
      case "global": {
        const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
        await globalStore.setSecrets(secrets);
        break;
      }
    }
  }

  private async readTokenState(session: SessionRow): Promise<OpenAITokenState | null> {
    const launchUnit = await this.resolveLaunchUnitSource(session);
    if (launchUnit) {
      const secrets = await this.readSecretsForSource(launchUnit);
      const state = this.getTokenStateFromSecrets(secrets, launchUnit);
      if (state) {
        return state;
      }
    }

    const globalSource: OpenAITokenSource = { kind: "global" };
    const globalSecrets = await this.readSecretsForSource(globalSource);
    return this.getTokenStateFromSecrets(globalSecrets, globalSource);
  }

  private async attemptRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>
  ): Promise<OpenAITokenRefreshResult> {
    const tokens = await refreshOpenAIToken(tokenState.refreshToken);
    const accountId = extractOpenAIAccountId(tokens);
    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

    try {
      const secretsToWrite: Record<string, string> = {
        OPENAI_OAUTH_REFRESH_TOKEN: tokens.refresh_token,
        OPENAI_OAUTH_ACCESS_TOKEN: tokens.access_token,
        OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(expiresAt),
      };

      if (accountId) {
        secretsToWrite.OPENAI_OAUTH_ACCOUNT_ID = accountId;
      }

      await this.writeSecretsForSource(tokenState.source, secretsToWrite);

      this.log.info("OpenAI tokens rotated and cached", {
        source: tokenState.source.kind,
        has_account_id: !!accountId,
      });
    } catch (e) {
      this.log.error("Failed to store rotated OpenAI tokens", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return {
      ok: true,
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in,
      accountId,
    };
  }

  private async handleUnauthorizedRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>,
    readTokenState: () => Promise<OpenAITokenState | null>
  ): Promise<OpenAITokenRefreshResult> {
    this.log.warn("OpenAI refresh got 401, checking for concurrent rotation", {
      source: tokenState.source.kind,
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      const reread = await readTokenState();

      if (reread?.type === "cached") {
        this.log.info("Using cached access token from concurrent rotation");
        return {
          ok: true,
          accessToken: reread.accessToken,
          expiresIn: reread.expiresIn,
          accountId: reread.accountId,
        };
      }

      if (reread?.type === "refresh" && reread.refreshToken !== tokenState.refreshToken) {
        this.log.info("Detected concurrent token rotation, retrying");
        return this.attemptRefresh(reread);
      }
    } catch (retryErr) {
      this.log.error("Retry after 401 also failed", {
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
    }

    return { ok: false, status: 401, error: "OpenAI token refresh failed: unauthorized" };
  }
}
