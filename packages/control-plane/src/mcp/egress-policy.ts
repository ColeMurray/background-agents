import { McpRemoteUrlPolicyError, assertExactMcpHost } from "./remote-url-policy";

/**
 * The egress policy for an MCP transport.
 *
 * A reviewed host may still resolve to a private address, and a transport may
 * still be redirected. Both are checked here so the transport never reaches
 * an address the operator did not review.
 */
export interface McpEgressPolicy {
  /** The exact host the operator reviewed. */
  readonly endpointHost: string;
  /** The addresses the host may resolve to. Empty means "any public address". */
  readonly allowedAddresses?: readonly string[];
  /**
   * Resolve a hostname to its addresses. The production resolver is the
   * platform's own DNS; a test supplies its own.
   */
  resolve(hostname: string): Promise<string[]>;
}

export interface McpEgressDecision {
  readonly allowed: true;
  readonly addresses: readonly string[];
}

/**
 * Check that the host is the reviewed one and that it resolves to public
 * addresses.
 *
 * A hostname that resolves to a private, loopback, or link-local address is
 * refused, because that is how a reviewed name turns into an internal
 * service.
 */
export async function assertMcpEgress(
  policy: McpEgressPolicy,
  candidateUrl: string
): Promise<McpEgressDecision> {
  assertExactMcpHost(candidateUrl, policy.endpointHost);
  const hostname = new URL(candidateUrl).hostname.toLowerCase().replace(/\.+$/, "");
  const addresses = await policy.resolve(hostname);
  if (addresses.length === 0) {
    throw new McpRemoteUrlPolicyError("MCP endpoint host did not resolve");
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new McpRemoteUrlPolicyError("MCP endpoint host resolves to a private address");
    }
    if (policy.allowedAddresses && policy.allowedAddresses.length > 0) {
      if (!policy.allowedAddresses.includes(address)) {
        throw new McpRemoteUrlPolicyError("MCP endpoint host resolves to an unreviewed address");
      }
    }
  }
  return { allowed: true, addresses };
}

/** Whether one address is private, loopback, link-local, or otherwise reserved. */
export function isPrivateAddress(address: string): boolean {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) {
    const octets = ipv4.slice(1).map((part) => Number(part));
    if (octets.some((octet) => octet > 255)) return true;
    const [first, second, third] = octets as [number, number, number];
    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && (second === 0 || second === 168)) return true;
    if (first === 198 && (second === 18 || second === 19 || second === 51)) return true;
    if (first === 203 && second === 0 && third === 113) return true;
    if (first >= 224) return true;
    return false;
  }
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    if (mapped.includes(".")) return isPrivateAddress(mapped);
    const groups = mapped
      .split(":")
      .filter(Boolean)
      .map((group) => Number.parseInt(group, 16));
    if (groups.length !== 2 || groups.some((group) => Number.isNaN(group))) return true;
    const [high, low] = groups as [number, number];
    const first = high >> 8;
    const second = high & 0xff;
    const third = low >> 8;
    const fourth = low & 0xff;
    return isPrivateAddress(`${first}.${second}.${third}.${fourth}`);
  }
  return false;
}
