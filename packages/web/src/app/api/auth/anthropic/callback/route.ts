/**
 * Anthropic OAuth callback route (code-paste flow).
 *
 * Accepts a POST with the authorization code that the user copied from
 * Anthropic's code-display page, exchanges it for tokens using PKCE,
 * and stores them securely via the control plane.
 *
 * The pasted code has the format "<auth_code>#<state>". We split on "#"
 * and send both parts to the token endpoint, matching OpenCode's behavior.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

const ANTHROPIC_CLIENT_ID = process.env.ANTHROPIC_CLIENT_ID || "";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!ANTHROPIC_CLIENT_ID) {
    return NextResponse.json({ error: "Anthropic OAuth not configured" }, { status: 503 });
  }

  let rawCode: string;
  let codeVerifier: string;
  try {
    const body = await request.json();
    rawCode = body.code;
    codeVerifier = body.codeVerifier;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!rawCode) {
    return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
  }

  if (!codeVerifier) {
    return NextResponse.json(
      { error: "Missing code verifier. Please restart the connection flow." },
      { status: 400 }
    );
  }

  // The pasted code is "<authorization_code>#<state>" — split on "#"
  const splits = rawCode.split("#");
  const code = splits[0];
  const state = splits[1] || "";

  try {
    // Exchange authorization code for tokens — matches OpenCode's exchange()
    const tokenResponse = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        state,
        client_id: ANTHROPIC_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    });

    const responseText = await tokenResponse.text();
    let data: TokenResponse | Record<string, unknown>;
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error(
        "Token endpoint returned non-JSON:",
        tokenResponse.status,
        responseText.slice(0, 500)
      );
      return NextResponse.json(
        { error: `Token endpoint error (${tokenResponse.status})` },
        { status: 502 }
      );
    }

    if (!tokenResponse.ok || "error" in data) {
      const errorData = data as Record<string, unknown>;
      const errorMsg =
        typeof errorData.error_description === "string"
          ? errorData.error_description
          : typeof errorData.message === "string"
            ? errorData.message
            : typeof errorData.error === "string"
              ? errorData.error
              : "Token exchange failed";
      console.error("Token exchange failed:", JSON.stringify(errorData));
      return NextResponse.json({ error: errorMsg }, { status: 400 });
    }

    const tokens = data as TokenResponse;
    const expiresAt = Date.now() + tokens.expires_in * 1000;

    // Store tokens via control plane (uses HMAC auth)
    if (session.user.id) {
      const storeResponse = await controlPlaneFetch("/internal/anthropic-token", {
        method: "POST",
        body: JSON.stringify({
          userId: session.user.id,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt,
        }),
      });

      if (!storeResponse.ok) {
        console.error("Failed to store Anthropic tokens:", await storeResponse.text());
        return NextResponse.json({ error: "Failed to store tokens" }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error in Anthropic OAuth callback:", message, err);
    return NextResponse.json({ error: `Token exchange error: ${message}` }, { status: 500 });
  }
}
