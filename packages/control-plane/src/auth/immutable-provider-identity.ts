import type { ProviderCredentialInput } from "./provider-credential";
import type { VerifiedProviderIdentity } from "./providers/types";
import type { SignInProvider } from "./sign-in-provider";
import { isUniqueConstraintError } from "../db/errors";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";

const CANONICAL_ISSUERS: Readonly<Record<SignInProvider, string>> = {
  github: "https://github.com",
  google: "https://accounts.google.com",
};
const MAX_RESOLUTION_ATTEMPTS = 3;

export type ProviderIdentityEvidence =
  | {
      readonly identity: VerifiedProviderIdentity<"github">;
      readonly providerCredential?: ProviderCredentialInput;
    }
  | {
      readonly identity: VerifiedProviderIdentity<"google">;
      readonly providerCredential?: never;
    };

export interface ResolvedImmutableProviderIdentity {
  readonly userId: string;
  readonly providerIdentityId: string;
  readonly isNewUser: boolean;
  readonly collisions: readonly string[];
}

export interface ImmutableProviderIdentityDependencies {
  readonly clock: { now(): number };
  readonly idGenerator: { generate(): string };
  readonly providerCredentialStore?: ProviderCredentialStorePort;
}

export interface ProviderCredentialStorePort {
  prepareInitialInsert(
    providerIdentityId: string,
    credential: ProviderCredentialInput,
    updatedAt: number
  ): Promise<SqlStatement>;
  upsertFromSignIn(
    providerIdentityId: string,
    credential: ProviderCredentialInput
  ): Promise<number>;
}

interface ProviderCredentialWrite {
  readonly credential: ProviderCredentialInput;
  readonly store: ProviderCredentialStorePort;
}

export class InvalidProviderIdentityEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderIdentityEvidenceError";
  }
}

export class AccountLinkRequiredError extends Error {
  constructor(readonly conflictingEmails: readonly string[]) {
    super("This verified identity requires explicit account linking");
    this.name = "AccountLinkRequiredError";
  }
}

export class ProviderIdentityAdapterMismatchError extends Error {
  constructor() {
    super("Stored provider identity does not match the authenticating adapter");
    this.name = "ProviderIdentityAdapterMismatchError";
  }
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

interface NormalizedIdentityEvidence {
  readonly provider: SignInProvider;
  readonly issuer: string;
  readonly subject: string;
  readonly login: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly verifiedEmails: readonly string[];
  readonly primaryEmail: string | null;
}

function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeIdentityEvidence(identity: VerifiedProviderIdentity): NormalizedIdentityEvidence {
  if (identity.issuer !== CANONICAL_ISSUERS[identity.provider]) {
    throw new InvalidProviderIdentityEvidenceError(
      "Provider identity issuer is not the configured canonical issuer"
    );
  }
  const subject = identity.subject.trim();
  if (subject.length === 0) {
    throw new InvalidProviderIdentityEvidenceError("Provider identity subject is empty");
  }

  const verifiedEmails = [
    ...new Set(identity.verifiedEmails.map((email) => email.trim().toLowerCase()).filter(Boolean)),
  ];
  const primaryEmail = identity.primaryEmail?.trim().toLowerCase() || null;
  if (primaryEmail !== null && !verifiedEmails.includes(primaryEmail)) {
    throw new InvalidProviderIdentityEvidenceError(
      "Primary display email is not provider-verified"
    );
  }

  return {
    provider: identity.provider,
    issuer: identity.issuer,
    subject,
    login: normalizeOptional(identity.login),
    displayName: normalizeOptional(identity.displayName),
    avatarUrl: normalizeOptional(identity.avatarUrl),
    verifiedEmails,
    primaryEmail,
  };
}

function requireGeneratedId(value: string, kind: string): string {
  if (value.length === 0) {
    throw new Error(`Provider identity ${kind} generator returned an invalid id`);
  }
  return value;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export class ImmutableProviderIdentityService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly dependencies: ImmutableProviderIdentityDependencies
  ) {}

  async resolve(evidence: ProviderIdentityEvidence): Promise<ResolvedImmutableProviderIdentity> {
    const identity = normalizeIdentityEvidence(evidence.identity);
    if (identity.provider === "google" && evidence.providerCredential !== undefined) {
      throw new InvalidProviderIdentityEvidenceError(
        "Google sign-in identities cannot persist provider credentials"
      );
    }
    const credentialWrite = this.providerCredentialWrite(evidence.providerCredential);

    for (let attempt = 1; attempt <= MAX_RESOLUTION_ATTEMPTS; attempt += 1) {
      const existing = await this.findIdentity(identity.issuer, identity.subject);
      if (existing) {
        return await this.refreshExisting(existing, identity, credentialWrite);
      }

      const conflictingEmails = await this.findConflictingEmails(identity.verifiedEmails, null);
      if (conflictingEmails.length > 0) {
        throw new AccountLinkRequiredError(conflictingEmails);
      }

      try {
        return await this.createIdentity(identity, credentialWrite);
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt === MAX_RESOLUTION_ATTEMPTS) {
          throw error;
        }
      }
    }

    throw new Error("Provider identity resolution exhausted its retry budget");
  }

  private async createIdentity(
    identity: NormalizedIdentityEvidence,
    credentialWrite: ProviderCredentialWrite | null
  ): Promise<ResolvedImmutableProviderIdentity> {
    const now = this.dependencies.clock.now();
    const userId = requireGeneratedId(this.dependencies.idGenerator.generate(), "user id");
    const providerIdentityId = requireGeneratedId(
      this.dependencies.idGenerator.generate(),
      "identity id"
    );

    const statements: SqlStatement[] = [
      this.db
        .prepare(
          `INSERT INTO users (
             id, display_name, email, avatar_url, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(userId, identity.displayName, identity.primaryEmail, identity.avatarUrl, now, now),
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
          identity.provider,
          identity.issuer,
          identity.subject,
          identity.login,
          identity.primaryEmail,
          now
        ),
      ...identity.verifiedEmails.map((email) =>
        this.db
          .prepare(
            `INSERT INTO verified_email_claims (
               email, user_id, source_kind, source_provider_identity_id,
               created_at, last_verified_at
             ) VALUES (?, ?, 'provider_verified', ?, ?, ?)`
          )
          .bind(email, userId, providerIdentityId, now, now)
      ),
    ];
    if (credentialWrite) {
      statements.push(
        await credentialWrite.store.prepareInitialInsert(
          providerIdentityId,
          credentialWrite.credential,
          now
        )
      );
    }

    await this.db.batch(statements);

    return {
      userId,
      providerIdentityId,
      isNewUser: true,
      collisions: [],
    };
  }

  private async findIdentity(issuer: string, subject: string): Promise<IdentityRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, provider
         FROM user_identities
         WHERE provider_issuer = ? AND provider_user_id = ?`
      )
      .bind(issuer, subject)
      .first<IdentityRow>();
    if (!row) return null;
    if (
      typeof row.id !== "string" ||
      typeof row.user_id !== "string" ||
      typeof row.provider !== "string"
    ) {
      throw new Error("Stored provider identity is corrupt");
    }
    return row;
  }

  private async refreshExisting(
    existing: IdentityRow,
    identity: NormalizedIdentityEvidence,
    credentialWrite: ProviderCredentialWrite | null
  ): Promise<ResolvedImmutableProviderIdentity> {
    if (existing.provider !== identity.provider) {
      throw new ProviderIdentityAdapterMismatchError();
    }

    const now = this.dependencies.clock.now();
    const claims = await this.findClaims(identity.verifiedEmails);
    const claimsByEmail = new Map(claims.map((claim) => [claim.email, claim]));
    const statements: SqlStatement[] = [
      this.db
        .prepare(
          `UPDATE user_identities
           SET provider_login = ?, provider_email = ?
           WHERE id = ? AND user_id = ?`
        )
        .bind(identity.login, identity.primaryEmail, existing.id, existing.user_id),
      this.db
        .prepare(
          `UPDATE users
           SET display_name = ?, avatar_url = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(identity.displayName, identity.avatarUrl, now, existing.user_id),
    ];

    for (const email of identity.verifiedEmails) {
      const claim = claimsByEmail.get(email);
      if (claim?.user_id === existing.user_id && claim.source_kind !== "legacy_canonical") {
        statements.push(
          this.db
            .prepare(
              `UPDATE verified_email_claims
               SET last_verified_at = ?
               WHERE email = ? AND user_id = ?`
            )
            .bind(now, email, existing.user_id)
        );
      } else if (!claim) {
        statements.push(
          this.db
            .prepare(
              `INSERT OR IGNORE INTO verified_email_claims (
                 email, user_id, source_kind, source_provider_identity_id,
                 created_at, last_verified_at
               ) VALUES (?, ?, 'provider_verified', ?, ?, ?)`
            )
            .bind(email, existing.user_id, existing.id, now, now)
        );
      }
    }

    await this.db.batch(statements);
    if (credentialWrite) {
      await credentialWrite.store.upsertFromSignIn(existing.id, credentialWrite.credential);
    }
    return {
      userId: existing.user_id,
      providerIdentityId: existing.id,
      isNewUser: false,
      collisions: await this.findConflictingEmails(identity.verifiedEmails, existing.user_id),
    };
  }

  private providerCredentialWrite(
    credential: ProviderCredentialInput | undefined
  ): ProviderCredentialWrite | null {
    if (!credential) return null;
    const store = this.dependencies.providerCredentialStore;
    if (!store) {
      throw new Error("Provider credential store is not configured");
    }
    return { credential, store };
  }

  private async findClaims(emails: readonly string[]): Promise<EmailClaimRow[]> {
    if (emails.length === 0) return [];
    const result = await this.db
      .prepare(
        `SELECT email, user_id, source_kind
         FROM verified_email_claims
         WHERE email IN (${placeholders(emails.length)})`
      )
      .bind(...emails)
      .all<EmailClaimRow>();

    return result.results.map((row) => {
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
    });
  }

  private async findConflictingEmails(
    emails: readonly string[],
    expectedUserId: string | null
  ): Promise<string[]> {
    const claims = await this.findClaims(emails);
    return claims
      .filter((claim) => expectedUserId === null || claim.user_id !== expectedUserId)
      .map((claim) => claim.email)
      .sort();
  }
}
