import {
  McpRemoteUrlPolicyError,
  assertExactMcpHost,
  validateMcpRemoteUrl,
} from "./remote-url-policy";

/**
 * The egress policy for an MCP transport.
 *
 * **What this policy can and cannot check.**
 *
 * The earlier version of this file resolved the endpoint's hostname and
 * refused a private address. That check was honest about what it did, and
 * useless in practice: a Durable Object has no resolver, so the check could
 * never be reached from production, and a check that cannot run is not a
 * control. A control that *looks* like it stops SSRF and does not is worse
 * than no control at all, because the review reads it as covered.
 *
 * So the policy is replaced by the checks that *are* enforceable here:
 *
 * - the endpoint is HTTPS, carries no credentials, and is not a blocked
 *   name (`validateMcpRemoteUrl`);
 * - the endpoint is the exact host the operator reviewed, so a stored
 *   endpoint cannot be swapped for another one;
 * - the endpoint's host is not a literal private, loopback, or link-local
 *   address, so a reviewed *address* cannot be an internal one.
 *
 * The one thing this cannot decide is whether a *name* resolves to an
 * internal address. That is the platform's egress rule to make, not the
 * application's, and the deployment is expected to pin its egress (a
 * Cloudflare egress rule, or an operator-chosen host) for the connections it
 * allows. `DEVIATIONS.md` records the gap and the compensating control.
 */
export interface McpEgressPolicy {
  /** The exact host the operator reviewed. */
  readonly endpointHost: string;
}

export interface McpEgressDecision {
  readonly allowed: true;
  /** The host the endpoint was checked against. */
  readonly host: string;
}

/**
 * Check that the endpoint a transport is about to open is the reviewed one.
 *
 * This is the production check: it is called with the endpoint the broker is
 * about to hand to the transport, and it refuses an endpoint that is not the
 * reviewed one, is not HTTPS, carries credentials, is a blocked name, or is a
 * literal internal address.
 */
export function assertMcpEgress(policy: McpEgressPolicy, candidateUrl: string): McpEgressDecision {
  // The endpoint must be a URL the platform's own policy accepts.
  const validated = validateMcpRemoteUrl(candidateUrl);
  // The endpoint must be the reviewed one, exactly.
  assertExactMcpHost(candidateUrl, policy.endpointHost);
  // The reviewed host must not be a literal internal address.
  const hostname = new URL(validated.endpointUrl).hostname.toLowerCase();
  if (isPrivateAddress(hostname)) {
    throw new McpRemoteUrlPolicyError("MCP endpoint host is a private address");
  }
  return { allowed: true, host: validated.endpointHost };
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
