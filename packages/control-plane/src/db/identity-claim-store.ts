import type { SqlDatabase } from "./sql-database";

/**
 * Persistence layer for the sign-in claim (`auth/user/sign-in-claim.ts`):
 * the canonical-registry reads and guarded writes the claim performs around
 * Better Auth's own queries. Kept apart from `UserStore` because every write
 * here is proof-carrying — it mints `email_verified` from a completed OAuth
 * sign-in, which bot ingress may only do for attesting providers.
 *
 * All email parameters must arrive pre-normalized (`normalizeEmail`); the
 * `lower(trim(...))` comparisons here exist to match legacy stored forms
 * against that canonical input, not to normalize the input itself.
 */
export interface UserEmailState {
  email: string | null;
  emailVerified: boolean;
}

export class IdentityClaimStore {
  constructor(private readonly db: SqlDatabase) {}

  /** The canonical owner of a provider identity, if the subject is known. */
  async findIdentityOwnerId(provider: string, providerUserId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT user_id FROM user_identities WHERE provider = ? AND provider_user_id = ?`)
      .bind(provider, providerUserId)
      .first<{ user_id: string }>();
    return row?.user_id ?? null;
  }

  async getEmailState(userId: string): Promise<UserEmailState | null> {
    const row = await this.db
      .prepare(`SELECT email, email_verified FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ email: string | null; email_verified: number }>();
    return row ? { email: row.email, emailVerified: row.email_verified === 1 } : null;
  }

  /** The user owning `email` under any stored legacy form, if one exists. */
  async findEmailOwnerId(email: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT id FROM users WHERE email IS NOT NULL AND lower(trim(email)) = ?`)
      .bind(email)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  /**
   * Give a NULL-email user the just-proven email, verified. Guarded on the
   * target still being email-less; OR IGNORE nets a concurrent claim of the
   * same email so a race never fails the sign-in. Returns whether the row
   * changed.
   */
  async claimEmail(userId: string, email: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE OR IGNORE users
         SET email = ?, email_verified = 1, updated_at = ?
         WHERE id = ? AND email IS NULL`
      )
      .bind(email, Date.now(), userId)
      .run();
    return result.meta.changes > 0;
  }

  /** Mint verification for a user whose stored email matches the proven one. */
  async verifyEmail(userId: string, email: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE users SET email_verified = 1, updated_at = ?
         WHERE id = ? AND lower(trim(email)) = ?`
      )
      .bind(Date.now(), userId, email)
      .run();
  }

  /**
   * Rewrite a legacy stored form of `email` to its canonical form so Better
   * Auth's exact-match lookup finds it. OR IGNORE: if the canonical form is
   * already taken by another row, the legacy row keeps its form (and stays
   * findable by identity subject).
   */
  async normalizeStoredEmail(email: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE OR IGNORE users SET email = lower(trim(email)), updated_at = ?
         WHERE email IS NOT NULL AND lower(trim(email)) = ? AND email <> lower(trim(email))`
      )
      .bind(Date.now(), email)
      .run();
  }

  /**
   * Mint verification for the canonical-form owner of `email`, returning the
   * owner's id when a row actually transitioned.
   */
  async verifyEmailOwner(email: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `UPDATE users SET email_verified = 1, updated_at = ?
         WHERE email = ? AND email_verified = 0
         RETURNING id`
      )
      .bind(Date.now(), email)
      .first<{ id: string }>();
    return row?.id ?? null;
  }
}
