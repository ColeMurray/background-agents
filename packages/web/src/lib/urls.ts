const LOCAL_HTTP_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Build an external URL with a token query parameter (used for ttyd terminal auth).
 * Returns null if the URL is invalid or the token is missing.
 */
export function buildAuthenticatedUrl(
  url: string | null | undefined,
  token: string | null | undefined
): string | null {
  const safeUrl = getSafeExternalUrl(url ?? null);
  if (!safeUrl || !token) return null;
  const parsed = new URL(safeUrl);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

export function getSafeExternalUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    const hostname = normalizeHostname(parsedUrl.hostname);

    if (parsedUrl.protocol === "https:") {
      return parsedUrl.href;
    }

    if (
      parsedUrl.protocol === "http:" &&
      (LOCAL_HTTP_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost"))
    ) {
      return parsedUrl.href;
    }

    return null;
  } catch {
    return null;
  }
}
