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
  findSandboxPortConflict,
  INTERNAL_TTYD_PORT,
  INTERNAL_VNC_PORT,
  MAX_TUNNEL_PORTS,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";

export interface SandboxServiceEnablement {
  codeServer: boolean;
  terminal: boolean;
  vnc: boolean;
}

/** Effective ports used by enabled services and generic user tunnels. */
export interface SandboxPortPlan {
  codeServerPort?: number;
  terminalPort?: number;
  vncPort?: number;
  reservedPorts: number[];
  extraTunnelPorts: number[];
  allExposedPorts: number[];
}

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
    if (
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 65535 &&
      value !== INTERNAL_TTYD_PORT &&
      value !== INTERNAL_VNC_PORT &&
      !ports.includes(value)
    ) {
      ports.push(value);
    }
    if (ports.length >= MAX_TUNNEL_PORTS) break;
  }
  return ports;
}

/** Resolve and validate the complete provider-neutral port plan for a sandbox. */
export function resolveSandboxPortPlan(
  enabled: SandboxServiceEnablement,
  sandboxSettings: SandboxSettings | undefined
): SandboxPortPlan {
  const resolved = resolveServicePorts(sandboxSettings);
  const services: Array<{ port: number; label: string }> = [];
  if (enabled.codeServer) services.push({ port: resolved.codeServerPort, label: "code-server" });
  if (enabled.terminal) services.push({ port: resolved.terminalPort, label: "terminal" });
  if (enabled.vnc) services.push({ port: resolved.vncPort, label: "VNC" });
  const conflict = findSandboxPortConflict(services);
  if (conflict) {
    throw new Error(
      conflict.kind === "reserved"
        ? `Sandbox ${conflict.label} port ${conflict.port} is reserved for an internal service`
        : `Sandbox port ${conflict.port} is assigned to more than one enabled service`
    );
  }

  const reservedPorts = services.map(({ port }) => port);
  const reserved = new Set(reservedPorts);
  const extraTunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts).filter(
    (port) => !reserved.has(port)
  );

  return {
    ...(enabled.codeServer ? { codeServerPort: resolved.codeServerPort } : {}),
    ...(enabled.terminal ? { terminalPort: resolved.terminalPort } : {}),
    ...(enabled.vnc ? { vncPort: resolved.vncPort } : {}),
    reservedPorts,
    extraTunnelPorts,
    allExposedPorts: [...reservedPorts, ...extraTunnelPorts],
  };
}
