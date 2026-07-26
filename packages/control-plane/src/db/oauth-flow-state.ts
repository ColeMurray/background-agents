import { AuthCiphertextIntegrityError } from "../auth/terminal-encryption";
import { isPkceS256Challenge, isPkceVerifier } from "../auth/pkce";
import type { Clock, TokenHasher } from "./browser-auth-sessions";
import type { SqlDatabase } from "./sql-database";

export const OAUTH_FLOW_LIFETIME_MS = 10 * 60 * 1000;
export const OAUTH_FLOW_KEY_VERSION = 1;

const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export type OAuthProvider = "github" | "google";

export interface OAuthFlowVerifierBinding {
  flowId: string;
  provider: OAuthProvider;
  keyVersion: number;
}

export interface OAuthFlowVerifierCipher {
  encrypt(plaintext: string, binding: OAuthFlowVerifierBinding): Promise<string>;
  decrypt(ciphertext: string, binding: OAuthFlowVerifierBinding): Promise<string>;
}

export interface OAuthFlowStateStoreDependencies {
  readonly clock: Clock;
  readonly idGenerator: { generate(): string };
  readonly tokenHasher: TokenHasher;
}

export interface CreateOAuthFlowStateInput {
  state: string;
  provider: OAuthProvider;
  clientId: "web";
  redirectUri: string;
  clientCodeChallenge: string;
  providerPkceVerifier: string;
  oidcNonce?: string;
}

export interface ConsumedOAuthFlowState {
  flowId: string;
  provider: OAuthProvider;
  clientId: "web";
  redirectUri: string;
  clientCodeChallenge: string;
  providerPkceVerifier: string;
  oidcNonceHash: string | null;
}

type OAuthFlowRow = {
  id: string;
  provider: OAuthProvider;
  clientId: "web";
  redirectUri: string;
  clientCodeChallenge: string;
  providerPkceVerifierCiphertext: string;
  providerPkceKeyVersion: number;
  oidcNonceHash: string | null;
  expiresAt: number;
  consumedAt: number | null;
};

export type OAuthFlowStateRejection =
  | "malformed"
  | "unknown"
  | "provider_mismatch"
  | "expired"
  | "already_consumed"
  | "race_lost"
  | "corrupt";

export class OAuthFlowStateConsumptionError extends Error {
  constructor(readonly rejection: OAuthFlowStateRejection) {
    super("OAuth flow state is not valid");
    this.name = "OAuthFlowStateConsumptionError";
  }
}

export class InvalidOAuthFlowStateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOAuthFlowStateInputError";
  }
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodeOAuthFlowRow(value: unknown): OAuthFlowRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthFlowStateConsumptionError("corrupt");
  }
  const row = value as Record<string, unknown>;
  if (
    !isNonEmptyString(row.id) ||
    (row.provider !== "github" && row.provider !== "google") ||
    row.client_id !== "web" ||
    !isNonEmptyString(row.redirect_uri) ||
    !isPkceS256Challenge(row.client_code_challenge) ||
    !isNonEmptyString(row.provider_pkce_verifier_ciphertext) ||
    row.provider_pkce_key_version !== OAUTH_FLOW_KEY_VERSION ||
    !isFiniteInteger(row.expires_at) ||
    (row.consumed_at !== null && !isFiniteInteger(row.consumed_at))
  ) {
    throw new OAuthFlowStateConsumptionError("corrupt");
  }

  let oidcNonceHash: string | null;
  if (row.provider === "github") {
    if (row.oidc_nonce_hash !== null) {
      throw new OAuthFlowStateConsumptionError("corrupt");
    }
    oidcNonceHash = null;
  } else {
    if (typeof row.oidc_nonce_hash !== "string" || !/^[0-9a-f]{64}$/.test(row.oidc_nonce_hash)) {
      throw new OAuthFlowStateConsumptionError("corrupt");
    }
    oidcNonceHash = row.oidc_nonce_hash;
  }

  return {
    id: row.id,
    provider: row.provider,
    clientId: "web",
    redirectUri: row.redirect_uri,
    clientCodeChallenge: row.client_code_challenge,
    providerPkceVerifierCiphertext: row.provider_pkce_verifier_ciphertext,
    providerPkceKeyVersion: row.provider_pkce_key_version,
    oidcNonceHash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

function validateCreateInput(input: CreateOAuthFlowStateInput): void {
  if (!OPAQUE_VALUE_PATTERN.test(input.state)) {
    throw new InvalidOAuthFlowStateInputError("OAuth state is malformed");
  }
  if (
    input.clientId !== "web" ||
    !isNonEmptyString(input.redirectUri) ||
    !isPkceS256Challenge(input.clientCodeChallenge) ||
    !isPkceVerifier(input.providerPkceVerifier)
  ) {
    throw new InvalidOAuthFlowStateInputError("OAuth flow binding is malformed");
  }
  if (input.provider === "google" && !OPAQUE_VALUE_PATTERN.test(input.oidcNonce ?? "")) {
    throw new InvalidOAuthFlowStateInputError("Google OAuth flows require a valid OIDC nonce");
  }
  if (input.provider === "github" && input.oidcNonce !== undefined) {
    throw new InvalidOAuthFlowStateInputError("GitHub OAuth flows cannot carry an OIDC nonce");
  }
}

export class OAuthFlowStateStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly verifierCipher: OAuthFlowVerifierCipher,
    private readonly dependencies: OAuthFlowStateStoreDependencies
  ) {}

  async create(input: CreateOAuthFlowStateInput): Promise<{ flowId: string }> {
    validateCreateInput(input);
    const flowId = this.dependencies.idGenerator.generate();
    if (!isNonEmptyString(flowId)) {
      throw new Error("OAuth flow id generator returned an invalid id");
    }

    const now = this.dependencies.clock.now();
    const binding: OAuthFlowVerifierBinding = {
      flowId,
      provider: input.provider,
      keyVersion: OAUTH_FLOW_KEY_VERSION,
    };
    const [stateHash, verifierCiphertext, oidcNonceHash] = await Promise.all([
      this.dependencies.tokenHasher.hash(input.state),
      this.verifierCipher.encrypt(input.providerPkceVerifier, binding),
      input.oidcNonce ? this.dependencies.tokenHasher.hash(input.oidcNonce) : Promise.resolve(null),
    ]);

    const result = await this.db
      .prepare(
        `INSERT INTO oauth_flow_state (
           id, state_hash, provider, client_id, redirect_uri,
           client_code_challenge, provider_pkce_verifier_ciphertext,
           provider_pkce_key_version, oidc_nonce_hash,
           created_at, expires_at, consumed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .bind(
        flowId,
        stateHash,
        input.provider,
        input.clientId,
        input.redirectUri,
        input.clientCodeChallenge,
        verifierCiphertext,
        OAUTH_FLOW_KEY_VERSION,
        oidcNonceHash,
        now,
        now + OAUTH_FLOW_LIFETIME_MS
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error("OAuth flow state was not created");
    }
    return { flowId };
  }

  async consume(state: string, expectedProvider: OAuthProvider): Promise<ConsumedOAuthFlowState> {
    if (!OPAQUE_VALUE_PATTERN.test(state)) {
      throw new OAuthFlowStateConsumptionError("malformed");
    }

    const stateHash = await this.dependencies.tokenHasher.hash(state);
    const found = await this.db
      .prepare(
        `SELECT
           id, provider, client_id, redirect_uri, client_code_challenge,
           provider_pkce_verifier_ciphertext, provider_pkce_key_version,
           oidc_nonce_hash, expires_at, consumed_at
         FROM oauth_flow_state
         WHERE state_hash = ?`
      )
      .bind(stateHash)
      .first<Record<string, unknown>>();
    if (!found) throw new OAuthFlowStateConsumptionError("unknown");

    const row = decodeOAuthFlowRow(found);
    if (row.provider !== expectedProvider) {
      throw new OAuthFlowStateConsumptionError("provider_mismatch");
    }
    if (row.consumedAt !== null) {
      throw new OAuthFlowStateConsumptionError("already_consumed");
    }
    const now = this.dependencies.clock.now();
    if (row.expiresAt <= now) {
      throw new OAuthFlowStateConsumptionError("expired");
    }

    let providerPkceVerifier: string;
    try {
      providerPkceVerifier = await this.verifierCipher.decrypt(row.providerPkceVerifierCiphertext, {
        flowId: row.id,
        provider: row.provider,
        keyVersion: row.providerPkceKeyVersion,
      });
    } catch (error) {
      if (error instanceof AuthCiphertextIntegrityError) {
        throw new OAuthFlowStateConsumptionError("corrupt");
      }
      throw error;
    }
    if (!isPkceVerifier(providerPkceVerifier)) {
      throw new OAuthFlowStateConsumptionError("corrupt");
    }

    const consumed = await this.db
      .prepare(
        `UPDATE oauth_flow_state
         SET consumed_at = ?
         WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`
      )
      .bind(now, row.id, now)
      .run();
    if (consumed.meta.changes !== 1) {
      await this.throwCurrentRejection(row.id, now);
    }

    return {
      flowId: row.id,
      provider: row.provider,
      clientId: row.clientId,
      redirectUri: row.redirectUri,
      clientCodeChallenge: row.clientCodeChallenge,
      providerPkceVerifier,
      oidcNonceHash: row.oidcNonceHash,
    };
  }

  private async throwCurrentRejection(flowId: string, now: number): Promise<never> {
    const current = await this.db
      .prepare("SELECT consumed_at, expires_at FROM oauth_flow_state WHERE id = ?")
      .bind(flowId)
      .first<Record<string, unknown>>();
    if (!current) {
      throw new OAuthFlowStateConsumptionError("race_lost");
    }
    if (
      (current.consumed_at !== null && !isFiniteInteger(current.consumed_at)) ||
      !isFiniteInteger(current.expires_at)
    ) {
      throw new OAuthFlowStateConsumptionError("corrupt");
    }
    if (current.consumed_at !== null) {
      throw new OAuthFlowStateConsumptionError("already_consumed");
    }
    if (current.expires_at <= now) {
      throw new OAuthFlowStateConsumptionError("expired");
    }
    throw new OAuthFlowStateConsumptionError("race_lost");
  }
}
