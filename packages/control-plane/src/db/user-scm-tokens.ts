import { encryptToken, decryptToken } from "../auth/crypto";

export interface ScmTokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Raw ciphertext of the refresh token — used as the CAS comparand. */
  refreshTokenEncrypted: string;
}

export type CasResult = { ok: true } | { ok: false; reason: "cas_conflict" };

export class UserScmTokenStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string
  ) {}

  async getTokens(providerUserId: string): Promise<ScmTokenRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT access_token_encrypted, refresh_token_encrypted, token_expires_at FROM user_scm_tokens WHERE provider_user_id = ?"
      )
      .bind(providerUserId)
      .first<{
        access_token_encrypted: string;
        refresh_token_encrypted: string;
        token_expires_at: number;
      }>();

    if (!row) return null;

    const [accessToken, refreshToken] = await Promise.all([
      decryptToken(row.access_token_encrypted, this.encryptionKey),
      decryptToken(row.refresh_token_encrypted, this.encryptionKey),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresAt: row.token_expires_at,
      refreshTokenEncrypted: row.refresh_token_encrypted,
    };
  }

  async upsertTokens(
    provider: string,
    providerUserId: string,
    accessToken: string,
    refreshToken: string,
    expiresAt: number
  ): Promise<void> {
    const now = Date.now();
    const [accessTokenEncrypted, refreshTokenEncrypted] = await Promise.all([
      encryptToken(accessToken, this.encryptionKey),
      encryptToken(refreshToken, this.encryptionKey),
    ]);

    await this.db
      .prepare(
        `INSERT INTO user_scm_tokens
         (provider, provider_user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_user_id) DO UPDATE SET
           provider = excluded.provider,
           access_token_encrypted = excluded.access_token_encrypted,
           refresh_token_encrypted = excluded.refresh_token_encrypted,
           token_expires_at = excluded.token_expires_at,
           updated_at = excluded.updated_at`
      )
      .bind(
        provider,
        providerUserId,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        expiresAt,
        now,
        now
      )
      .run();
  }

  async casUpdateTokens(
    providerUserId: string,
    expectedRefreshTokenEncrypted: string,
    newAccessToken: string,
    newRefreshToken: string,
    newExpiresAt: number
  ): Promise<CasResult> {
    const now = Date.now();
    const [newAccessTokenEncrypted, newRefreshTokenEncrypted] = await Promise.all([
      encryptToken(newAccessToken, this.encryptionKey),
      encryptToken(newRefreshToken, this.encryptionKey),
    ]);

    const result = await this.db
      .prepare(
        `UPDATE user_scm_tokens
         SET access_token_encrypted = ?,
             refresh_token_encrypted = ?,
             token_expires_at = ?,
             updated_at = ?
         WHERE provider_user_id = ? AND refresh_token_encrypted = ?`
      )
      .bind(
        newAccessTokenEncrypted,
        newRefreshTokenEncrypted,
        newExpiresAt,
        now,
        providerUserId,
        expectedRefreshTokenEncrypted
      )
      .run();

    const changes = result.meta?.changes ?? 0;
    return changes > 0 ? { ok: true } : { ok: false, reason: "cas_conflict" };
  }

  isTokenFresh(expiresAt: number, bufferMs = 60_000): boolean {
    return Date.now() + bufferMs < expiresAt;
  }
}
