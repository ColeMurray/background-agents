import {
  refreshOpenAIToken,
  extractOpenAIAccountId,
  OpenAITokenRefreshError,
} from "../auth/openai";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";

const OPENAI_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS = 3;
const OPENAI_TOKEN_PERSIST_RETRY_DELAY_MS = 100;
const OPENAI_CONCURRENT_ROTATION_DELAY_MS = 500;
const OPENAI_TOKEN_PERSIST_FAILURE =
  "OpenAI tokens rotated but could not be saved; reconnect OpenAI OAuth";

/**
 * Where a session's OpenAI OAuth tokens are read from and rotated back to. A
 * session reads from its own secret scope first — the environment for
 * environment-launched sessions, the repo for repo-launched ones (§6.4/§7.4) —
 * then falls back to global. Each variant carries everything needed to write
 * the rotated tokens back to the same place, so refresh never has to re-derive
 * the identity (and the old repoId-null guard disappears).
 */
type TokenSecretSource =
  | { kind: "environment"; environmentId: string }
  | { kind: "repo"; repoId: number; repoOwner: string; repoName: string }
  | { kind: "global" };

type OpenAITokenState =
  | { type: "cached"; accessToken: string; expiresIn: number; accountId?: string }
  | { type: "refresh"; refreshToken: string; source: TokenSecretSource; accountId?: string };

export type OpenAITokenRefreshResult =
  | { ok: true; accessToken: string; expiresIn?: number; accountId?: string }
  | { ok: false; status: number; error: string };

/** Source-aware broker shared by session-scoped and global OAuth consumers. */
export class OpenAITokenBroker {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string,
    private readonly log: Logger
  ) {}

  refreshGlobal(): Promise<OpenAITokenRefreshResult> {
    return this.refreshFrom(() => this.readTokenStateForSources([{ kind: "global" }]));
  }

  refreshSession(
    session: SessionRow,
    ensureRepoId: (session: SessionRow) => Promise<number>
  ): Promise<OpenAITokenRefreshResult> {
    return this.refreshFrom(async () => {
      const source = await this.resolveSessionSecretSource(session, ensureRepoId);
      const sources = source
        ? [source, { kind: "global" } as const]
        : [{ kind: "global" } as const];
      return this.readTokenStateForSources(sources);
    });
  }

  private async refreshFrom(
    readTokenState: () => Promise<OpenAITokenState | null>
  ): Promise<OpenAITokenRefreshResult> {
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
    source: TokenSecretSource
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
      accountId: secrets.OPENAI_OAUTH_ACCOUNT_ID,
    };
  }

  /**
   * The session's own secret source, or null for repo-less sessions with no
   * environment (global-only). Environment-launched sessions resolve to the
   * environment and never read member repo secrets (§6.4/§7.4).
   */
  private async resolveSessionSecretSource(
    session: SessionRow,
    ensureRepoId: (session: SessionRow) => Promise<number>
  ): Promise<TokenSecretSource | null> {
    if (session.environment_id) {
      return { kind: "environment", environmentId: session.environment_id };
    }
    if (session.repo_owner && session.repo_name) {
      const repoId = await ensureRepoId(session);
      return {
        kind: "repo",
        repoId,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
      };
    }
    return null;
  }

  private async readSecretsForSource(source: TokenSecretSource): Promise<Record<string, string>> {
    switch (source.kind) {
      case "environment":
        return new EnvironmentSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets(
          source.environmentId
        );
      case "repo":
        return new RepoSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets(source.repoId);
      case "global":
        return new GlobalSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets();
    }
  }

  private async writeSecretsForSource(
    source: TokenSecretSource,
    secrets: Record<string, string>
  ): Promise<void> {
    switch (source.kind) {
      case "environment":
        await new EnvironmentSecretsStore(this.db, this.encryptionKey).setSecrets(
          source.environmentId,
          secrets
        );
        return;
      case "repo":
        await new RepoSecretsStore(this.db, this.encryptionKey).setSecrets(
          source.repoId,
          source.repoOwner,
          source.repoName,
          secrets
        );
        return;
      case "global":
        await new GlobalSecretsStore(this.db, this.encryptionKey).setSecrets(secrets);
        return;
    }
  }

  private async readTokenStateForSources(
    sources: readonly TokenSecretSource[]
  ): Promise<OpenAITokenState | null> {
    for (const source of sources) {
      const secrets = await this.readSecretsForSource(source);
      const state = this.getTokenStateFromSecrets(secrets, source);
      if (state) {
        return state;
      }
    }
    return null;
  }

  private async attemptRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>
  ): Promise<OpenAITokenRefreshResult> {
    const tokens = await refreshOpenAIToken(tokenState.refreshToken);
    const accountId = extractOpenAIAccountId(tokens) ?? tokenState.accountId;
    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

    const secretsToWrite: Record<string, string> = {
      OPENAI_OAUTH_REFRESH_TOKEN: tokens.refresh_token,
      OPENAI_OAUTH_ACCESS_TOKEN: tokens.access_token,
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(expiresAt),
    };

    if (accountId) {
      secretsToWrite.OPENAI_OAUTH_ACCOUNT_ID = accountId;
    }

    const persisted = await this.persistRotatedTokens(tokenState.source, secretsToWrite);
    if (!persisted) {
      return { ok: false, status: 500, error: OPENAI_TOKEN_PERSIST_FAILURE };
    }

    this.log.info("OpenAI tokens rotated and cached", {
      source: tokenState.source.kind,
      has_account_id: !!accountId,
    });

    return {
      ok: true,
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in,
      accountId,
    };
  }

  private async persistRotatedTokens(
    source: TokenSecretSource,
    secrets: Record<string, string>
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS; attempt++) {
      try {
        await this.writeSecretsForSource(source, secrets);
        return true;
      } catch (e) {
        const finalAttempt = attempt === OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS;
        const context = {
          source: source.kind,
          attempt,
          max_attempts: OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS,
          error: e instanceof Error ? e.message : String(e),
        };

        if (finalAttempt) {
          this.log.error("Failed to store rotated OpenAI tokens", context);
          return false;
        }

        this.log.warn("Failed to store rotated OpenAI tokens; retrying", context);
        await new Promise((resolve) => setTimeout(resolve, OPENAI_TOKEN_PERSIST_RETRY_DELAY_MS));
      }
    }

    return false;
  }

  private async handleUnauthorizedRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>,
    readTokenState: () => Promise<OpenAITokenState | null>
  ): Promise<OpenAITokenRefreshResult> {
    this.log.warn("OpenAI refresh got 401, checking for concurrent rotation", {
      source: tokenState.source.kind,
    });

    await new Promise((resolve) => setTimeout(resolve, OPENAI_CONCURRENT_ROTATION_DELAY_MS));

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

/** Backwards-compatible session facade used by the Durable Object. */
export class OpenAITokenRefreshService {
  private readonly broker: OpenAITokenBroker;

  constructor(
    db: SqlDatabase,
    encryptionKey: string,
    private readonly ensureRepoId: (session: SessionRow) => Promise<number>,
    log: Logger
  ) {
    this.broker = new OpenAITokenBroker(db, encryptionKey, log);
  }

  refresh(session: SessionRow): Promise<OpenAITokenRefreshResult> {
    return this.broker.refreshSession(session, this.ensureRepoId);
  }
}
