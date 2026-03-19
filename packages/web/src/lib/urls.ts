const LOCAL_HTTP_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
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
