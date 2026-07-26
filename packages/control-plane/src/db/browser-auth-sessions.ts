import { base64UrlEncode } from "../auth/encoding";
import { hashToken } from "../auth/crypto";
import type { SqlDatabase } from "./sql-database";

export const BROWSER_SESSION_PREFIX = "oi_bsess_";
export const BROWSER_SESSION_IDLE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const BROWSER_SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const BROWSER_SESSION_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const BROWSER_SESSION_CREDENTIAL_PATTERN = /^oi_bsess_[A-Za-z0-9_-]{43}$/;

declare const browserSessionCredentialBrand: unique symbol;
declare const browserSessionIdBrand: unique symbol;

export type BrowserSessionCredential = string & {
  readonly [browserSessionCredentialBrand]: true;
};

export type BrowserSessionId = string & {
  readonly [browserSessionIdBrand]: true;
};

export interface Clock {
  now(): number;
}

export interface BrowserSessionCredentialGenerator {
  generate(): string;
}

export interface BrowserSessionIdGenerator {
  generate(): string;
}

export interface TokenHasher {
  hash(value: string): Promise<string>;
}

export interface BrowserAuthSessionStoreDependencies {
  readonly clock: Clock;
  readonly credentialGenerator: BrowserSessionCredentialGenerator;
  readonly idGenerator: BrowserSessionIdGenerator;
  readonly tokenHasher: TokenHasher;
}

export interface CreateBrowserAuthSessionInput {
  userId: string;
  providerIdentityId: string;
}

export interface CreatedBrowserAuthSession {
  credential: BrowserSessionCredential;
  credentialId: BrowserSessionId;
  expiresAt: number;
  absoluteExpiresAt: number;
}

export interface AuthenticatedBrowserSession {
  credentialId: BrowserSessionId;
  userId: string;
  providerIdentityId: string;
  lastUsedAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
}

export type BrowserSessionRevocationReason = "logout" | "operator" | "provider_identity";

type BrowserAuthSessionRow = {
  id: string;
  client_id: string;
  user_id: string;
  provider_identity_id: string;
  last_used_at: number;
  expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
};

export type BrowserSessionRejection =
  | "malformed"
  | "unknown"
  | "revoked"
  | "idle_expired"
  | "absolute_expired"
  | "corrupt";

export class BrowserSessionAuthenticationError extends Error {
  constructor(readonly rejection: BrowserSessionRejection) {
    super("Browser session is not valid");
    this.name = "BrowserSessionAuthenticationError";
  }
}

function defaultCredential(): string {
  return `${BROWSER_SESSION_PREFIX}${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseBrowserSessionCredential(value: string): BrowserSessionCredential {
  if (!BROWSER_SESSION_CREDENTIAL_PATTERN.test(value)) {
    throw new BrowserSessionAuthenticationError("malformed");
  }
  return value as BrowserSessionCredential;
}

export function parseBrowserSessionId(value: string): BrowserSessionId {
  if (!isNonEmptyString(value)) {
    throw new BrowserSessionAuthenticationError("malformed");
  }
  return value as BrowserSessionId;
}

function decodeBrowserAuthSessionRow(row: BrowserAuthSessionRow): AuthenticatedBrowserSession {
  if (
    !isNonEmptyString(row.id) ||
    row.client_id !== "web" ||
    !isNonEmptyString(row.user_id) ||
    !isNonEmptyString(row.provider_identity_id) ||
    !isFiniteInteger(row.last_used_at) ||
    !isFiniteInteger(row.expires_at) ||
    !isFiniteInteger(row.absolute_expires_at) ||
    (row.revoked_at !== null && !isFiniteInteger(row.revoked_at))
  ) {
    throw new BrowserSessionAuthenticationError("corrupt");
  }

  return {
    credentialId: row.id as BrowserSessionId,
    userId: row.user_id,
    providerIdentityId: row.provider_identity_id,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
  };
}

export class BrowserAuthSessionStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly dependencies: BrowserAuthSessionStoreDependencies
  ) {}

  async create(input: CreateBrowserAuthSessionInput): Promise<CreatedBrowserAuthSession> {
    if (!isNonEmptyString(input.userId) || !isNonEmptyString(input.providerIdentityId)) {
      throw new Error("Browser session requires a user and provider identity");
    }

    const now = this.dependencies.clock.now();
    const generatedCredential = this.dependencies.credentialGenerator.generate();
    if (!BROWSER_SESSION_CREDENTIAL_PATTERN.test(generatedCredential)) {
      throw new Error("Browser session credential generator returned an invalid credential");
    }
    const credential = generatedCredential as BrowserSessionCredential;

    const generatedCredentialId = this.dependencies.idGenerator.generate();
    if (!isNonEmptyString(generatedCredentialId)) {
      throw new Error("Browser session id generator returned an invalid id");
    }
    const credentialId = generatedCredentialId as BrowserSessionId;
    const tokenHash = await this.dependencies.tokenHasher.hash(credential);
    const expiresAt = now + BROWSER_SESSION_IDLE_LIFETIME_MS;
    const absoluteExpiresAt = now + BROWSER_SESSION_ABSOLUTE_LIFETIME_MS;

    const result = await this.db
      .prepare(
        `INSERT INTO browser_auth_sessions (
           id, token_hash, user_id, client_id, provider_identity_id,
           created_at, last_used_at, expires_at, absolute_expires_at,
           revoked_at, revoked_reason
         ) VALUES (?, ?, ?, 'web', ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .bind(
        credentialId,
        tokenHash,
        input.userId,
        input.providerIdentityId,
        now,
        now,
        expiresAt,
        absoluteExpiresAt
      )
      .run();

    if (result.meta.changes !== 1) {
      throw new Error("Browser session was not created");
    }

    return { credential, credentialId, expiresAt, absoluteExpiresAt };
  }

  async authenticate(credential: BrowserSessionCredential): Promise<AuthenticatedBrowserSession> {
    const tokenHash = await this.dependencies.tokenHasher.hash(credential);
    const row = await this.db
      .prepare(
        `SELECT
           id, client_id, user_id, provider_identity_id, last_used_at, expires_at,
           absolute_expires_at, revoked_at
         FROM browser_auth_sessions
         WHERE token_hash = ?`
      )
      .bind(tokenHash)
      .first<BrowserAuthSessionRow>();

    return this.validateAuthenticatedRow(row);
  }

  /**
   * Revalidates a derived credential's parent without retaining or replaying
   * the raw browser bearer.
   */
  async authenticateById(credentialId: BrowserSessionId): Promise<AuthenticatedBrowserSession> {
    const row = await this.db
      .prepare(
        `SELECT
           id, client_id, user_id, provider_identity_id, last_used_at, expires_at,
           absolute_expires_at, revoked_at
         FROM browser_auth_sessions
         WHERE id = ?`
      )
      .bind(credentialId)
      .first<BrowserAuthSessionRow>();

    return this.validateAuthenticatedRow(row);
  }

  async revoke(
    credential: BrowserSessionCredential,
    reason: BrowserSessionRevocationReason
  ): Promise<boolean> {
    const tokenHash = await this.dependencies.tokenHasher.hash(credential);
    const result = await this.db
      .prepare(
        `UPDATE browser_auth_sessions
         SET revoked_at = ?, revoked_reason = ?
         WHERE token_hash = ? AND revoked_at IS NULL`
      )
      .bind(this.dependencies.clock.now(), reason, tokenHash)
      .run();

    return result.meta.changes === 1;
  }

  async revokeById(
    credentialId: BrowserSessionId,
    reason: BrowserSessionRevocationReason
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE browser_auth_sessions
         SET revoked_at = ?, revoked_reason = ?
         WHERE id = ? AND revoked_at IS NULL`
      )
      .bind(this.dependencies.clock.now(), reason, credentialId)
      .run();

    return result.meta.changes === 1;
  }

  async touchQualifyingActivity(credentialId: BrowserSessionId): Promise<void> {
    const now = this.dependencies.clock.now();
    await this.db
      .prepare(
        `UPDATE browser_auth_sessions
         SET last_used_at = ?,
             expires_at = min(?, absolute_expires_at)
         WHERE id = ?
           AND revoked_at IS NULL
           AND expires_at > ?
           AND absolute_expires_at > ?
           AND last_used_at <= ?`
      )
      .bind(
        now,
        now + BROWSER_SESSION_IDLE_LIFETIME_MS,
        credentialId,
        now,
        now,
        now - BROWSER_SESSION_TOUCH_INTERVAL_MS
      )
      .run();
  }

  private validateAuthenticatedRow(row: BrowserAuthSessionRow | null): AuthenticatedBrowserSession {
    if (!row) throw new BrowserSessionAuthenticationError("unknown");
    const session = decodeBrowserAuthSessionRow(row);
    const now = this.dependencies.clock.now();
    if (row.revoked_at !== null) throw new BrowserSessionAuthenticationError("revoked");
    if (session.absoluteExpiresAt <= now) {
      throw new BrowserSessionAuthenticationError("absolute_expired");
    }
    if (session.expiresAt <= now) {
      throw new BrowserSessionAuthenticationError("idle_expired");
    }
    return session;
  }
}

export const defaultBrowserAuthSessionStoreDependencies: BrowserAuthSessionStoreDependencies = {
  clock: { now: () => Date.now() },
  credentialGenerator: { generate: defaultCredential },
  idGenerator: { generate: () => crypto.randomUUID() },
  tokenHasher: { hash: hashToken },
};
