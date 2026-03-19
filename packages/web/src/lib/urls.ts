const LOCAL_HTTP_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export function getSafeExternalUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol === "https:") {
      return parsedUrl.href;
    }

    if (
      parsedUrl.protocol === "http:" &&
      (LOCAL_HTTP_HOSTNAMES.has(parsedUrl.hostname) || parsedUrl.hostname.endsWith(".localhost"))
    ) {
      return parsedUrl.href;
    }

    return null;
  } catch {
    return null;
  }
}
