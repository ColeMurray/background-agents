import type {
  BrowserSignInIdentityStorePort,
  CreateBrowserSignInIdentityInput,
  RefreshBrowserSignInIdentityInput,
  StoredBrowserSignInIdentity,
} from "../auth/browser-sign-in-identity-store";
import type { ProviderCredentialInput } from "../auth/provider-credential";
import { isSignInProvider } from "../auth/sign-in-provider";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase, SqlStatement } from "./sql-database";

export interface ProviderCredentialWriteStorePort {
  prepareInitialInsert(
    providerIdentityId: string,
    credential: ProviderCredentialInput,
    updatedAt: number
  ): Promise<SqlStatement>;
  prepareSignInUpsert(
    providerIdentityId: string,
    credential: ProviderCredentialInput,
    updatedAt: number
  ): Promise<SqlStatement>;
  isSignInVersionConflict(error: unknown): boolean;
}

interface EmailClaimRow {
  email: string;
  user_id: string;
  source_kind: "legacy_canonical" | "provider_verified" | "trusted_bot_attribution";
}

interface IdentityRow {
  id: string;
  user_id: string;
  provider: string;
}

function decodeIdentityRow(row: IdentityRow): StoredBrowserSignInIdentity {
  if (
    typeof row.id !== "string" ||
    typeof row.user_id !== "string" ||
    !isSignInProvider(row.provider)
  ) {
    throw new Error("Stored provider identity is corrupt");
  }
  return {
    providerIdentityId: row.id,
    userId: row.user_id,
    provider: row.provider,
  };
}

function decodeEmailClaimRow(row: EmailClaimRow): EmailClaimRow {
  if (
    typeof row.email !== "string" ||
    typeof row.user_id !== "string" ||
    (row.source_kind !== "legacy_canonical" &&
      row.source_kind !== "provider_verified" &&
      row.source_kind !== "trusted_bot_attribution")
  ) {
    throw new Error("Stored verified email claim is corrupt");
  }
  return row;
}

export class BrowserSignInIdentityStore implements BrowserSignInIdentityStorePort {
  constructor(
    private readonly db: SqlDatabase,
    private readonly providerCredentialStore: ProviderCredentialWriteStorePort
  ) {}

  async findByIssuerAndSubject(
    issuer: string,
    subject: string
  ): Promise<StoredBrowserSignInIdentity | null> {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, provider
         FROM user_identities
         WHERE provider_issuer = ? AND provider_user_id = ?`
      )
      .bind(issuer, subject)
      .first<IdentityRow>();
    return row ? decodeIdentityRow(row) : null;
  }

  async countConflictingEmails(
    emails: readonly string[],
    expectedUserId: string | null
  ): Promise<number> {
    if (emails.length === 0) return 0;
    const result = await this.db
      .prepare(
        `SELECT email, user_id, source_kind
         FROM verified_email_claims
         WHERE email IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
      )
      .bind(JSON.stringify(emails))
      .all<EmailClaimRow>();

    return result.results
      .map(decodeEmailClaimRow)
      .filter((claim) => expectedUserId === null || claim.user_id !== expectedUserId).length;
  }

  async create(input: CreateBrowserSignInIdentityInput): Promise<void> {
    const { userId, providerIdentityId, profile, credential, now } = input;
    const statements: SqlStatement[] = [
      this.db
        .prepare(
          `INSERT INTO users (
             id, display_name, email, avatar_url, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(userId, profile.displayName, profile.primaryEmail, profile.avatarUrl, now, now),
      this.db
        .prepare(
          `INSERT INTO user_identities (
             id, user_id, provider, provider_issuer, provider_user_id,
             provider_login, provider_email, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          providerIdentityId,
          userId,
          profile.provider,
          profile.issuer,
          profile.subject,
          profile.login,
          profile.primaryEmail,
          now
        ),
    ];
    if (profile.verifiedEmails.length > 0) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO verified_email_claims (
               email, user_id, source_kind, source_provider_identity_id,
               created_at, last_verified_at
             )
             SELECT CAST(value AS TEXT), ?, 'provider_verified', ?, ?, ?
             FROM json_each(?)`
          )
          .bind(userId, providerIdentityId, now, now, JSON.stringify(profile.verifiedEmails))
      );
    }
    if (credential) {
      statements.push(
        await this.providerCredentialStore.prepareInitialInsert(providerIdentityId, credential, now)
      );
    }

    await this.db.batch(statements);
  }

  async refresh(input: RefreshBrowserSignInIdentityInput): Promise<void> {
    const { existing, profile, credential, now } = input;
    const statements: SqlStatement[] = [
      this.db
        .prepare(
          `UPDATE user_identities
           SET provider_login = ?, provider_email = ?
           WHERE id = ? AND user_id = ?`
        )
        .bind(profile.login, profile.primaryEmail, existing.providerIdentityId, existing.userId),
      // users.email is stable canonical account metadata, not a mirror of a
      // provider's mutable primary email. Current provider display metadata
      // lives on user_identities; verified ownership evidence lives in claims.
      this.db
        .prepare(
          `UPDATE users
           SET display_name = ?, avatar_url = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(profile.displayName, profile.avatarUrl, now, existing.userId),
    ];
    if (profile.verifiedEmails.length > 0) {
      const serializedEmails = JSON.stringify(profile.verifiedEmails);
      statements.push(
        this.db
          .prepare(
            `UPDATE verified_email_claims
             SET last_verified_at = ?
             WHERE user_id = ?
               AND source_kind != 'legacy_canonical'
               AND email IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
          )
          .bind(now, existing.userId, serializedEmails),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO verified_email_claims (
               email, user_id, source_kind, source_provider_identity_id,
               created_at, last_verified_at
             )
             SELECT CAST(value AS TEXT), ?, 'provider_verified', ?, ?, ?
             FROM json_each(?)`
          )
          .bind(existing.userId, existing.providerIdentityId, now, now, serializedEmails)
      );
    }
    if (credential) {
      statements.push(
        await this.providerCredentialStore.prepareSignInUpsert(
          existing.providerIdentityId,
          credential,
          now
        )
      );
    }

    await this.db.batch(statements);
  }

  isRetryableCreateConflict(error: unknown): boolean {
    return isUniqueConstraintError(error);
  }

  isRetryableRefreshConflict(error: unknown): boolean {
    return (
      isUniqueConstraintError(error) || this.providerCredentialStore.isSignInVersionConflict(error)
    );
  }
}
