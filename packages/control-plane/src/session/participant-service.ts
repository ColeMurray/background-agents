/**
 * ParticipantService - Participant CRUD and SCM OAuth token management.
 *
 * Extracted from SessionDO to reduce its size. Handles:
 * - Creating and looking up participants
 * - SCM OAuth token refresh (GitHub, Bitbucket, etc.)
 * - Resolving auth context for PR creation
 */

import { decryptToken, encryptToken } from "../auth/crypto";
import { refreshAccessToken } from "../auth/github";
import type { SourceControlAuthContext, SourceControlProviderName } from "../source-control";
import type { Logger } from "../logger";
import type { ParticipantRow } from "./types";
import type { CreateParticipantData } from "./repository";
import { DEFAULT_TOKEN_LIFETIME_MS, type UserScmTokenStore } from "../db/user-scm-tokens";

/**
 * Narrow repository interface — only the methods ParticipantService needs.
 */
export interface ParticipantRepository {
  getParticipantByUserId(userId: string): ParticipantRow | null;
  getParticipantByWsTokenHash(tokenHash: string): ParticipantRow | null;
  getParticipantById(participantId: string): ParticipantRow | null;
  getProcessingMessageAuthor(): { author_id: string } | null;
  createParticipant(data: CreateParticipantData): void;
  updateParticipantTokens(
    participantId: string,
    data: {
      scmAccessTokenEncrypted: string;
      scmRefreshTokenEncrypted?: string | null;
      scmTokenExpiresAt: number;
    }
  ): void;
}

/**
 * Environment config — only the secrets ParticipantService needs.
 */
export interface ParticipantServiceEnv {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY: string;
}

/**
 * Dependencies injected into ParticipantService.
 */
export interface ParticipantServiceDeps {
  repository: ParticipantRepository;
  env: ParticipantServiceEnv;
  log: Logger;
  generateId: () => string;
  userScmTokenStore?: UserScmTokenStore | null;
}

/**
 * Build avatar URL from SCM login.
 */
export function getAvatarUrl(
  login: string | null | undefined,
  provider: SourceControlProviderName = "github"
): string | undefined {
  if (!login) return undefined;
  if (provider === "github") return `https://github.com/${login}.png`;
  return undefined;
}

export class ParticipantService {
  private readonly repository: ParticipantRepository;
  private readonly env: ParticipantServiceEnv;
  private readonly log: Logger;
  private readonly generateId: () => string;
  private readonly userScmTokenStore: UserScmTokenStore | null;

  constructor(deps: ParticipantServiceDeps) {
    this.repository = deps.repository;
    this.env = deps.env;
    this.log = deps.log;
    this.generateId = deps.generateId;
    this.userScmTokenStore = deps.userScmTokenStore ?? null;
  }

  /**
   * Look up a participant by user ID.
   */
  getByUserId(userId: string): ParticipantRow | null {
    return this.repository.getParticipantByUserId(userId);
  }

  /**
   * Look up a participant by WebSocket token hash.
   */
  getByWsTokenHash(tokenHash: string): ParticipantRow | null {
    return this.repository.getParticipantByWsTokenHash(tokenHash);
  }

  /**
   * Create a new participant with "member" role.
   * Returns the constructed ParticipantRow without a DB round-trip.
   */
  create(userId: string, name: string): ParticipantRow {
    const id = this.generateId();
    const now = Date.now();

    this.repository.createParticipant({
      id,
      userId,
      scmName: name,
      role: "member",
      joinedAt: now,
    });

    return {
      id,
      user_id: userId,
      scm_user_id: null,
      scm_login: null,
      scm_email: null,
      scm_name: name,
      role: "member",
      scm_access_token_encrypted: null,
      scm_refresh_token_encrypted: null,
      scm_token_expires_at: null,
      ws_auth_token: null,
      ws_token_created_at: null,
      joined_at: now,
    };
  }

  /**
   * Find the participant who authored the currently-processing message.
   * Used for PR creation to determine whose OAuth token to use.
   */
  async getPromptingParticipantForPR(): Promise<
    | { participant: ParticipantRow; error?: never; status?: never }
    | { participant?: never; error: string; status: number }
  > {
    const processingMessage = this.repository.getProcessingMessageAuthor();

    if (!processingMessage) {
      this.log.warn("PR creation failed: no processing message found");
      return {
        error: "No active prompt found. PR creation must be triggered by a user prompt.",
        status: 400,
      };
    }

    const participant = this.repository.getParticipantById(processingMessage.author_id);

    if (!participant) {
      this.log.warn("PR creation failed: participant not found", {
        participantId: processingMessage.author_id,
      });
      return { error: "User not found. Please re-authenticate.", status: 401 };
    }

    return { participant };
  }

  /**
   * Check whether a participant's SCM token is expired (with buffer).
   */
  isScmTokenExpired(participant: ParticipantRow, bufferMs = 60000): boolean {
    if (!participant.scm_token_expires_at) {
      return false;
    }
    return Date.now() + bufferMs >= participant.scm_token_expires_at;
  }

  /**
   * Refresh a participant's SCM OAuth token.
   * Dispatches to centralized (D1) or local (per-DO SQLite) refresh path.
   */
  async refreshToken(participant: ParticipantRow): Promise<ParticipantRow | null> {
    if (this.userScmTokenStore && participant.scm_user_id) {
      return this.refreshTokenCentralized(participant);
    }
    return this.refreshTokenLocal(participant);
  }

  /**
   * Centralized refresh via D1.
   *
   * 1. Read D1 for the user's tokens
   * 2. If D1 has a fresh access token, use it (skip OAuth API call)
   * 3. If D1 token is expired, refresh via OAuth API and CAS-write to D1
   * 4. On CAS conflict, re-read D1 and use the winner's tokens
   * 5. Always update local SQLite cache with final tokens
   */
  private async refreshTokenCentralized(
    participant: ParticipantRow
  ): Promise<ParticipantRow | null> {
    const store = this.userScmTokenStore!;
    const scmUserId = participant.scm_user_id!;

    try {
      const d1Tokens = await store.getTokens(scmUserId);

      if (!d1Tokens) {
        this.log.info("No D1 token record, falling back to local refresh", {
          user_id: participant.user_id,
        });
        const result = await this.refreshTokenLocal(participant);
        if (result) {
          await this.seedD1AfterLocalRefresh(result);
        }
        return result;
      }

      if (store.isTokenFresh(d1Tokens.expiresAt)) {
        this.log.info("Using fresh D1 access token", { user_id: participant.user_id });
        await this.updateLocalTokensFromD1(participant.id, d1Tokens);
        return this.repository.getParticipantById(participant.id);
      }

      // D1 token expired — refresh via OAuth API
      if (!this.env.GITHUB_CLIENT_ID || !this.env.GITHUB_CLIENT_SECRET) {
        this.log.warn("Cannot refresh: OAuth credentials not configured");
        return null;
      }

      const newTokens = await refreshAccessToken(d1Tokens.refreshToken, {
        clientId: this.env.GITHUB_CLIENT_ID,
        clientSecret: this.env.GITHUB_CLIENT_SECRET,
        encryptionKey: this.env.TOKEN_ENCRYPTION_KEY,
      });

      const newAccessToken = newTokens.access_token;
      const newRefreshToken = newTokens.refresh_token ?? d1Tokens.refreshToken;
      const newExpiresAt = newTokens.expires_in
        ? Date.now() + newTokens.expires_in * 1000
        : Date.now() + DEFAULT_TOKEN_LIFETIME_MS;

      const casResult = await store.casUpdateTokens(
        scmUserId,
        d1Tokens.refreshTokenEncrypted,
        newAccessToken,
        newRefreshToken,
        newExpiresAt
      );

      if (casResult.ok) {
        this.log.info("CAS update succeeded", { user_id: participant.user_id });
        const newAccessTokenEncrypted = await encryptToken(
          newAccessToken,
          this.env.TOKEN_ENCRYPTION_KEY
        );
        const newRefreshTokenEncrypted = await encryptToken(
          newRefreshToken,
          this.env.TOKEN_ENCRYPTION_KEY
        );
        this.repository.updateParticipantTokens(participant.id, {
          scmAccessTokenEncrypted: newAccessTokenEncrypted,
          scmRefreshTokenEncrypted: newRefreshTokenEncrypted,
          scmTokenExpiresAt: newExpiresAt,
        });
        return this.repository.getParticipantById(participant.id);
      }

      // CAS conflict — another DO won the race. Re-read D1 for the winner's tokens.
      this.log.info("CAS conflict, re-reading D1 for winner's tokens", {
        user_id: participant.user_id,
      });
      const winnerTokens = await store.getTokens(scmUserId);
      if (winnerTokens) {
        await this.updateLocalTokensFromD1(participant.id, winnerTokens);
        return this.repository.getParticipantById(participant.id);
      }

      // Unexpected: CAS lost but no row found. Fall back to local.
      return this.refreshTokenLocal(participant);
    } catch (error) {
      this.log.error("Centralized token refresh failed, falling back to local", {
        user_id: participant.user_id,
        error: error instanceof Error ? error : String(error),
      });
      return this.refreshTokenLocal(participant);
    }
  }

  /**
   * Update local SQLite participant tokens from a D1 record.
   */
  private async updateLocalTokensFromD1(
    participantId: string,
    d1Tokens: { accessToken: string; refreshToken: string; expiresAt: number }
  ): Promise<void> {
    const [accessEnc, refreshEnc] = await Promise.all([
      encryptToken(d1Tokens.accessToken, this.env.TOKEN_ENCRYPTION_KEY),
      encryptToken(d1Tokens.refreshToken, this.env.TOKEN_ENCRYPTION_KEY),
    ]);
    this.repository.updateParticipantTokens(participantId, {
      scmAccessTokenEncrypted: accessEnc,
      scmRefreshTokenEncrypted: refreshEnc,
      scmTokenExpiresAt: d1Tokens.expiresAt,
    });
  }

  /**
   * After a successful local refresh, seed D1 so future refreshes are centralized.
   */
  private async seedD1AfterLocalRefresh(participant: ParticipantRow): Promise<void> {
    if (
      !this.userScmTokenStore ||
      !participant.scm_user_id ||
      !participant.scm_access_token_encrypted ||
      !participant.scm_refresh_token_encrypted ||
      !participant.scm_token_expires_at
    ) {
      return;
    }

    try {
      const [accessToken, refreshToken] = await Promise.all([
        decryptToken(participant.scm_access_token_encrypted, this.env.TOKEN_ENCRYPTION_KEY),
        decryptToken(participant.scm_refresh_token_encrypted, this.env.TOKEN_ENCRYPTION_KEY),
      ]);

      await this.userScmTokenStore.upsertTokens(
        participant.scm_user_id,
        accessToken,
        refreshToken,
        participant.scm_token_expires_at
      );

      this.log.info("Seeded D1 after local refresh", { user_id: participant.user_id });
    } catch (error) {
      this.log.warn("Failed to seed D1 after local refresh", {
        user_id: participant.user_id,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  /**
   * Local-only refresh using the per-DO SQLite refresh token.
   * Original refreshToken logic — used as fallback when D1 is unavailable.
   */
  private async refreshTokenLocal(participant: ParticipantRow): Promise<ParticipantRow | null> {
    if (!participant.scm_refresh_token_encrypted) {
      this.log.warn("Cannot refresh: no refresh token stored", { user_id: participant.user_id });
      return null;
    }

    if (!this.env.GITHUB_CLIENT_ID || !this.env.GITHUB_CLIENT_SECRET) {
      this.log.warn("Cannot refresh: OAuth credentials not configured");
      return null;
    }

    try {
      const refreshToken = await decryptToken(
        participant.scm_refresh_token_encrypted,
        this.env.TOKEN_ENCRYPTION_KEY
      );

      const newTokens = await refreshAccessToken(refreshToken, {
        clientId: this.env.GITHUB_CLIENT_ID,
        clientSecret: this.env.GITHUB_CLIENT_SECRET,
        encryptionKey: this.env.TOKEN_ENCRYPTION_KEY,
      });

      const newAccessTokenEncrypted = await encryptToken(
        newTokens.access_token,
        this.env.TOKEN_ENCRYPTION_KEY
      );

      const newRefreshTokenEncrypted = newTokens.refresh_token
        ? await encryptToken(newTokens.refresh_token, this.env.TOKEN_ENCRYPTION_KEY)
        : null;

      const newExpiresAt = newTokens.expires_in
        ? Date.now() + newTokens.expires_in * 1000
        : Date.now() + DEFAULT_TOKEN_LIFETIME_MS; // fallback: 8 hours

      this.repository.updateParticipantTokens(participant.id, {
        scmAccessTokenEncrypted: newAccessTokenEncrypted,
        scmRefreshTokenEncrypted: newRefreshTokenEncrypted,
        scmTokenExpiresAt: newExpiresAt,
      });

      this.log.info("Server-side token refresh succeeded", { user_id: participant.user_id });

      return this.repository.getParticipantById(participant.id);
    } catch (error) {
      this.log.error("Server-side token refresh failed", {
        user_id: participant.user_id,
        error: error instanceof Error ? error : String(error),
      });
      return null;
    }
  }

  /**
   * Resolve the OAuth auth context for the prompting user to create a PR.
   *
   * Returns:
   * - `{ auth: SourceControlAuthContext }` on success
   * - `{ auth: null }` when user has no OAuth token (caller falls back to manual flow)
   * - `{ error, status }` on failure (token expired and refresh failed, or decryption error)
   */
  async resolveAuthForPR(
    participant: ParticipantRow
  ): Promise<
    | { auth: SourceControlAuthContext | null; error?: never; status?: never }
    | { auth?: never; error: string; status: number }
  > {
    let resolvedParticipant = participant;

    if (!resolvedParticipant.scm_access_token_encrypted) {
      this.log.info("PR creation: prompting user has no OAuth token, using manual fallback", {
        user_id: resolvedParticipant.user_id,
      });
      return { auth: null };
    }

    if (this.isScmTokenExpired(resolvedParticipant)) {
      this.log.warn("SCM token expired, attempting server-side refresh", {
        userId: resolvedParticipant.user_id,
      });

      const refreshed = await this.refreshToken(resolvedParticipant);
      if (refreshed) {
        resolvedParticipant = refreshed;
      } else {
        this.log.warn("SCM token refresh failed, returning auth error", {
          user_id: resolvedParticipant.user_id,
        });
        return {
          error:
            "Your source control token has expired and could not be refreshed. Please re-authenticate.",
          status: 401,
        };
      }
    }

    if (!resolvedParticipant.scm_access_token_encrypted) {
      return { auth: null };
    }

    try {
      const accessToken = await decryptToken(
        resolvedParticipant.scm_access_token_encrypted,
        this.env.TOKEN_ENCRYPTION_KEY
      );

      return {
        auth: {
          authType: "oauth",
          token: accessToken,
        },
      };
    } catch (error) {
      this.log.error("Failed to decrypt SCM token for PR creation", {
        user_id: resolvedParticipant.user_id,
        error: error instanceof Error ? error : String(error),
      });
      return {
        error: "Failed to process source control token for PR creation.",
        status: 500,
      };
    }
  }
}
