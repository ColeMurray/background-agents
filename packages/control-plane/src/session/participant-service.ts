/**
 * ParticipantService - Participant CRUD and SCM OAuth token management.
 *
 * Extracted from SessionDO to reduce its size. Handles:
 * - Creating and looking up participants
 * - Resolving current GitHub credentials through Better Auth
 * - Refreshing legacy credentials copied into existing session participants
 * - Resolving auth context for PR creation
 */

import { decryptToken, encryptToken } from "../auth/crypto";
import { refreshAccessToken } from "../auth/github";
import type { SourceControlAuthContext, SourceControlProviderName } from "../source-control";
import type { Logger } from "../logger";
import { BetterAuthGitHubTokenUnavailableError } from "./identity";
import type { ParticipantRow } from "./types";
import type { ParticipantRepository } from "./participant-repository";

const GITHUB_DEFAULT_TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;

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
  getProcessingMessageAuthor: () => { author_id: string } | null;
  env: ParticipantServiceEnv;
  log: Logger;
  generateId: () => string;
  resolveCurrentGitHubAccessToken?: (
    canonicalUserId: string,
    scmUserId: string
  ) => Promise<string | null>;
}

export type PromptingAuthResolution =
  | { auth: SourceControlAuthContext | null }
  | { error: string; status: number };

/**
 * Build avatar URL from SCM login.
 */
export function getAvatarUrl(
  login: string | null | undefined,
  provider: SourceControlProviderName = "github",
  userId?: string | null
): string | undefined {
  if (provider !== "github") return undefined;
  if (userId) return `https://avatars.githubusercontent.com/u/${encodeURIComponent(userId)}?v=4`;
  return login ? `https://github.com/${login}.png` : undefined;
}

export class ParticipantService {
  private readonly repository: ParticipantRepository;
  private readonly env: ParticipantServiceEnv;
  private readonly log: Logger;
  private readonly generateId: () => string;
  private readonly resolveCurrentGitHubAccessToken?: ParticipantServiceDeps["resolveCurrentGitHubAccessToken"];
  private readonly getProcessingMessageAuthor: () => { author_id: string } | null;

  constructor(deps: ParticipantServiceDeps) {
    this.repository = deps.repository;
    this.env = deps.env;
    this.log = deps.log;
    this.generateId = deps.generateId;
    this.resolveCurrentGitHubAccessToken = deps.resolveCurrentGitHubAccessToken;
    this.getProcessingMessageAuthor = deps.getProcessingMessageAuthor;
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
  create(userId: string, name: string, canonicalUserId?: string): ParticipantRow {
    const id = this.generateId();
    const now = Date.now();

    this.repository.createParticipant({
      id,
      userId,
      canonicalUserId: canonicalUserId ?? null,
      scmName: name,
      role: "member",
      joinedAt: now,
    });

    return {
      id,
      user_id: userId,
      canonical_user_id: canonicalUserId ?? null,
      scm_user_id: null,
      scm_login: null,
      scm_email: null,
      scm_name: name,
      auth_name: null,
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
    const processingMessage = this.getProcessingMessageAuthor();

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
   * Refresh credentials copied into an existing participant. New GitHub
   * sessions resolve through Better Auth instead of copying refresh tokens.
   */
  async refreshToken(participant: ParticipantRow): Promise<ParticipantRow | null> {
    return this.refreshTokenLocal(participant);
  }

  /**
   * Local-only refresh using the per-DO SQLite refresh token. Retained for
   * already-running sessions created before Better Auth became authoritative.
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
        : Date.now() + GITHUB_DEFAULT_TOKEN_LIFETIME_MS;

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
   * - `{ auth: null }` when user has no usable OAuth token (caller falls back to app token)
   * - `{ error, status }` on unexpected failure
   */
  async resolveAuthForPR(participant: ParticipantRow): Promise<PromptingAuthResolution> {
    // Token-bearing participant rows predate Better Auth authority. Keep their
    // local refresh/decrypt flow isolated from current identity-only sessions.
    if (participant.scm_access_token_encrypted || participant.scm_refresh_token_encrypted) {
      return this.resolveLegacyAuthForPR(participant);
    }

    if (
      this.resolveCurrentGitHubAccessToken &&
      participant.canonical_user_id &&
      participant.scm_user_id
    ) {
      try {
        const accessToken = await this.resolveCurrentGitHubAccessToken(
          participant.canonical_user_id,
          participant.scm_user_id
        );
        if (accessToken) {
          return { auth: { authType: "oauth", token: accessToken } };
        }
      } catch (error) {
        if (error instanceof BetterAuthGitHubTokenUnavailableError) {
          this.log.warn("Better Auth GitHub token retrieval failed, using app fallback", {
            user_id: participant.user_id,
            error:
              error.retrievalError instanceof Error
                ? error.retrievalError
                : String(error.retrievalError),
          });
          return { auth: null };
        }
        this.log.error("Failed to resolve current Better Auth token for PR creation", {
          user_id: participant.user_id,
          error: error instanceof Error ? error : String(error),
        });
        return { error: "Failed to resolve GitHub credentials", status: 500 };
      }
    }

    this.log.info("PR creation: prompting user has no OAuth token, using app fallback", {
      user_id: participant.user_id,
    });
    return { auth: null };
  }

  private async resolveLegacyAuthForPR(
    participant: ParticipantRow
  ): Promise<{ auth: SourceControlAuthContext | null }> {
    let resolvedParticipant = participant;

    if (!resolvedParticipant.scm_access_token_encrypted) {
      this.log.info("PR creation: legacy participant has no OAuth token, using app fallback", {
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
        this.log.warn("SCM token expired and refresh failed, falling back to app token", {
          user_id: resolvedParticipant.user_id,
        });
        return { auth: null };
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
      this.log.error("Failed to decrypt SCM token for PR creation, falling back to app token", {
        user_id: resolvedParticipant.user_id,
        error: error instanceof Error ? error : String(error),
      });
      return { auth: null };
    }
  }
}
