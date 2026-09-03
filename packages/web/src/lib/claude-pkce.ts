export const CLAUDE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const CLAUDE_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

type FillRandom = (bytes: Uint8Array) => Uint8Array;
type Digest = (data: Uint8Array) => Promise<ArrayBuffer>;

export type ClaudePkce = {
  codeVerifier: string;
  state: string;
  codeChallenge: string;
  authorizationUrl: string;
};

export type ClaudeAuthorizationResponse = {
  authorizationCode: string;
  state: string;
};

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function randomBase64Url(byteLength: number, fillRandom: FillRandom = browserFillRandom) {
  return base64UrlEncode(fillRandom(new Uint8Array(byteLength)));
}

export async function deriveS256Challenge(
  codeVerifier: string,
  digest: Digest = browserSha256
): Promise<string> {
  return base64UrlEncode(new Uint8Array(await digest(new TextEncoder().encode(codeVerifier))));
}

export function buildClaudeAuthorizationUrl(codeChallenge: string, state: string): string {
  const url = new URL(CLAUDE_AUTHORIZE_URL);
  url.searchParams.set("client_id", CLAUDE_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_REDIRECT_URI);
  url.searchParams.set("scope", CLAUDE_SCOPES);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("code", "true");
  return url.toString();
}

export async function createClaudePkce(
  fillRandom: FillRandom = browserFillRandom
): Promise<ClaudePkce> {
  const codeVerifier = randomBase64Url(32, fillRandom);
  const state = randomBase64Url(32, fillRandom);
  const codeChallenge = await deriveS256Challenge(codeVerifier);
  return {
    codeVerifier,
    state,
    codeChallenge,
    authorizationUrl: buildClaudeAuthorizationUrl(codeChallenge, state),
  };
}

export function parseClaudeAuthorizationResponse(input: string): ClaudeAuthorizationResponse {
  const value = input.trim();
  if (!value) throw new Error("Paste the authorization response from Claude.");

  let authorizationCode: string | null = null;
  let state: string | null = null;

  try {
    const url = new URL(value);
    authorizationCode = url.searchParams.get("code");
    state = url.searchParams.get("state");

    const fragment = new URLSearchParams(url.hash.slice(1));
    authorizationCode ??= fragment.get("code");
    state ??= fragment.get("state");
  } catch {
    const separator = value.indexOf("#");
    if (separator >= 0) {
      authorizationCode = decodeComponent(value.slice(0, separator));
      state = decodeComponent(value.slice(separator + 1));
    }
  }

  if (!authorizationCode) throw new Error("The authorization response is missing a code.");
  if (!state) throw new Error("The authorization response is missing state.");
  return { authorizationCode, state };
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function browserFillRandom(bytes: Uint8Array): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure browser crypto is unavailable.");
  return globalThis.crypto.getRandomValues(bytes);
}

async function browserSha256(data: Uint8Array): Promise<ArrayBuffer> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure browser crypto is unavailable.");
  return globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(data).buffer);
}
