const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

export class McpRemoteUrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRemoteUrlPolicyError";
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part))) return false;
  const values = octets.map(Number);
  if (values.some((value) => value > 255)) return true;
  const [first, second] = values;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0 && values[2] === 113) ||
    first >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const address = hostname.slice(1, -1).toLowerCase();
  if (address === "::" || address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || /^fe[89ab]/.test(address))
    return true;
  if (!address.startsWith("::ffff:")) return false;
  const mapped = address.slice("::ffff:".length);
  if (mapped.includes(".")) return isPrivateIpv4(mapped);
  const words = mapped.split(":");
  if (words.length !== 2 || !words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) return true;
  const high = Number.parseInt(words[0], 16);
  const low = Number.parseInt(words[1], 16);
  return isPrivateIpv4([high >> 8, high & 255, low >> 8, low & 255].map(String).join("."));
}

function parseSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpRemoteUrlPolicyError("MCP endpoint must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new McpRemoteUrlPolicyError("MCP endpoint must use HTTPS");
  }
  if (url.username || url.password) {
    throw new McpRemoteUrlPolicyError("MCP endpoint must not contain credentials");
  }
  if (url.port) {
    throw new McpRemoteUrlPolicyError("MCP endpoint must use the default HTTPS port");
  }
  if (url.search || url.hash) {
    throw new McpRemoteUrlPolicyError(
      "MCP endpoint must not contain query credentials or fragments"
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    throw new McpRemoteUrlPolicyError("MCP endpoint host is private or reserved");
  }
  if (!hostname.startsWith("[")) url.hostname = hostname;
  return url;
}

/** Validate an operator-reviewed endpoint before any connection attempt. */
export function validateMcpRemoteUrl(raw: string): {
  endpointUrl: string;
  endpointHost: string;
} {
  const url = parseSafeUrl(raw);
  return { endpointUrl: url.href, endpointHost: url.host.toLowerCase() };
}

/** Prevent transport redirects or restored configuration from changing the reviewed host. */
export function assertExactMcpHost(raw: string, expectedHost: string): void {
  const url = parseSafeUrl(raw);
  if (url.host.toLowerCase() !== expectedHost.toLowerCase()) {
    throw new McpRemoteUrlPolicyError("MCP transport must use the exact configured host");
  }
}
