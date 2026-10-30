import { McpError } from "./errors";

/** MVP profile: administrator-registered public HTTPS origins, no redirects or IP targets. */
export function mcpDestination(value: string, expectedOrigin?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpError("mcp_unsupported", 400);
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !host.includes(".") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":") ||
    host.endsWith(".") ||
    /(^|\.)(localhost|local|internal|test\.local)$/.test(host) ||
    (expectedOrigin && url.origin !== expectedOrigin)
  ) {
    throw new McpError("mcp_unsupported", 400);
  }
  return url;
}
