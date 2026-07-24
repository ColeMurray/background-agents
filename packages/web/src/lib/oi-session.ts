/**
 * Web session tokens (`oi_at_`/`oi_rt_`): the CP-issued user credential that
 * replaces asserted body identity.
 *
 * Sign-in exchanges the user's provider token — while it is in scope in the
 * NextAuth jwt callback — for a token pair minted only after the control
 * plane verifies the subject with the provider. Renewal is a rotating
 * refresh grant; provider evidence is never needed again. Exchange and
 * refresh calls are signed with web's sig1 service credential.
 */

import { getToken, type JWT } from "next-auth/jwt";
import { z } from "zod";
import type { Account } from "next-auth";

import { controlPlaneServiceFetch } from "@/lib/control-plane-transport";
import { createLogger } from "@/lib/logger";

const log = createLogger("oi-session");

/** Renew when the access token expires within this window. */
export const OI_ACCESS_TOKEN_RENEW_WINDOW_MS = 15 * 60 * 1000;

/** Don't attach an access token that is about to expire mid-request. */
const OI_ACCESS_TOKEN_ATTACH_SLACK_MS = 60 * 1000;

const tokenPairSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAtEpochMs: z.number().int().positive(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAtEpochMs: z.number().int().positive(),
});

type WebSessionTokenPair = z.infer<typeof tokenPairSchema>;

async function postTokenEndpoint(
  path: "/auth/tokens/exchange" | "/auth/tokens/refresh",
  body: Record<string, unknown>
): Promise<{ ok: true; pair: WebSessionTokenPair } | { ok: false; status: number; error: string }> {
  const response = await controlPlaneServiceFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : `http_${response.status}`;
    return { ok: false, status: response.status, error };
  }
  const parsed = tokenPairSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, status: response.status, error: "invalid_token_pair_response" };
  }
  return { ok: true, pair: parsed.data };
}

/**
 * Exchange the provider credential captured at sign-in for a web session
 * token pair. Returns null on any failure (`auth.exchange_fallback`) — the
 * caller leaves the `oi*` JWT fields unset, so requests carry web's userless
 * service credential and identity-minting routes fail closed (403) until the
 * user signs in again.
 */
async function exchangeForWebSessionTokens(params: {
  provider: "github" | "google";
  subjectToken: string;
  scmRefreshToken?: string;
  scmTokenExpiresAt?: number;
}): Promise<WebSessionTokenPair | null> {
  try {
    const result = await postTokenEndpoint("/auth/tokens/exchange", {
      subjectTokenType:
        params.provider === "github" ? "github-access-token" : "google-access-token",
      subjectToken: params.subjectToken,
      ...(params.scmRefreshToken ? { scmRefreshToken: params.scmRefreshToken } : {}),
      ...(params.scmTokenExpiresAt ? { scmTokenExpiresAt: params.scmTokenExpiresAt } : {}),
    });
    if (!result.ok) {
      log.warn("oi_session.exchange_fallback", {
        event: "auth.exchange_fallback",
        provider: params.provider,
        http_status: result.status,
        reason: result.error,
      });
      return null;
    }
    return result.pair;
  } catch (error) {
    log.warn("oi_session.exchange_fallback", {
      event: "auth.exchange_fallback",
      provider: params.provider,
      reason: "request_failed",
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return null;
  }
}

type RefreshOutcome =
  | { ok: true; pair: WebSessionTokenPair }
  | {
      ok: false;
      reason:
        | "invalid_refresh_token"
        | "refresh_superseded"
        | "refresh_reuse_detected"
        | "request_failed";
    };

/** Redeem the rotating refresh grant for a new pair. */
async function redeemWebSessionRefresh(refreshToken: string): Promise<RefreshOutcome> {
  try {
    const result = await postTokenEndpoint("/auth/tokens/refresh", { refreshToken });
    if (result.ok) {
      return { ok: true, pair: result.pair };
    }
    return {
      ok: false,
      reason:
        result.error === "invalid_refresh_token" ||
        result.error === "refresh_superseded" ||
        result.error === "refresh_reuse_detected"
          ? result.error
          : "request_failed",
    };
  } catch {
    return { ok: false, reason: "request_failed" };
  }
}

/**
 * Read the current request's NextAuth JWT and return a live web session
 * token, or null when none is attached (userless calls, pre-exchange
 * sessions, non-request contexts). Read-only — renewal happens in the jwt
 * callback, never here.
 */
export async function getOiAccessTokenFromCookies(): Promise<string | null> {
  let cookiePairs: Record<string, string>;
  try {
    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    cookiePairs = Object.fromEntries(
      cookieStore.getAll().map((cookie) => [cookie.name, cookie.value])
    );
  } catch {
    // Not in a request context (build, background work) — no user identity.
    return null;
  }
  if (Object.keys(cookiePairs).length === 0) return null;
  return readOiAccessTokenFromCookiePairs(cookiePairs);
}

/**
 * Decode the NextAuth JWT from parsed cookie pairs and return a live web
 * session token. `getToken` reads `req.cookies` only — it never parses a
 * `headers.cookie` string — so the request stub must carry the parsed pairs
 * (this also lets next-auth reassemble chunked session cookies).
 */
export async function readOiAccessTokenFromCookiePairs(
  cookiePairs: Record<string, string>
): Promise<string | null> {
  try {
    const token = await getToken({
      req: { headers: {}, cookies: cookiePairs } as Parameters<typeof getToken>[0]["req"],
    });
    return getLiveOiAccessToken(token);
  } catch (error) {
    log.warn("oi_session.jwt_read_failed", {
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return null;
  }
}

/** The JWT's access token when present and not about to expire, else null. */
export function getLiveOiAccessToken(token: JWT | null): string | null {
  if (!token?.oiAccessToken || !token.oiAccessTokenExpiresAt) return null;
  if (token.oiAccessTokenExpiresAt - Date.now() <= OI_ACCESS_TOKEN_ATTACH_SLACK_MS) {
    return null;
  }
  return token.oiAccessToken;
}

/**
 * Set the `oi*` JWT fields at sign-in — the only moment provider evidence
 * exists — by exchanging the provider credential for a token pair. Runs in
 * the NextAuth jwt callback, whose cookie the sign-in flow persists.
 *
 * Renewal deliberately does NOT happen here: the jwt callback also runs
 * under `getServerSession`, which cannot persist a rotated cookie — a
 * renewal there would consume the rotating refresh grant and orphan the
 * cookie's copy. Renewal lives in the `/api/auth/oi-refresh` route handler
 * (`renewOiSessionTokens`), which the client invokes and which CAN persist.
 */
export async function applyOiSessionTokens(
  token: JWT,
  account: Account | null | undefined
): Promise<JWT> {
  if (!account) {
    return token;
  }
  if ((account.provider === "github" || account.provider === "google") && account.access_token) {
    const pair = await exchangeForWebSessionTokens({
      provider: account.provider,
      subjectToken: account.access_token,
      scmRefreshToken: account.provider === "github" ? account.refresh_token : undefined,
      scmTokenExpiresAt: account.expires_at ? account.expires_at * 1000 : undefined,
    });
    setOiFields(token, pair);
  } else {
    setOiFields(token, null);
  }
  return token;
}

/**
 * Renew the `oi*` fields on a decoded JWT via the rotating refresh grant,
 * mutating the token in place. Returns whether the token changed — a change
 * (rotated pair, or fields cleared because the grant is dead) MUST be
 * persisted by the caller, so this is only called from contexts that can
 * write the session cookie (the oi-refresh route handler).
 */
export async function renewOiSessionTokens(token: JWT): Promise<{ changed: boolean }> {
  const { oiAccessToken, oiAccessTokenExpiresAt, oiRefreshToken } = token;
  if (!oiAccessToken || !oiAccessTokenExpiresAt || !oiRefreshToken) {
    return { changed: false };
  }
  if (oiAccessTokenExpiresAt - Date.now() > OI_ACCESS_TOKEN_RENEW_WINDOW_MS) {
    return { changed: false };
  }

  const outcome = await redeemWebSessionRefresh(oiRefreshToken);
  if (outcome.ok) {
    setOiFields(token, outcome.pair);
    return { changed: true };
  }
  log.warn("oi_session.refresh_failed", {
    event: "auth.refresh_failed",
    reason: outcome.reason,
  });
  switch (outcome.reason) {
    case "request_failed":
      // Transient failure: keep the fields and retry on a later ping.
      return { changed: false };
    case "refresh_superseded":
      // A concurrent renewal won (CP grace window): the cookie jar already
      // holds the winner's fresh pair — never persist over it. The CP makes
      // this call from row state; it must NOT be inferred here from access-
      // token freshness (at wake-from-idle the access token is always
      // expired, and clearing on a lost race wiped a live identity — the
      // 2026-07-24 prod incident).
      return { changed: false };
    case "invalid_refresh_token":
      // The grant is genuinely dead (unknown, revoked, or expired) — clear
      // the fields, and persist the cleared state so later pings stop
      // replaying a dead grant (re-login required).
      setOiFields(token, null);
      return { changed: true };
    case "refresh_reuse_detected":
      // Rotation reuse is the token-theft signal — always clear the fields
      // (re-login required).
      setOiFields(token, null);
      return { changed: true };
    default: {
      const exhaustive: never = outcome.reason;
      throw new Error(`Unhandled refresh outcome: ${String(exhaustive)}`);
    }
  }
}

function setOiFields(token: JWT, pair: WebSessionTokenPair | null): void {
  token.oiAccessToken = pair?.accessToken;
  token.oiAccessTokenExpiresAt = pair?.accessTokenExpiresAtEpochMs;
  token.oiRefreshToken = pair?.refreshToken;
}
