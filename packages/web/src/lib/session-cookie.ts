/**
 * Chunk-aware writer for the NextAuth v4 session cookie.
 *
 * next-auth v4 never exposes its cookie writer, but the oi-refresh route must
 * persist a re-encoded JWT exactly the way next-auth's `SessionStore` reads it
 * back: a single cookie under the session name when the value fits, or
 * `name.0`, `name.1`, … chunks when it does not. The constants and split rule
 * mirror `next-auth/core/lib/cookie.js` byte for byte — the reader joins every
 * cookie whose name starts with the session name, so any stale complementary
 * form (old chunks after an unchunked write, or the old base cookie after a
 * chunked write) MUST be expired in the same response or the reader would
 * concatenate stale and fresh values.
 */

// Mirrors ALLOWED_COOKIE_SIZE - ESTIMATED_EMPTY_COOKIE_SIZE in next-auth v4.
const COOKIE_CHUNK_SIZE = 4096 - 163;

/** next-auth v4's default session maxAge (30 days). */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Whether next-auth uses `__Secure-`-prefixed cookies. Must resolve exactly
 * like the paired reader — next-auth v4 `getToken`'s `secureCookie` default:
 * an https NEXTAUTH_URL when the variable is set, else the presence of
 * Vercel's injected VERCEL env. Vercel preview deployments serve https
 * without NEXTAUTH_URL, so dropping the fallback would write a cookie
 * next-auth never reads back.
 */
function secureCookiesEnabled(): boolean {
  return process.env.NEXTAUTH_URL?.startsWith("https://") ?? Boolean(process.env.VERCEL);
}

export function sessionCookieName(): string {
  return `${secureCookiesEnabled() ? "__Secure-" : ""}next-auth.session-token`;
}

/** The subset of Next's request cookie store the writer needs. */
export interface WritableCookieStore {
  getAll(): { name: string; value: string }[];
  set(
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      sameSite: "lax";
      path: string;
      secure: boolean;
      maxAge: number;
    }
  ): unknown;
}

/**
 * Persist an encoded NextAuth session JWT to the response, splitting into
 * chunks when it exceeds the single-cookie budget and expiring every stale
 * session cookie the new write does not replace.
 */
export function writeSessionCookie(cookieStore: WritableCookieStore, encodedJwt: string): void {
  const name = sessionCookieName();
  const options = {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: secureCookiesEnabled(),
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  };

  const chunks: { name: string; value: string }[] = [];
  if (encodedJwt.length <= COOKIE_CHUNK_SIZE) {
    chunks.push({ name, value: encodedJwt });
  } else {
    for (let i = 0; i * COOKIE_CHUNK_SIZE < encodedJwt.length; i++) {
      chunks.push({
        name: `${name}.${i}`,
        value: encodedJwt.slice(i * COOKIE_CHUNK_SIZE, (i + 1) * COOKIE_CHUNK_SIZE),
      });
    }
  }

  const written = new Set(chunks.map((chunk) => chunk.name));
  for (const existing of cookieStore.getAll()) {
    const isSessionCookie = existing.name === name || existing.name.startsWith(`${name}.`);
    if (isSessionCookie && !written.has(existing.name)) {
      cookieStore.set(existing.name, "", { ...options, maxAge: 0 });
    }
  }
  for (const chunk of chunks) {
    cookieStore.set(chunk.name, chunk.value, options);
  }
}
