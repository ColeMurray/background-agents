/**
 * Anthropic setup-token OAuth: the authorization-code + PKCE exchange that
 * `claude setup-token` performs, done by the control plane on the
 * deployment owner's behalf.
 *
 * The result is an inference-only token (scope exactly `user:inference`)
 * that does not rotate. The response also carries a short-lived refresh
 * token, which is deliberately never persisted, and the granting account's
 * identity, which is. It is the credential the Claude harness receives at
 * sandbox boot.
 */

const CLAUDE_CODE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/**
 * Hosts exactly as `claude setup-token` (2.1.259) uses them. The consent page
 * is the Claude.ai sign-in (a subscription is required); codes minted for the
 * older claude.ai / console.anthropic.com pair are rejected by the token
 * endpoint as an invalid code.
 */
export const ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
export const ANTHROPIC_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Anthropic's hosted callback shows `code#state` for the user to paste back. */
export const ANTHROPIC_OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const ANTHROPIC_SETUP_TOKEN_SCOPE = "user:inference";
/** What the CLI and Anthropic's documentation state for a setup token's lifetime. */
export const ANTHROPIC_SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
export const ANTHROPIC_EXCHANGE_TIMEOUT_MS = 30_000;
/**
 * The version of the Claude Agent CLI the sandbox runtime ships, bundled with
 * the pinned `claude-agent-sdk`; bump it alongside that pin.
 */
export const CLAUDE_AGENT_CLI_VERSION = "2.1.259";
/**
 * Cloudflare in front of the token endpoint bans generic client signatures
 * (error 1010), and a Worker's outbound fetch carries no User-Agent at all.
 * The exchange presents the same identity the CLI uses on its Anthropic API
 * traffic, so the token is minted and used under one client string.
 */
export const ANTHROPIC_EXCHANGE_USER_AGENT = `claude-cli/${CLAUDE_AGENT_CLI_VERSION} (external, cli)`;

export interface AnthropicAuthorizationRequest {
  authorizationUrl: string;
  /** Never leaves the control plane; encrypted into the transaction row. */
  codeVerifier: string;
  state: string;
}

export interface AnthropicSetupTokenExchange {
  accessToken: string;
  expiresAt: number;
  scope: string;
  /** Anthropic's id for this token; the handle a support request can name. */
  tokenUuid?: string;
  /** The Claude account that granted the token, when the response carries it. */
  account?: { uuid: string; email?: string };
  organization?: { uuid: string; name?: string };
}

export type AnthropicExchangeFailureReason =
  | "invalid_grant"
  | "invalid_request"
  | "scope_mismatch"
  | "malformed_response"
  | "rate_limited"
  | "network"
  | "server_error";

export class AnthropicTokenExchangeError extends Error {
  constructor(
    message: string,
    readonly reason: AnthropicExchangeFailureReason,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AnthropicTokenExchangeError";
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomBase64Url(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Build the consent URL (PKCE S256, 256-bit state, `code=true` for the paste-back page). */
export async function startAnthropicAuthorization(): Promise<AnthropicAuthorizationRequest> {
  const codeVerifier = randomBase64Url(32);
  const state = randomBase64Url(32);
  const url = new URL(ANTHROPIC_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_CODE_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTHROPIC_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", ANTHROPIC_SETUP_TOKEN_SCOPE);
  url.searchParams.set("code_challenge", await pkceChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return { authorizationUrl: url.toString(), codeVerifier, state };
}

/**
 * Split what the user pasted. Anthropic's page shows `code#state`; a bare
 * code is accepted and checked against the transaction's state.
 */
export function parsePastedAuthorizationCode(pasted: string): { code: string; state?: string } {
  const trimmed = pasted.trim();
  const hash = trimmed.indexOf("#");
  if (hash < 0) return { code: trimmed };
  return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) };
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
  scope?: unknown;
  token_uuid?: unknown;
  account?: unknown;
  organization?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `{ uuid, email_address? | name? }` objects as the token endpoint returns them. */
function identityObject(
  value: unknown,
  labelKey: "email_address" | "name"
): { uuid: string; label?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const uuid = nonEmptyString(record.uuid);
  if (!uuid) return undefined;
  return { uuid, label: nonEmptyString(record[labelKey]) };
}

/**
 * Exchange the pasted code for the setup token. Strict on what it accepts:
 * an `access_token`, an expiry (relative or absolute) or the documented
 * one-year default, and the inference scope. A `refresh_token` in the
 * response is ignored, never persisted.
 */
export async function exchangeAnthropicAuthorizationCode(
  input: {
    code: string;
    pastedState?: string;
    expectedState: string;
    codeVerifier: string;
  },
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<AnthropicSetupTokenExchange> {
  if (input.pastedState !== undefined && input.pastedState !== input.expectedState) {
    throw new AnthropicTokenExchangeError(
      "The pasted code belongs to a different authorization attempt",
      "invalid_request"
    );
  }
  let response: Response;
  try {
    response = await fetchImpl(ANTHROPIC_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": ANTHROPIC_EXCHANGE_USER_AGENT,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
        code: input.code,
        state: input.expectedState,
        code_verifier: input.codeVerifier,
        redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
        // setup-token asks for its one-year lifetime explicitly.
        expires_in: Math.floor(ANTHROPIC_SETUP_TOKEN_LIFETIME_MS / 1000),
      }),
      signal: AbortSignal.timeout(ANTHROPIC_EXCHANGE_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new AnthropicTokenExchangeError("Anthropic token exchange failed", "network", {
      cause,
    });
  }

  let body: TokenResponse | null = null;
  try {
    body = (await response.json()) as TokenResponse;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = typeof body?.error === "string" ? body.error : "";
    const description =
      typeof body?.error_description === "string"
        ? body.error_description
        : `HTTP ${response.status}`;
    if (response.status >= 500) {
      throw new AnthropicTokenExchangeError(description, "server_error");
    }
    if (response.status === 429) {
      throw new AnthropicTokenExchangeError(description, "rate_limited");
    }
    throw new AnthropicTokenExchangeError(
      description,
      code === "invalid_grant" ? "invalid_grant" : "invalid_request"
    );
  }
  if (!body || typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new AnthropicTokenExchangeError(
      "Anthropic token response had no access token",
      "malformed_response"
    );
  }
  const scope = typeof body.scope === "string" ? body.scope : "";
  if (!scope.split(/\s+/).includes(ANTHROPIC_SETUP_TOKEN_SCOPE)) {
    throw new AnthropicTokenExchangeError(
      `Anthropic token scope was "${scope}", expected ${ANTHROPIC_SETUP_TOKEN_SCOPE}`,
      "scope_mismatch"
    );
  }
  const account = identityObject(body.account, "email_address");
  const organization = identityObject(body.organization, "name");
  return {
    accessToken: body.access_token,
    expiresAt: normalizeExpiry(body, now),
    scope,
    tokenUuid: nonEmptyString(body.token_uuid),
    account: account ? { uuid: account.uuid, email: account.label } : undefined,
    organization: organization ? { uuid: organization.uuid, name: organization.label } : undefined,
  };
}

function normalizeExpiry(body: TokenResponse, now: number): number {
  if (
    typeof body.expires_in === "number" &&
    Number.isFinite(body.expires_in) &&
    body.expires_in > 0
  ) {
    return now + Math.floor(body.expires_in * 1000);
  }
  if (
    typeof body.expires_at === "number" &&
    Number.isFinite(body.expires_at) &&
    body.expires_at > 0
  ) {
    // Seconds or milliseconds since the epoch; anything before "now" in
    // milliseconds is a seconds value.
    return body.expires_at < now / 10
      ? Math.floor(body.expires_at * 1000)
      : Math.floor(body.expires_at);
  }
  return now + ANTHROPIC_SETUP_TOKEN_LIFETIME_MS;
}
