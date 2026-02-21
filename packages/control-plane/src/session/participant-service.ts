/**
 * ParticipantService - Participant CRUD and GitHub OAuth token management.
 *
 * Extracted from SessionDO to reduce its size. Handles:
 * - Creating and looking up participants
 * - GitHub OAuth token refresh
 * - Resolving auth context for PR creation
 */

import { decryptToken, encryptToken } from "../auth/crypto";
import { refreshAccessToken } from "../auth/github";
import type { SourceControlAuthContext } from "../source-control";
import type { Logger } from "../logger";
import type { ParticipantRow } from "./types";
import type { CreateParticipantData } from "./repository";

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
      githubAccessTokenEncrypted: string;
      githubRefreshTokenEncrypted?: string | null;
      githubTokenExpiresAt: number;
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
}

/**
 * Build GitHub avatar URL from login.
 */
export function getGitHubAvatarUrl(githubLogin: string | null | undefined): string | undefined {
  return githubLogin ? `https://github.com/${githubLogin}.png` : undefined;
}

export class ParticipantService {
  private readonly repository: ParticipantRepository;
  private readonly env: ParticipantServiceEnv;
  private readonly log: Logger;
  private readonly generateId: () => string;

  constructor(deps: ParticipantServiceDeps) {
    this.repository = deps.repository;
    this.env = deps.env;
    this.log = deps.log;
    this.generateId = deps.generateId;
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
      githubName: name,
      role: "member",
      joinedAt: now,
    });

    return {
      id,
      user_id: userId,
      github_user_id: null,
      github_login: null,
      github_email: null,
      github_name: name,
      role: "member",
      github_access_token_encrypted: null,
      github_refresh_token_encrypted: null,
      github_token_expires_at: null,
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
   * Check whether a participant's GitHub token is expired (with buffer).
   */
  isGitHubTokenExpired(participant: ParticipantRow, bufferMs = 60000): boolean {
    if (!participant.github_token_expires_at) {
      return false;
    }
    return Date.now() + bufferMs >= participant.github_token_expires_at;
  }

  /**
   * Refresh a participant's GitHub OAuth token using their stored refresh token.
   * Returns the updated ParticipantRow on success, null on failure.
   */
  async refreshToken(participant: ParticipantRow): Promise<ParticipantRow | null> {
    if (!participant.github_refresh_token_encrypted) {
      this.log.warn("Cannot refresh: no refresh token stored", { user_id: participant.user_id });
      return null;
    }

    if (!this.env.GITHUB_CLIENT_ID || !this.env.GITHUB_CLIENT_SECRET) {
      this.log.warn("Cannot refresh: GitHub OAuth credentials not configured");
      return null;
    }

    try {
      const refreshToken = await decryptToken(
        participant.github_refresh_token_encrypted,
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
        : Date.now() + 8 * 60 * 60 * 1000; // fallback: 8 hours

      this.repository.updateParticipantTokens(participant.id, {
        githubAccessTokenEncrypted: newAccessTokenEncrypted,
        githubRefreshTokenEncrypted: newRefreshTokenEncrypted,
        githubTokenExpiresAt: newExpiresAt,
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

    if (!resolvedParticipant.github_access_token_encrypted) {
      this.log.info("PR creation: prompting user has no OAuth token, using manual fallback", {
        user_id: resolvedParticipant.user_id,
      });
      return { auth: null };
    }

    if (this.isGitHubTokenExpired(resolvedParticipant)) {
      this.log.warn("GitHub token expired, attempting server-side refresh", {
        userId: resolvedParticipant.user_id,
      });

      const refreshed = await this.refreshToken(resolvedParticipant);
      if (refreshed) {
        resolvedParticipant = refreshed;
      } else {
        this.log.warn("GitHub token refresh failed, returning auth error", {
          user_id: resolvedParticipant.user_id,
        });
        return {
          error:
            "Your GitHub token has expired and could not be refreshed. Please re-authenticate.",
          status: 401,
        };
      }
    }

    if (!resolvedParticipant.github_access_token_encrypted) {
      return { auth: null };
    }

    try {
      const accessToken = await decryptToken(
        resolvedParticipant.github_access_token_encrypted,
        this.env.TOKEN_ENCRYPTION_KEY
      );

      return {
        auth: {
          authType: "oauth",
          token: accessToken,
        },
      };
    } catch (error) {
      this.log.error("Failed to decrypt GitHub token for PR creation", {
        user_id: resolvedParticipant.user_id,
        error: error instanceof Error ? error : String(error),
      });
      return {
        error: "Failed to process GitHub token for PR creation.",
        status: 500,
      };
    }
  }
}
