import {
  extractOpenAIAccountId,
  isOpenAIRefreshTokenRejected,
  OpenAITokenRefreshError,
  refreshOpenAIToken,
} from "./openai";
import { ScopedOAuthSecretsStore, type OAuthSecretScope } from "../db/scoped-oauth-secrets";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import { OAuthRefreshSingleFlight } from "./oauth-refresh-single-flight";

const OPENAI_REFRESH_TOKEN_KEY = "OPENAI_OAUTH_REFRESH_TOKEN";
const OPENAI_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const OPENAI_DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS = 3;
const OPENAI_TOKEN_PERSIST_RETRY_DELAY_MS = 100;
const OPENAI_CONCURRENT_ROTATION_POLL_DELAYS_MS = [100, 250, 500, 1_000] as const;
const OPENAI_TOKEN_PERSIST_FAILURE =
  "OpenAI tokens rotated but could not be saved; reconnect OpenAI OAuth";

type OpenAITokenState =
  | { type: "cached"; accessToken: string; expiresIn: number; accountId?: string }
  | {
      type: "refresh";
      refreshToken: string;
      /** Ciphertext the refresh token was read at — the CAS comparand when persisting its rotation. */
      refreshTokenCiphertext: string;
      scope: OAuthSecretScope;
      accountId?: string;
    };

export type OpenAIToken = { accessToken: string; expiresIn?: number; accountId?: string };

export class OpenAITokenBrokerError extends Error {}
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
      if (error instanceof OpenAITokenRefreshError && isOpenAIRefreshTokenRejected(error)) {
        return this.handleRejectedRefresh(tokenState, scopes, error.status);
      }

      this.log.error("OpenAI token refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new OpenAITokenUpstreamError("OpenAI token refresh failed", { cause: error });
    }
  }

  private cachedStateFromSecrets(
    secrets: Record<string, string>
  ): Extract<OpenAITokenState, { type: "cached" }> | null {
    const cachedToken = secrets.OPENAI_OAUTH_ACCESS_TOKEN;
    const expiresAt = Number.parseInt(secrets.OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT || "0", 10);
    const now = Date.now();
    if (!cachedToken || expiresAt - now <= OPENAI_TOKEN_REFRESH_BUFFER_MS) return null;

    return {
      type: "cached",
      accessToken: cachedToken,
      expiresIn: Math.floor((expiresAt - now) / 1000),
      accountId: secrets.OPENAI_OAUTH_ACCOUNT_ID,
    };
  }

  private async readTokenState(
    scopes: readonly OAuthSecretScope[]
  ): Promise<OpenAITokenState | null> {
    for (const scope of scopes) {
      const secrets = await this.secrets.read(scope);
      if (!secrets[OPENAI_REFRESH_TOKEN_KEY]) continue;

      const cached = this.cachedStateFromSecrets(secrets);
      if (cached) return cached;

      // Reread the refresh token together with its ciphertext so the value sent
      // upstream and the CAS comparand come from the same stored row.
      const stored = await this.secrets.readSecretWithCiphertext(scope, OPENAI_REFRESH_TOKEN_KEY);
      if (!stored) continue;

      return {
        type: "refresh",
        refreshToken: stored.value,
        refreshTokenCiphertext: stored.ciphertext,
        scope,
        accountId: secrets.OPENAI_OAUTH_ACCOUNT_ID,
      };
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
      [OPENAI_REFRESH_TOKEN_KEY]: tokens.refresh_token,
      OPENAI_OAUTH_ACCESS_TOKEN: tokens.access_token,
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(expiresAt),
    };
    if (accountId) secretsToWrite.OPENAI_OAUTH_ACCOUNT_ID = accountId;

    const persisted = await this.persistRotatedTokens(tokenState, secretsToWrite);
    if (persisted) {
      this.log.info("OpenAI tokens rotated and cached", {
        scope: tokenState.scope.kind,
        has_account_id: !!accountId,
      });
    } else {
      // The guard did not match: either a concurrent rotation persisted first
      // (its refresh token stays authoritative) or the credential was removed
      // mid-rotation (deletion is respected). The token minted here is still
      // valid to hand out once. A reread failure must not fail the successful
      // refresh, so it falls back to the benign concurrent-rotation reading.
      const guardStillPresent = await this.secrets
        .readSecretWithCiphertext(tokenState.scope, OPENAI_REFRESH_TOKEN_KEY)
        .then((stored) => stored !== null)
        .catch(() => true);
      if (guardStillPresent) {
        this.log.info("OpenAI token rotation lost the persistence race; using unsaved token", {
          scope: tokenState.scope.kind,
        });
      } else {
        this.log.warn("OpenAI refresh token removed during rotation; using unsaved token", {
          scope: tokenState.scope.kind,
        });
      }
    }
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

  /** Returns false when the guarded write lost to a concurrent rotation. */
  private async persistRotatedTokens(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>,
    secrets: Record<string, string>
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.secrets.casWrite(
          tokenState.scope,
          { key: OPENAI_REFRESH_TOKEN_KEY, expectedCiphertext: tokenState.refreshTokenCiphertext },
          secrets
        );
      } catch (error) {
        const finalAttempt = attempt === OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS;
        const context = {
          scope: tokenState.scope.kind,
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
    throw new OpenAITokenStorageError(OPENAI_TOKEN_PERSIST_FAILURE);
  }

  private async handleRejectedRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>,
    scopes: readonly OAuthSecretScope[],
    rejectionStatus: number
  ): Promise<OpenAIToken> {
    this.log.warn("OpenAI refresh token rejected upstream, checking for concurrent rotation", {
      scope: tokenState.scope.kind,
      status: rejectionStatus,
    });
    let observedRefreshToken = tokenState.refreshToken;

    for (const [pollIndex, delayMs] of OPENAI_CONCURRENT_ROTATION_POLL_DELAYS_MS.entries()) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      let reread: OpenAITokenState | null;
      try {
        reread = await this.readTokenState(scopes);
      } catch (error) {
        this.log.error("Failed to reread OpenAI token state after rejected refresh", {
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
          if (error instanceof OpenAITokenRefreshError && isOpenAIRefreshTokenRejected(error)) {
            continue;
          }
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
