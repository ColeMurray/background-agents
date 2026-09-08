/**
 * Shared port resolution for sandbox providers. Applies the shared defaults to
 * the configurable service ports and validates/caps user-supplied tunnel ports,
 * so every provider shares one defaulting/validation rule instead of carrying a
 * near-duplicate copy.
 */

import {
  DEFAULT_CODE_SERVER_PORT,
  DEFAULT_TERMINAL_PORT,
  MAX_TUNNEL_PORTS,
  type SandboxSettings,
} from "@open-inspect/shared";

/** Effective code-server / terminal ports from settings, with shared defaults. */
export function resolveServicePorts(sandboxSettings: SandboxSettings | undefined): {
  codeServerPort: number;
  terminalPort: number;
} {
  return {
    codeServerPort: sandboxSettings?.codeServerPort ?? DEFAULT_CODE_SERVER_PORT,
    terminalPort: sandboxSettings?.terminalPort ?? DEFAULT_TERMINAL_PORT,
  };
}

/** Validated, capped list of user-configured tunnel ports (invalid entries dropped). */
export function resolveTunnelPorts(rawPorts: number[] | undefined): number[] {
  if (!rawPorts) return [];
  const ports: number[] = [];
  for (const value of rawPorts) {
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      ports.push(value);
    }
    if (ports.length >= MAX_TUNNEL_PORTS) break;
  }
  return ports;
}
