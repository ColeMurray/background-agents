/**
 * Shared port resolution for sandbox providers. Applies the shared defaults to
 * the configurable service ports and validates/caps user-supplied tunnel ports,
 * so every provider shares one defaulting/validation rule instead of carrying a
 * near-duplicate copy.
 */

import {
  DEFAULT_CODE_SERVER_PORT,
  DEFAULT_TERMINAL_PORT,
  DEFAULT_VNC_PORT,
  INTERNAL_VNC_PORT,
  MAX_TUNNEL_PORTS,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";

/** Effective service ports from settings, with shared defaults. */
export function resolveServicePorts(sandboxSettings: SandboxSettings | undefined): {
  codeServerPort: number;
  terminalPort: number;
  vncPort: number;
} {
  return {
    codeServerPort: sandboxSettings?.codeServerPort ?? DEFAULT_CODE_SERVER_PORT,
    terminalPort: sandboxSettings?.terminalPort ?? DEFAULT_TERMINAL_PORT,
    vncPort: sandboxSettings?.vncPort ?? DEFAULT_VNC_PORT,
  };
}

/** Validated, capped list of user-configured tunnel ports (invalid entries dropped). */
export function resolveTunnelPorts(rawPorts: number[] | undefined): number[] {
  if (!rawPorts) return [];
  const ports: number[] = [];
  for (const value of rawPorts) {
    if (Number.isInteger(value) && value >= 1 && value <= 65535 && value !== INTERNAL_VNC_PORT) {
      ports.push(value);
    }
    if (ports.length >= MAX_TUNNEL_PORTS) break;
  }
  return ports;
}
