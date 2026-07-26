import { timingSafeEqual } from "@open-inspect/shared";
import {
  InvalidPkceVerifierError,
  createPkceS256Challenge,
  isPkceS256Challenge,
} from "../auth/pkce";
import {
  BROWSER_SESSION_ABSOLUTE_LIFETIME_MS,
  BROWSER_SESSION_IDLE_LIFETIME_MS,
  parseBrowserSessionCredential,
  parseBrowserSessionId,
  type Clock,
  type CreatedBrowserAuthSession,
  type TokenHasher,
} from "./browser-auth-sessions";
import type { SqlDatabase } from "./sql-database";

export const OAUTH_AUTHORIZATION_CODE_LIFETIME_MS = 60 * 1000;

const AUTHORIZATION_CODE_PATTERN = /^oi_code_[A-Za-z0-9_-]{43}$/;

export interface OAuthAuthorizationCodeStoreDependencies {
  readonly clock: Clock;
  readonly tokenHasher: TokenHasher;
  readonly authorizationCodeGenerator: { generate(): string };
  readonly browserCredentialGenerator: { generate(): string };
  readonly idGenerator: { generate(): string };
}

export interface IssueOAuthAuthorizationCodeInput {
  userId: string;
  providerIdentityId: string;
  clientId: "web";
  redirectUri: string;
  codeChallenge: string;
}

export interface RedeemOAuthAuthorizationCodeInput {
  code: string;
  clientId: "web";
  redirectUri: string;
  codeVerifier: string;
}

type AuthorizationCodeRow = {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
  consumed_at: number | null;
};

export type OAuthAuthorizationCodeRejection =
  | "malformed"
  | "unknown"
  | "binding_mismatch"
  | "pkce_failed"
  | "expired"
  | "already_consumed"
  | "race_lost"
  | "corrupt";

export class OAuthAuthorizationCodeRedemptionError extends Error {
  constructor(readonly rejection: OAuthAuthorizationCodeRejection) {
    super("OAuth authorization code is not valid");
    this.name = "OAuthAuthorizationCodeRedemptionError";
  }
}

export class InvalidOAuthAuthorizationCodeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOAuthAuthorizationCodeInputError";
  }
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodeAuthorizationCodeRow(value: unknown): AuthorizationCodeRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthAuthorizationCodeRedemptionError("corrupt");
  }
  const row = value as Record<string, unknown>;
  if (
    !isNonEmptyString(row.id) ||
    row.client_id !== "web" ||
    !isNonEmptyString(row.redirect_uri) ||
    !isPkceS256Challenge(row.code_challenge) ||
    !isFiniteInteger(row.expires_at) ||
    (row.consumed_at !== null && !isFiniteInteger(row.consumed_at))
  ) {
    throw new OAuthAuthorizationCodeRedemptionError("corrupt");
  }
  return {
    id: row.id,
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    code_challenge: row.code_challenge,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
  };
}

function validateIssueInput(input: IssueOAuthAuthorizationCodeInput): void {
  if (
    !isNonEmptyString(input.userId) ||
    !isNonEmptyString(input.providerIdentityId) ||
    input.clientId !== "web" ||
    !isNonEmptyString(input.redirectUri) ||
    !isPkceS256Challenge(input.codeChallenge)
  ) {
    throw new InvalidOAuthAuthorizationCodeInputError(
      "OAuth authorization code binding is malformed"
    );
  }
}

export class OAuthAuthorizationCodeStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly dependencies: OAuthAuthorizationCodeStoreDependencies
  ) {}

  async issue(
    input: IssueOAuthAuthorizationCodeInput
  ): Promise<{ code: string; expiresAt: number }> {
    validateIssueInput(input);
    const code = this.dependencies.authorizationCodeGenerator.generate();
    if (!AUTHORIZATION_CODE_PATTERN.test(code)) {
      throw new Error("OAuth authorization code generator returned an invalid code");
    }
    const codeId = this.dependencies.idGenerator.generate();
    if (!isNonEmptyString(codeId)) {
      throw new Error("OAuth authorization code id generator returned an invalid id");
    }

    const now = this.dependencies.clock.now();
    const expiresAt = now + OAUTH_AUTHORIZATION_CODE_LIFETIME_MS;
    const codeHash = await this.dependencies.tokenHasher.hash(code);
    const result = await this.db
      .prepare(
        `INSERT INTO oauth_authorization_codes (
           id, code_hash, user_id, provider_identity_id, client_id,
           redirect_uri, code_challenge, created_at, expires_at,
           consumed_at, consumed_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .bind(
        codeId,
        codeHash,
        input.userId,
        input.providerIdentityId,
        input.clientId,
        input.redirectUri,
        input.codeChallenge,
        now,
        expiresAt
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error("OAuth authorization code was not created");
    }
    return { code, expiresAt };
  }

  async redeem(input: RedeemOAuthAuthorizationCodeInput): Promise<CreatedBrowserAuthSession> {
    if (!AUTHORIZATION_CODE_PATTERN.test(input.code)) {
      throw new OAuthAuthorizationCodeRedemptionError("malformed");
    }

    let presentedChallenge: string;
    try {
      presentedChallenge = await createPkceS256Challenge(input.codeVerifier);
    } catch (error) {
      if (error instanceof InvalidPkceVerifierError) {
        throw new OAuthAuthorizationCodeRedemptionError("pkce_failed");
      }
      throw error;
    }

    const codeHash = await this.dependencies.tokenHasher.hash(input.code);
    const found = await this.db
      .prepare(
        `SELECT
           id, client_id, redirect_uri, code_challenge, expires_at, consumed_at
         FROM oauth_authorization_codes
         WHERE code_hash = ?`
      )
      .bind(codeHash)
      .first<Record<string, unknown>>();
    if (!found) throw new OAuthAuthorizationCodeRedemptionError("unknown");

    const row = decodeAuthorizationCodeRow(found);
    if (row.client_id !== input.clientId || row.redirect_uri !== input.redirectUri) {
      throw new OAuthAuthorizationCodeRedemptionError("binding_mismatch");
    }
    if (!timingSafeEqual(row.code_challenge, presentedChallenge)) {
      throw new OAuthAuthorizationCodeRedemptionError("pkce_failed");
    }
    if (row.consumed_at !== null) {
      throw new OAuthAuthorizationCodeRedemptionError("already_consumed");
    }

    const now = this.dependencies.clock.now();
    if (row.expires_at <= now) {
      throw new OAuthAuthorizationCodeRedemptionError("expired");
    }

    const credential = parseBrowserSessionCredential(
      this.dependencies.browserCredentialGenerator.generate()
    );
    const credentialId = parseBrowserSessionId(this.dependencies.idGenerator.generate());
    const credentialHash = await this.dependencies.tokenHasher.hash(credential);
    const expiresAt = now + BROWSER_SESSION_IDLE_LIFETIME_MS;
    const absoluteExpiresAt = now + BROWSER_SESSION_ABSOLUTE_LIFETIME_MS;

    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE oauth_authorization_codes
           SET consumed_at = ?, consumed_by = ?
           WHERE code_hash = ?
             AND client_id = ?
             AND redirect_uri = ?
             AND consumed_at IS NULL
             AND expires_at > ?`
        )
        .bind(now, credentialId, codeHash, input.clientId, input.redirectUri, now),
      this.db
        .prepare(
          `INSERT INTO browser_auth_sessions (
             id, token_hash, user_id, client_id, provider_identity_id,
             created_at, last_used_at, expires_at, absolute_expires_at,
             revoked_at, revoked_reason
           )
           SELECT
             ?, ?, user_id, 'web', provider_identity_id,
             ?, ?, ?, ?, NULL, NULL
           FROM oauth_authorization_codes
           WHERE code_hash = ?
             AND consumed_by = ?
             AND consumed_at = ?`
        )
        .bind(
          credentialId,
          credentialHash,
          now,
          now,
          expiresAt,
          absoluteExpiresAt,
          codeHash,
          credentialId,
          now
        ),
    ]);
    const [consumeResult, sessionResult] = results;
    if (!consumeResult || !sessionResult) {
      throw new Error("OAuth authorization code redemption batch returned an invalid result");
    }

    if (consumeResult.meta.changes === 0 && sessionResult.meta.changes === 0) {
      return this.throwCurrentRejection(codeHash, now);
    }
    if (consumeResult.meta.changes !== 1 || sessionResult.meta.changes !== 1) {
      throw new Error("OAuth authorization code redemption batch violated its result invariant");
    }
    return { credential, credentialId, expiresAt, absoluteExpiresAt };
  }

  private async throwCurrentRejection(codeHash: string, now: number): Promise<never> {
    const current = await this.db
      .prepare(
        `SELECT consumed_at, expires_at
         FROM oauth_authorization_codes
         WHERE code_hash = ?`
      )
      .bind(codeHash)
      .first<Record<string, unknown>>();
    if (!current) throw new OAuthAuthorizationCodeRedemptionError("race_lost");
    if (
      (current.consumed_at !== null && !isFiniteInteger(current.consumed_at)) ||
      !isFiniteInteger(current.expires_at)
    ) {
      throw new OAuthAuthorizationCodeRedemptionError("corrupt");
    }
    if (current.consumed_at !== null) {
      throw new OAuthAuthorizationCodeRedemptionError("already_consumed");
    }
    if (current.expires_at <= now) {
      throw new OAuthAuthorizationCodeRedemptionError("expired");
    }
    throw new OAuthAuthorizationCodeRedemptionError("race_lost");
  }
}
