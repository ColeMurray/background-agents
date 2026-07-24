/**
 * Client-invoked renewal of the web session token pair (`oi_at_`/`oi_rt_`).
 *
 * This is the ONLY place the rotating refresh grant is redeemed. NextAuth v4's
 * jwt callback also runs under `getServerSession`, which cannot persist a
 * rotated cookie — redeeming there would orphan the cookie's refresh token —
 * so renewal lives in this route handler, which re-encodes the session JWT
 * and writes it back (chunk-aware) in the same response.
 *
 * The client pings this route on mount, on window focus, and on an interval
 * comfortably inside the renew window (see `OiSessionRefresh`). Concurrent
 * pings from multiple tabs are safe: the control plane's refresh-reuse grace
 * window makes the losing redeem benign, and `renewOiSessionTokens` keeps a
 * still-valid access token in that case.
 */

import { NextResponse } from "next/server";
import { getToken, encode } from "next-auth/jwt";
import { cookies } from "next/headers";
import { createLogger } from "@/lib/logger";
import { renewOiSessionTokens } from "@/lib/oi-session";
import { SESSION_COOKIE_MAX_AGE_SECONDS, writeSessionCookie } from "@/lib/session-cookie";

const log = createLogger("oi-refresh");

export async function POST(): Promise<NextResponse> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    log.error("oi_refresh.misconfigured", { reason: "NEXTAUTH_SECRET not configured" });
    return NextResponse.json({ error: "Auth not configured" }, { status: 500 });
  }

  const cookieStore = await cookies();
  const cookiePairs = Object.fromEntries(
    cookieStore.getAll().map((cookie) => [cookie.name, cookie.value])
  );
  // getToken reads req.cookies only — pass the parsed pairs so chunked
  // session cookies reassemble (same contract as oi-session's reader).
  const token = await getToken({
    req: { headers: {}, cookies: cookiePairs } as Parameters<typeof getToken>[0]["req"],
  });
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { changed } = await renewOiSessionTokens(token);
  if (changed) {
    const encoded = await encode({ token, secret, maxAge: SESSION_COOKIE_MAX_AGE_SECONDS });
    writeSessionCookie(cookieStore, encoded);
  }

  return NextResponse.json({
    renewed: changed,
    accessTokenExpiresAt: token.oiAccessTokenExpiresAt ?? null,
  });
}
