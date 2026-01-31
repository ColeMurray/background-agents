/**
 * Anthropic OAuth initiation route (PKCE code-paste flow).
 *
 * Returns an authorization URL for the frontend to open in a new tab.
 * Uses Anthropic's code-display callback so the user copies a code
 * and pastes it back into the web UI.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Anthropic OAuth configuration
const ANTHROPIC_CLIENT_ID = process.env.ANTHROPIC_CLIENT_ID || "";
const ANTHROPIC_AUTHORIZE_URL = "https://console.anthropic.com/oauth/authorize";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

/**
 * Generate a PKCE code verifier: 64 random bytes, base64url-encoded.
 * Matches the openauth/opencode implementation.
 */
function generateCodeVerifier(): string {
  const buffer = new Uint8Array(64);
  crypto.getRandomValues(buffer);
  // base64url encode
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate code challenge from verifier using SHA-256.
 * Returns base64url-encoded hash.
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return new Response("Unauthorized - must be logged in", { status: 401 });
  }

  if (!ANTHROPIC_CLIENT_ID) {
    return new Response("Anthropic OAuth not configured", { status: 503 });
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Build authorization URL — matches OpenCode's authorize() exactly
  const authUrl = new URL(ANTHROPIC_AUTHORIZE_URL);
  authUrl.searchParams.set("code", "true");
  authUrl.searchParams.set("client_id", ANTHROPIC_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", "org:create_api_key user:profile user:inference");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  // OpenCode sets state to the verifier itself
  authUrl.searchParams.set("state", codeVerifier);

  return NextResponse.json({
    authorizeUrl: authUrl.toString(),
    codeVerifier,
  });
}
