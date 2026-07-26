import {
  ProviderCredentialIntegrityError,
  type ProviderCredentialCipherBinding,
  type ProviderCredentialCipherPort,
} from "../auth/provider-credential-cipher";
import type { ProviderCredentialInput, ProviderCredentialKind } from "../auth/provider-credential";
import type { Clock } from "./browser-auth-sessions";
import { isCheckConstraintError, isUniqueConstraintError } from "./errors";
import type { SqlDatabase, SqlStatement } from "./sql-database";

export const CURRENT_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_VERSION = 1;
/**
 * Migration 0047's CHECK expression is part of stale sign-in conflict
 * detection: SQLite/D1 includes it in the constraint error message.
 */
export const PROVIDER_CREDENTIAL_ROW_VERSION_CHECK = "row_version >= 1";
const SUPPORTED_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_VERSIONS: ReadonlySet<number> = new Set([
  CURRENT_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_VERSION,
]);
const MAX_SIGN_IN_UPSERT_ATTEMPTS = 4;

interface ProviderCredentialMetadata {
  providerIdentityId: string;
  encryptionKeyVersion: number;
  rowVersion: number;
  updatedAt: number;
}

export type ProviderCredential =
  | (ProviderCredentialMetadata & {
      kind: "refreshable";
      accessToken: string;
      accessExpiresAt: number;
      refreshToken: string;
      refreshExpiresAt: number | null;
    })
  | (ProviderCredentialMetadata & {
      kind: "access_only_expiring";
      accessToken: string;
      accessExpiresAt: number;
    })
  | (ProviderCredentialMetadata & {
      kind: "access_only_nonexpiring";
      accessToken: string;
    });

interface ProviderCredentialRowMetadata {
  providerIdentityId: string;
  accessTokenCiphertext: string;
  encryptionKeyVersion: number;
  rowVersion: number;
  updatedAt: number;
}

type ProviderCredentialRow =
  | (ProviderCredentialRowMetadata & {
      credentialKind: "refreshable";
      accessExpiresAt: number;
      refreshTokenCiphertext: string;
      refreshExpiresAt: number | null;
    })
  | (ProviderCredentialRowMetadata & {
      credentialKind: "access_only_expiring";
      accessExpiresAt: number;
      refreshTokenCiphertext: null;
      refreshExpiresAt: null;
    })
  | (ProviderCredentialRowMetadata & {
      credentialKind: "access_only_nonexpiring";
      accessExpiresAt: null;
      refreshTokenCiphertext: null;
      refreshExpiresAt: null;
    });

interface EncryptedProviderCredential {
  accessTokenCiphertext: string;
  accessExpiresAt: number | null;
  refreshTokenCiphertext: string | null;
  refreshExpiresAt: number | null;
}

export class InvalidProviderCredentialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderCredentialInputError";
  }
}

export class StoredProviderCredentialCorruptError extends Error {
  constructor() {
    super("Stored provider credential is invalid");
    this.name = "StoredProviderCredentialCorruptError";
  }
}

export class ProviderCredentialVersionConflictError extends Error {
  constructor() {
    super("Provider credential changed concurrently");
    this.name = "ProviderCredentialVersionConflictError";
  }
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSupportedProviderCredentialEncryptionKeyVersion(value: unknown): value is number {
  return (
    isFiniteInteger(value) &&
    value > 0 &&
    SUPPORTED_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_VERSIONS.has(value)
  );
}

function validateInput(providerIdentityId: string, input: ProviderCredentialInput): void {
  if (!isNonEmptyString(providerIdentityId) || !isNonEmptyString(input.accessToken)) {
    throw new InvalidProviderCredentialInputError(
      "Provider credential requires an identity and access token"
    );
  }
  if ("accessExpiresAt" in input && !isFiniteInteger(input.accessExpiresAt)) {
    throw new InvalidProviderCredentialInputError(
      "Provider access-token expiry must be an integer"
    );
  }
  if (
    input.kind === "refreshable" &&
    (!isNonEmptyString(input.refreshToken) ||
      (input.refreshExpiresAt !== null && !isFiniteInteger(input.refreshExpiresAt)))
  ) {
    throw new InvalidProviderCredentialInputError("Refreshable provider credential is malformed");
  }
}

function validateObservedVersion(providerIdentityId: string, observedRowVersion: number): void {
  if (
    !isNonEmptyString(providerIdentityId) ||
    !isFiniteInteger(observedRowVersion) ||
    observedRowVersion < 1
  ) {
    throw new InvalidProviderCredentialInputError(
      "Provider identity and positive observed row version are required"
    );
  }
}

function decodeProviderCredentialRow(value: unknown): ProviderCredentialRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoredProviderCredentialCorruptError();
  }
  const row = value as Record<string, unknown>;
  if (
    !isNonEmptyString(row.provider_identity_id) ||
    !isNonEmptyString(row.access_token_ciphertext) ||
    !isSupportedProviderCredentialEncryptionKeyVersion(row.encryption_key_version) ||
    !isFiniteInteger(row.row_version) ||
    row.row_version < 1 ||
    !isFiniteInteger(row.updated_at)
  ) {
    throw new StoredProviderCredentialCorruptError();
  }

  const metadata = {
    providerIdentityId: row.provider_identity_id,
    accessTokenCiphertext: row.access_token_ciphertext,
    encryptionKeyVersion: row.encryption_key_version,
    rowVersion: row.row_version,
    updatedAt: row.updated_at,
  };
  if (
    row.credential_kind === "refreshable" &&
    isFiniteInteger(row.access_expires_at) &&
    isNonEmptyString(row.refresh_token_ciphertext) &&
    (row.refresh_expires_at === null || isFiniteInteger(row.refresh_expires_at))
  ) {
    return {
      ...metadata,
      credentialKind: "refreshable",
      accessExpiresAt: row.access_expires_at,
      refreshTokenCiphertext: row.refresh_token_ciphertext,
      refreshExpiresAt: row.refresh_expires_at,
    };
  }
  if (
    row.credential_kind === "access_only_expiring" &&
    isFiniteInteger(row.access_expires_at) &&
    row.refresh_token_ciphertext === null &&
    row.refresh_expires_at === null
  ) {
    return {
      ...metadata,
      credentialKind: "access_only_expiring",
      accessExpiresAt: row.access_expires_at,
      refreshTokenCiphertext: null,
      refreshExpiresAt: null,
    };
  }
  if (
    row.credential_kind === "access_only_nonexpiring" &&
    row.access_expires_at === null &&
    row.refresh_token_ciphertext === null &&
    row.refresh_expires_at === null
  ) {
    return {
      ...metadata,
      credentialKind: "access_only_nonexpiring",
      accessExpiresAt: null,
      refreshTokenCiphertext: null,
      refreshExpiresAt: null,
    };
  }
  throw new StoredProviderCredentialCorruptError();
}

function cipherBinding(
  providerIdentityId: string,
  credentialKind: ProviderCredentialKind,
  tokenRole: "access" | "refresh",
  encryptionKeyVersion: number,
  rowVersion: number
): ProviderCredentialCipherBinding {
  return {
    providerIdentityId,
    credentialKind,
    tokenRole,
    encryptionKeyVersion,
    rowVersion,
  };
}

export class ProviderCredentialStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly cipher: ProviderCredentialCipherPort,
    private readonly clock: Clock
  ) {}

  /**
   * Prepares, but does not execute, an initial credential insert so identity
   * resolution can commit the user, identity, email claim, and credential in
   * one caller-owned database batch.
   */
  async prepareInitialInsert(
    providerIdentityId: string,
    credential: ProviderCredentialInput,
    updatedAt = this.clock.now()
  ): Promise<SqlStatement> {
    validateInput(providerIdentityId, credential);
    if (!isFiniteInteger(updatedAt)) {
      throw new InvalidProviderCredentialInputError(
        "Provider credential update time must be an integer"
      );
    }
    const rowVersion = 1;
    const encrypted = await this.encryptCredential(providerIdentityId, credential, rowVersion);
    return this.prepareInsertStatement(
      providerIdentityId,
      credential.kind,
      encrypted,
      rowVersion,
      updatedAt
    );
  }

  /**
   * Prepares a sign-in upsert for a caller-owned batch. A concurrent version
   * change deliberately violates the row-version check, aborting the entire
   * batch instead of committing the caller's related writes partially.
   */
  async prepareSignInUpsert(
    providerIdentityId: string,
    credential: ProviderCredentialInput,
    updatedAt = this.clock.now()
  ): Promise<SqlStatement> {
    validateInput(providerIdentityId, credential);
    if (!isFiniteInteger(updatedAt)) {
      throw new InvalidProviderCredentialInputError(
        "Provider credential update time must be an integer"
      );
    }

    const previousVersion = await this.readRowVersion(providerIdentityId);
    if (previousVersion === null) {
      return await this.prepareInitialInsert(providerIdentityId, credential, updatedAt);
    }

    const rowVersion = previousVersion + 1;
    const encrypted = await this.encryptCredential(providerIdentityId, credential, rowVersion);
    return this.db
      .prepare(
        `INSERT INTO provider_credentials (
           provider_identity_id, credential_kind,
           access_token_ciphertext, access_expires_at,
           refresh_token_ciphertext, refresh_expires_at,
           encryption_key_version, row_version, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_identity_id) DO UPDATE SET
           credential_kind = excluded.credential_kind,
           access_token_ciphertext = excluded.access_token_ciphertext,
           access_expires_at = excluded.access_expires_at,
           refresh_token_ciphertext = excluded.refresh_token_ciphertext,
           refresh_expires_at = excluded.refresh_expires_at,
           encryption_key_version = excluded.encryption_key_version,
           row_version = CASE
             WHEN provider_credentials.row_version = ?
               THEN excluded.row_version
             ELSE 0
           END,
           updated_at = excluded.updated_at`
      )
      .bind(
        providerIdentityId,
        credential.kind,
        encrypted.accessTokenCiphertext,
        encrypted.accessExpiresAt,
        encrypted.refreshTokenCiphertext,
        encrypted.refreshExpiresAt,
        CURRENT_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_VERSION,
        rowVersion,
        updatedAt,
        previousVersion
      );
  }

  isSignInVersionConflict(error: unknown): boolean {
    return isCheckConstraintError(error, PROVIDER_CREDENTIAL_ROW_VERSION_CHECK);
  }

  async upsertFromSignIn(
    providerIdentityId: string,
    credential: ProviderCredentialInput
  ): Promise<number> {
    validateInput(providerIdentityId, credential);

    for (let attempt = 0; attempt < MAX_SIGN_IN_UPSERT_ATTEMPTS; attempt += 1) {
      const previousVersion = await this.readRowVersion(providerIdentityId);
      const rowVersion = (previousVersion ?? 0) + 1;
      const encrypted = await this.encryptCredential(providerIdentityId, credential, rowVersion);
      const updatedAt = this.clock.now();

      if (previousVersion === null) {
        try {
          const inserted = await this.prepareInsertStatement(
            providerIdentityId,
            credential.kind,
            encrypted,
            rowVersion,
            updatedAt
          ).run();
          if (inserted.meta.changes === 1) return rowVersion;
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error;
        }
        continue;
      }

      if (
        await this.updateObservedVersion(
          providerIdentityId,
          previousVersion,
          rowVersion,
          credential.kind,
          encrypted,
          updatedAt
        )
      ) {
        return rowVersion;
      }
    }

    throw new ProviderCredentialVersionConflictError();
  }

  private async readRowVersion(providerIdentityId: string): Promise<number | null> {
    const row = await this.db
      .prepare(
        `SELECT row_version
         FROM provider_credentials
         WHERE provider_identity_id = ?`
      )
      .bind(providerIdentityId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    if (!isFiniteInteger(row.row_version) || row.row_version < 1) {
      throw new StoredProviderCredentialCorruptError();
    }
    return row.row_version;
  }

  private async encryptCredential(
    providerIdentityId: string,
    credential: ProviderCredentialInput,
    rowVersion: number
  ): Promise<EncryptedProviderCredential> {
    const [accessTokenCiphertext, refreshTokenCiphertext] = await Promise.all([
      this.cipher.encrypt(
        credential.accessToken,
        cipherBinding(
          providerIdentityId,
          credential.kind,
          "access",
          CURRENT_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_VERSION,
          rowVersion
        )
      ),
      credential.kind === "refreshable"
        ? this.cipher.encrypt(
            credential.refreshToken,
            cipherBinding(
              providerIdentityId,
              credential.kind,
              "refresh",
              CURRENT_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_VERSION,
              rowVersion
            )
          )
        : Promise.resolve(null),
    ]);
    return {
      accessTokenCiphertext,
      accessExpiresAt:
        credential.kind === "access_only_nonexpiring" ? null : credential.accessExpiresAt,
      refreshTokenCiphertext,
      refreshExpiresAt: credential.kind === "refreshable" ? credential.refreshExpiresAt : null,
    };
  }

  private prepareInsertStatement(
    providerIdentityId: string,
    credentialKind: ProviderCredentialKind,
    encrypted: EncryptedProviderCredential,
    rowVersion: number,
    updatedAt: number
  ): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO provider_credentials (
           provider_identity_id, credential_kind,
           access_token_ciphertext, access_expires_at,
           refresh_token_ciphertext, refresh_expires_at,
           encryption_key_version, row_version, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        providerIdentityId,
        credentialKind,
        encrypted.accessTokenCiphertext,
        encrypted.accessExpiresAt,
        encrypted.refreshTokenCiphertext,
        encrypted.refreshExpiresAt,
        CURRENT_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_VERSION,
        rowVersion,
        updatedAt
      );
  }

  private async updateObservedVersion(
    providerIdentityId: string,
    observedRowVersion: number,
    rowVersion: number,
    credentialKind: ProviderCredentialKind,
    encrypted: EncryptedProviderCredential,
    updatedAt: number
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE provider_credentials
         SET credential_kind = ?,
             access_token_ciphertext = ?,
             access_expires_at = ?,
             refresh_token_ciphertext = ?,
             refresh_expires_at = ?,
             encryption_key_version = ?,
             row_version = ?,
             updated_at = ?
         WHERE provider_identity_id = ? AND row_version = ?`
      )
      .bind(
        credentialKind,
        encrypted.accessTokenCiphertext,
        encrypted.accessExpiresAt,
        encrypted.refreshTokenCiphertext,
        encrypted.refreshExpiresAt,
        CURRENT_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_VERSION,
        rowVersion,
        updatedAt,
        providerIdentityId,
        observedRowVersion
      )
      .run();
    return result.meta.changes === 1;
  }

  async get(providerIdentityId: string): Promise<ProviderCredential | null> {
    if (!isNonEmptyString(providerIdentityId)) {
      throw new InvalidProviderCredentialInputError("Provider identity is required");
    }
    const found = await this.db
      .prepare(
        `SELECT
           provider_identity_id, credential_kind, access_token_ciphertext,
           access_expires_at, refresh_token_ciphertext, refresh_expires_at,
           encryption_key_version, row_version, updated_at
         FROM provider_credentials
         WHERE provider_identity_id = ?`
      )
      .bind(providerIdentityId)
      .first<Record<string, unknown>>();
    if (!found) return null;
    const row = decodeProviderCredentialRow(found);

    try {
      const accessToken = await this.cipher.decrypt(
        row.accessTokenCiphertext,
        cipherBinding(
          row.providerIdentityId,
          row.credentialKind,
          "access",
          row.encryptionKeyVersion,
          row.rowVersion
        )
      );
      if (!isNonEmptyString(accessToken)) {
        throw new StoredProviderCredentialCorruptError();
      }
      const metadata = {
        providerIdentityId: row.providerIdentityId,
        accessToken,
        encryptionKeyVersion: row.encryptionKeyVersion,
        rowVersion: row.rowVersion,
        updatedAt: row.updatedAt,
      };
      if (row.credentialKind === "refreshable") {
        const refreshToken = await this.cipher.decrypt(
          row.refreshTokenCiphertext,
          cipherBinding(
            row.providerIdentityId,
            row.credentialKind,
            "refresh",
            row.encryptionKeyVersion,
            row.rowVersion
          )
        );
        if (!isNonEmptyString(refreshToken)) {
          throw new StoredProviderCredentialCorruptError();
        }
        return {
          ...metadata,
          kind: row.credentialKind,
          accessExpiresAt: row.accessExpiresAt,
          refreshToken,
          refreshExpiresAt: row.refreshExpiresAt,
        };
      }
      if (row.credentialKind === "access_only_expiring") {
        return {
          ...metadata,
          kind: row.credentialKind,
          accessExpiresAt: row.accessExpiresAt,
        };
      }
      return { ...metadata, kind: row.credentialKind };
    } catch (error) {
      if (error instanceof ProviderCredentialIntegrityError) {
        throw new StoredProviderCredentialCorruptError();
      }
      throw error;
    }
  }

  async invalidateObservedVersion(
    providerIdentityId: string,
    observedRowVersion: number
  ): Promise<boolean> {
    validateObservedVersion(providerIdentityId, observedRowVersion);
    const result = await this.db
      .prepare(
        `DELETE FROM provider_credentials
         WHERE provider_identity_id = ? AND row_version = ?`
      )
      .bind(providerIdentityId, observedRowVersion)
      .run();
    return result.meta.changes === 1;
  }

  async replaceObservedVersion(
    providerIdentityId: string,
    observedRowVersion: number,
    credential: ProviderCredentialInput
  ): Promise<number> {
    validateObservedVersion(providerIdentityId, observedRowVersion);
    validateInput(providerIdentityId, credential);
    const rowVersion = observedRowVersion + 1;
    const encrypted = await this.encryptCredential(providerIdentityId, credential, rowVersion);
    if (
      !(await this.updateObservedVersion(
        providerIdentityId,
        observedRowVersion,
        rowVersion,
        credential.kind,
        encrypted,
        this.clock.now()
      ))
    ) {
      throw new ProviderCredentialVersionConflictError();
    }
    return rowVersion;
  }
}
