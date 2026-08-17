import { extractOpenAIAccountId, OpenAITokenRefreshError, refreshOpenAIToken } from "./openai";
import { ScopedOAuthSecretsStore, type OAuthSecretScope } from "../db/scoped-oauth-secrets";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import { OAuthRefreshSingleFlight } from "./oauth-refresh-single-flight";

const OPENAI_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const OPENAI_DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS = 3;
const OPENAI_TOKEN_PERSIST_RETRY_DELAY_MS = 100;
const OPENAI_CONCURRENT_ROTATION_POLL_DELAYS_MS = [100, 250, 500, 1_000] as const;
const OPENAI_TOKEN_PERSIST_FAILURE =
  "OpenAI tokens rotated but could not be saved; reconnect OpenAI OAuth";

type OpenAITokenState =
  | { type: "cached"; accessToken: string; expiresIn: number; accountId?: string }
  | { type: "refresh"; refreshToken: string; scope: OAuthSecretScope; accountId?: string };

export type OpenAIToken = { accessToken: string; expiresIn?: number; accountId?: string };

class OpenAITokenBrokerError extends Error {}
export class OpenAITokenNotConfiguredError extends OpenAITokenBrokerError {}
export class OpenAITokenStorageError extends OpenAITokenBrokerError {}
export class OpenAITokenUnauthorizedError extends OpenAITokenBrokerError {}
export class OpenAITokenUpstreamError extends OpenAITokenBrokerError {}

// Requests handled by the same Worker isolate share this coordinator. D1 rereads
// below cover concurrent rotations performed by other isolates and Durable Objects.
const openAIRefreshCoordinator = new OAuthRefreshSingleFlight<OpenAIToken>();

/** Provider-level broker shared by session adapters and global OAuth consumers. */
export class OpenAITokenBroker {
  private readonly secrets: ScopedOAuthSecretsStore;

  constructor(
    db: SqlDatabase,
    encryptionKey: string,
    private readonly log: Logger
  ) {
    this.secrets = new ScopedOAuthSecretsStore(db, encryptionKey);
  }

  refreshGlobal(): Promise<OpenAIToken> {
    return this.refreshScopes([{ kind: "global" }]);
  }

  async refreshScopes(scopes: readonly OAuthSecretScope[]): Promise<OpenAIToken> {
    let tokenState: OpenAITokenState | null;
    try {
      tokenState = await this.readTokenState(scopes);
    } catch (error) {
      this.log.error("Failed to read OpenAI token state from secrets", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new OpenAITokenStorageError("Failed to read token state", { cause: error });
    }

    if (!tokenState) {
      throw new OpenAITokenNotConfiguredError("OPENAI_OAUTH_REFRESH_TOKEN not configured");
    }

    if (tokenState.type === "cached") {
      return {
        accessToken: tokenState.accessToken,
        expiresIn: tokenState.expiresIn,
        accountId: tokenState.accountId,
      };
    }

    try {
      return await this.refreshSingleFlight(tokenState);
    } catch (error) {
      if (error instanceof OpenAITokenBrokerError) throw error;
      if (error instanceof OpenAITokenRefreshError && error.status === 401) {
        return this.handleUnauthorizedRefresh(tokenState, scopes);
      }

      this.log.error("OpenAI token refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new OpenAITokenUpstreamError("OpenAI token refresh failed", { cause: error });
    }
  }

  private stateFromSecrets(
    secrets: Record<string, string>,
    scope: OAuthSecretScope
  ): OpenAITokenState | null {
    const refreshToken = secrets.OPENAI_OAUTH_REFRESH_TOKEN;
    if (!refreshToken) return null;

    const cachedToken = secrets.OPENAI_OAUTH_ACCESS_TOKEN;
    const expiresAt = Number.parseInt(secrets.OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT || "0", 10);
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
      refreshToken,
      scope,
      accountId: secrets.OPENAI_OAUTH_ACCOUNT_ID,
    };
  }

  private async readTokenState(
    scopes: readonly OAuthSecretScope[]
  ): Promise<OpenAITokenState | null> {
    for (const scope of scopes) {
      const state = this.stateFromSecrets(await this.secrets.read(scope), scope);
      if (state) return state;
    }
    return null;
  }

  private async attemptRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>
  ): Promise<OpenAIToken> {
    const tokens = await refreshOpenAIToken(tokenState.refreshToken);
    const accountId = extractOpenAIAccountId(tokens) ?? tokenState.accountId;
    const expiresAt =
      Date.now() +
      (tokens.expires_in === undefined
        ? OPENAI_DEFAULT_TOKEN_LIFETIME_MS
        : tokens.expires_in * 1000);
    const secretsToWrite: Record<string, string> = {
      OPENAI_OAUTH_REFRESH_TOKEN: tokens.refresh_token,
      OPENAI_OAUTH_ACCESS_TOKEN: tokens.access_token,
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(expiresAt),
    };
    if (accountId) secretsToWrite.OPENAI_OAUTH_ACCOUNT_ID = accountId;

    await this.persistRotatedTokens(tokenState.scope, secretsToWrite);

    this.log.info("OpenAI tokens rotated and cached", {
      scope: tokenState.scope.kind,
      has_account_id: !!accountId,
    });
    return {
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in,
      accountId,
    };
  }

  private refreshSingleFlight(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>
  ): Promise<OpenAIToken> {
    return openAIRefreshCoordinator.run(tokenState.scope, tokenState.refreshToken, () =>
      this.attemptRefresh(tokenState)
    );
  }

  private async persistRotatedTokens(
    scope: OAuthSecretScope,
    secrets: Record<string, string>
  ): Promise<void> {
    for (let attempt = 1; attempt <= OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS; attempt++) {
      try {
        await this.secrets.write(scope, secrets);
        return;
      } catch (error) {
        const finalAttempt = attempt === OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS;
        const context = {
          scope: scope.kind,
          attempt,
          max_attempts: OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS,
          error: error instanceof Error ? error.message : String(error),
        };
        if (finalAttempt) {
          this.log.error("Failed to store rotated OpenAI tokens", context);
          throw new OpenAITokenStorageError(OPENAI_TOKEN_PERSIST_FAILURE, { cause: error });
        }
        this.log.warn("Failed to store rotated OpenAI tokens; retrying", context);
        await new Promise((resolve) => setTimeout(resolve, OPENAI_TOKEN_PERSIST_RETRY_DELAY_MS));
      }
    }
  }

  private async handleUnauthorizedRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>,
    scopes: readonly OAuthSecretScope[]
  ): Promise<OpenAIToken> {
    this.log.warn("OpenAI refresh got 401, checking for concurrent rotation", {
      scope: tokenState.scope.kind,
    });
    let observedRefreshToken = tokenState.refreshToken;

    for (const [pollIndex, delayMs] of OPENAI_CONCURRENT_ROTATION_POLL_DELAYS_MS.entries()) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      let reread: OpenAITokenState | null;
      try {
        reread = await this.readTokenState(scopes);
      } catch (error) {
        this.log.error("Failed to reread OpenAI token state after 401", {
          poll_attempt: pollIndex + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        if (pollIndex === OPENAI_CONCURRENT_ROTATION_POLL_DELAYS_MS.length - 1) {
          throw new OpenAITokenStorageError("Failed to read token state", { cause: error });
        }
        continue;
      }
      if (reread?.type === "cached") {
        this.log.info("Using cached access token from concurrent rotation");
        return {
          accessToken: reread.accessToken,
          expiresIn: reread.expiresIn,
          accountId: reread.accountId,
        };
      }
      if (reread?.type === "refresh" && reread.refreshToken !== observedRefreshToken) {
        observedRefreshToken = reread.refreshToken;
        this.log.info("Detected concurrent token rotation, retrying");
        try {
          return await this.refreshSingleFlight(reread);
        } catch (error) {
          if (error instanceof OpenAITokenBrokerError) throw error;
          if (error instanceof OpenAITokenRefreshError && error.status === 401) continue;
          this.log.error("OpenAI token refresh retry failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          throw new OpenAITokenUpstreamError("OpenAI token refresh failed", { cause: error });
        }
      }
    }
    throw new OpenAITokenUnauthorizedError("OpenAI token refresh failed: unauthorized");
  }
}
