/**
 * Web session tokens (`oi_at_`) and their rotating refresh tokens (`oi_rt_`).
 *
 * Minted only by the provider-verified exchange; opaque,
 * hash-at-rest, individually revocable. Renewal is a refresh grant with
 * rotation — redeeming a refresh token mints a new pair and consumes the old
 * one, and reuse of a consumed token revokes its whole family.
 *
 * Reuse within REFRESH_REUSE_GRACE_MS of the original rotation is treated as
 * a benign concurrent renewal (NextAuth's jwt callback runs in contexts that
 * cannot all persist the rotated cookie), rejected without family revocation.
 * Reuse after the grace window is the attack signal and revokes the family.
 */

import { generateId, hashToken } from "./crypto";
import { base64UrlEncode } from "./encoding";
import type { WebAuthProvider } from "./subject-verification";
import type { ApiTokenRow, WebSessionTokenStore } from "../db/api-tokens";

export const WEB_SESSION_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
export const WEB_SESSION_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const WEB_SESSION_FAMILY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const REFRESH_REUSE_GRACE_MS = 60 * 1000;

export const ACCESS_TOKEN_PREFIX = "oi_at_";
export const REFRESH_TOKEN_PREFIX = "oi_rt_";

/** The provider-verified subject a token pair was minted for. */
export interface TokenSubject {
  provider: WebAuthProvider;
  providerUserId: string;
}

export interface WebSessionTokenPair {
  accessToken: string;
  accessTokenExpiresAtEpochMs: number;
  refreshToken: string;
  refreshTokenExpiresAtEpochMs: number;
}

export type AccessTokenVerification =
  | {
      ok: true;
      tokenId: string;
      userId: string;
      provider: WebAuthProvider;
      providerUserId: string;
    }
  | { ok: false; failure: "unknown" | "expired" | "revoked" };

export type RefreshRedemption =
  | { ok: true; pair: WebSessionTokenPair }
  | { ok: false; failure: "invalid_refresh_token" | "refresh_reuse_detected" };

/** 32 random bytes as unpadded base64url — the opaque token body. */
function randomTokenBody(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * An api_tokens row as this service mints it: subject and family columns are
 * always populated (they are nullable in the schema only for future P2 token
 * kinds).
 */
interface WebSessionRow extends ApiTokenRow {
  provider: WebAuthProvider;
  providerUserId: string;
  familyId: string;
}

/**
 * Narrow a raw row to the shape this service mints — fail closed: a row
 * missing the verified subject or its rotation family was not minted by this
 * service in this shape, so the presented token is not a valid web session
 * token.
 */
function isWebSessionRow(row: ApiTokenRow): row is WebSessionRow {
  return (
    (row.provider === "github" || row.provider === "google") &&
    row.providerUserId !== null &&
    row.familyId !== null
  );
}

export class WebSessionTokenService {
  constructor(private readonly store: WebSessionTokenStore) {}

  /** Mint a fresh pair in a new rotation family (exchange path). */
  async mintPair(userId: string, subject: TokenSubject): Promise<WebSessionTokenPair> {
    const familyId = generateId();
    const familyExpiresAt = Date.now() + WEB_SESSION_FAMILY_TTL_MS;
    const minted = await this.mintPairInFamily(userId, subject, familyId, familyExpiresAt);
    return minted.pair;
  }

  private async mintPairInFamily(
    userId: string,
    subject: TokenSubject,
    familyId: string,
    familyExpiresAt: number
  ): Promise<{ pair: WebSessionTokenPair; accessTokenId: string; refreshTokenId: string }> {
    const now = Date.now();
    const accessToken = `${ACCESS_TOKEN_PREFIX}${randomTokenBody()}`;
    const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomTokenBody()}`;
    const accessTokenExpiresAtEpochMs = now + WEB_SESSION_TOKEN_TTL_MS;
    const refreshTokenExpiresAtEpochMs = Math.min(
      now + WEB_SESSION_REFRESH_TTL_MS,
      familyExpiresAt
    );

    const [accessHash, refreshHash] = await Promise.all([
      hashToken(accessToken),
      hashToken(refreshToken),
    ]);
    const [accessTokenId, refreshTokenId] = await this.store.createPair([
      {
        tokenHash: accessHash,
        kind: "web_session",
        userId,
        provider: subject.provider,
        providerUserId: subject.providerUserId,
        familyId,
        expiresAt: accessTokenExpiresAtEpochMs,
        familyExpiresAt: null,
      },
      {
        tokenHash: refreshHash,
        kind: "web_session_refresh",
        userId,
        provider: subject.provider,
        providerUserId: subject.providerUserId,
        familyId,
        expiresAt: refreshTokenExpiresAtEpochMs,
        familyExpiresAt,
      },
    ]);

    return {
      pair: {
        accessToken,
        accessTokenExpiresAtEpochMs,
        refreshToken,
        refreshTokenExpiresAtEpochMs,
      },
      accessTokenId,
      refreshTokenId,
    };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenVerification> {
    const row = await this.store.getByHash(await hashToken(token));
    if (!row || row.kind !== "web_session") {
      return { ok: false, failure: "unknown" };
    }
    if (!isWebSessionRow(row)) {
      return { ok: false, failure: "unknown" };
    }
    if (row.revokedAt !== null) {
      return { ok: false, failure: "revoked" };
    }
    if (row.expiresAt <= Date.now()) {
      return { ok: false, failure: "expired" };
    }
    return {
      ok: true,
      tokenId: row.id,
      userId: row.userId,
      provider: row.provider,
      providerUserId: row.providerUserId,
    };
  }

  /**
   * Redeem a refresh token for a new pair, consuming it. Reuse of a consumed
   * token — or losing the consume race — revokes the whole family.
   */
  async redeemRefreshToken(token: string): Promise<RefreshRedemption> {
    const row = await this.store.getByHash(await hashToken(token));
    if (!row || row.kind !== "web_session_refresh") {
      return { ok: false, failure: "invalid_refresh_token" };
    }
    if (!isWebSessionRow(row)) {
      return { ok: false, failure: "invalid_refresh_token" };
    }
    // Ordering is load-bearing: the replay (rotatedTo) check runs BEFORE the
    // revoked/expired checks so that reuse of a consumed-and-since-expired
    // token still counts as the attack signal and revokes the family.
    if (row.rotatedTo !== null) {
      // Replay of an already-consumed token. Within the grace window this is
      // a benign concurrent renewal — reject without a new pair, but leave
      // the family alive. Beyond it, assume the family is compromised.
      const successor = await this.store.getById(row.rotatedTo);
      if (successor !== null && Date.now() - successor.createdAt <= REFRESH_REUSE_GRACE_MS) {
        return { ok: false, failure: "invalid_refresh_token" };
      }
      await this.store.revokeFamily(row.familyId);
      return { ok: false, failure: "refresh_reuse_detected" };
    }
    const now = Date.now();
    // A null familyExpiresAt is rejected fail-closed: this service always
    // stamps the family cap on refresh rows it mints, so a row without one
    // was not minted here and must not seed a fresh rotation family.
    if (
      row.revokedAt !== null ||
      row.expiresAt <= now ||
      row.familyExpiresAt === null ||
      row.familyExpiresAt <= now
    ) {
      return { ok: false, failure: "invalid_refresh_token" };
    }

    const minted = await this.mintPairInFamily(
      row.userId,
      { provider: row.provider, providerUserId: row.providerUserId },
      row.familyId,
      row.familyExpiresAt
    );

    const consumed = await this.store.consumeRefreshToken(row.id, minted.refreshTokenId);
    if (!consumed) {
      // Lost a concurrent redeem race — by definition within the grace
      // window. Revoke only the orphaned pair this call minted; the race
      // winner's pair stays live.
      await Promise.all([
        this.store.revokeToken(minted.accessTokenId),
        this.store.revokeToken(minted.refreshTokenId),
      ]);
      return { ok: false, failure: "invalid_refresh_token" };
    }

    return { ok: true, pair: minted.pair };
  }
}
