const BROWSER_SESSION_COOKIE_PATTERN =
  /^(?:__Secure-openinspect|openinspect)\.session_token(?:\.[0-9]+)?$/;

export interface BrowserCookie {
  readonly name: string;
  readonly value: string;
}

function hasInvalidCookieValueCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (character === ";" || codePoint === undefined || codePoint <= 0x20 || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Serialize only Better Auth's opaque browser-session cookie.
 *
 * OAuth transaction cookies and unrelated browser state must not become
 * credentials on control-plane resource requests.
 */
export function serializeBrowserSessionCookies(cookies: readonly BrowserCookie[]): string | null {
  const sessionCookies = cookies.filter(({ name }) => BROWSER_SESSION_COOKIE_PATTERN.test(name));
  if (sessionCookies.length === 0) return null;

  const names = new Set<string>();
  for (const { name, value } of sessionCookies) {
    if (names.has(name)) {
      throw new Error(`Duplicate browser session cookie: ${name}`);
    }
    if (hasInvalidCookieValueCharacter(value)) {
      throw new Error("Invalid browser session cookie value");
    }
    names.add(name);
  }

  return sessionCookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}
