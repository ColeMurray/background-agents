import {
  findSandboxPortConflict,
  MAX_TUNNEL_PORTS,
  type ConfiguredSandboxPort,
  type SandboxSettings,
} from "@open-inspect/shared";

export type InvalidSandboxSettingsBehavior = "throw" | "omit";

export interface NormalizeSandboxSettingsOptions {
  invalid?: InvalidSandboxSettingsBehavior;
  createError?: (message: string) => Error;
}

export class SandboxSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxSettingsValidationError";
  }
}

/**
 * Normalize SandboxSettings at control-plane boundaries.
 *
 * Settings writes use `invalid: "throw"`; stored session blobs use
 * `invalid: "omit"` because old rows or internal callers may contain stale data.
 */
export function normalizeSandboxSettings(
  input: unknown,
  options: NormalizeSandboxSettingsOptions = {}
): SandboxSettings {
  const invalidBehavior = options.invalid ?? "throw";
  const createError =
    options.createError ?? ((message: string) => new SandboxSettingsValidationError(message));
  const reject = (message: string): false => {
    if (invalidBehavior === "throw") {
      throw createError(message);
    }
    return false;
  };

  if (input == null) return {};

  if (typeof input !== "object" || Array.isArray(input)) {
    reject("sandbox settings must be an object");
    return {};
  }

  const settings = input as Record<string, unknown>;
  const result: SandboxSettings = {};

  if (settings.terminalEnabled !== undefined) {
    if (typeof settings.terminalEnabled !== "boolean") {
      reject("terminalEnabled must be a boolean");
    } else {
      result.terminalEnabled = settings.terminalEnabled;
    }
  }

  if (settings.tunnelPorts !== undefined) {
    normalizeTunnelPorts(settings.tunnelPorts, reject, result);
  }

  const codeServerPort = normalizePort(settings.codeServerPort, "codeServerPort", reject);
  if (codeServerPort !== undefined) result.codeServerPort = codeServerPort;

  const terminalPort = normalizePort(settings.terminalPort, "terminalPort", reject);
  if (terminalPort !== undefined) result.terminalPort = terminalPort;

  let maxConcurrentChildSessions = normalizePositiveIntegerSetting(
    settings.maxConcurrentChildSessions,
    "maxConcurrentChildSessions",
    reject
  );
  const maxTotalChildSessions = normalizePositiveIntegerSetting(
    settings.maxTotalChildSessions,
    "maxTotalChildSessions",
    reject
  );

  if (
    maxConcurrentChildSessions !== undefined &&
    maxTotalChildSessions !== undefined &&
    maxConcurrentChildSessions > maxTotalChildSessions
  ) {
    reject("maxConcurrentChildSessions must be less than or equal to maxTotalChildSessions");
    maxConcurrentChildSessions = undefined;
  }

  if (maxConcurrentChildSessions !== undefined) {
    result.maxConcurrentChildSessions = maxConcurrentChildSessions;
  }
  if (maxTotalChildSessions !== undefined) {
    result.maxTotalChildSessions = maxTotalChildSessions;
  }

  if (settings.cpuCores !== undefined) {
    if (settings.cpuCores === null) {
      result.cpuCores = null;
    } else if (
      typeof settings.cpuCores !== "number" ||
      !Number.isFinite(settings.cpuCores) ||
      settings.cpuCores <= 0
    ) {
      reject("cpuCores must be a positive number");
    } else {
      result.cpuCores = settings.cpuCores;
    }
  }

  if (settings.memoryMib !== undefined) {
    if (settings.memoryMib === null) {
      result.memoryMib = null;
    } else if (
      typeof settings.memoryMib !== "number" ||
      !Number.isInteger(settings.memoryMib) ||
      settings.memoryMib <= 0
    ) {
      reject("memoryMib must be a positive integer");
    } else {
      result.memoryMib = settings.memoryMib;
    }
  }

  const buildTimeoutSeconds = normalizePositiveIntegerSetting(
    settings.buildTimeoutSeconds,
    "buildTimeoutSeconds",
    reject
  );
  if (buildTimeoutSeconds !== undefined) {
    // Stored as-is; the build trigger caps it at MAX via resolveBuildTimeoutSeconds.
    result.buildTimeoutSeconds = buildTimeoutSeconds;
  }

  checkPortCollisions(result, reject);

  return result;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function normalizePort(
  value: unknown,
  name: string,
  reject: (message: string) => false
): number | undefined {
  if (value === undefined) return undefined;
  if (!isValidPort(value)) {
    reject(`${name} must be an integer between 1 and 65535`);
    return undefined;
  }
  return value;
}

/**
 * Reject reserved-port use and any port shared across code-server, terminal, and
 * tunnel ports. Enablement-independent: every configured port must be unique so a
 * port is never silently dropped at sandbox spawn. The conflict rule itself lives
 * in `findSandboxPortConflict` (shared with the web settings UI).
 *
 * In `invalid: "omit"` mode `reject` returns instead of throwing, so we actively
 * drop the offending port and re-check until the result is collision-free. This
 * matters at the merged global+repo boundary (`getResolvedConfig`), which
 * normalizes in omit mode — a surviving collision would otherwise reach providers
 * and be silently dropped again at spawn.
 */
function checkPortCollisions(result: SandboxSettings, reject: (message: string) => false): void {
  for (;;) {
    const ports: ConfiguredSandboxPort[] = [];
    if (result.codeServerPort !== undefined) {
      ports.push({ port: result.codeServerPort, label: "codeServerPort" });
    }
    if (result.terminalPort !== undefined) {
      ports.push({ port: result.terminalPort, label: "terminalPort" });
    }
    for (const port of result.tunnelPorts ?? []) {
      ports.push({ port, label: "tunnelPorts" });
    }

    const conflict = findSandboxPortConflict(ports);
    if (!conflict) return;

    reject(
      conflict.kind === "reserved"
        ? `Port ${conflict.port} is reserved for the internal terminal (used by ${conflict.label})`
        : `Port ${conflict.port} is used more than once across code-server, terminal, and tunnel ports`
    );

    // Reached only in omit mode (throw mode already threw). Drop the offending
    // port and re-check; removing a port never creates a new conflict, so this
    // terminates. Service ports listed first win; conflicting tunnels are dropped.
    if (conflict.label === "codeServerPort") {
      delete result.codeServerPort;
    } else if (conflict.label === "terminalPort") {
      delete result.terminalPort;
    } else {
      const remaining = (result.tunnelPorts ?? []).filter((p) => p !== conflict.port);
      if (remaining.length > 0) {
        result.tunnelPorts = remaining;
      } else {
        delete result.tunnelPorts;
      }
    }
  }
}

function normalizeTunnelPorts(
  value: unknown,
  reject: (message: string) => false,
  result: SandboxSettings
): void {
  if (!Array.isArray(value)) {
    reject("tunnelPorts must be an array of numbers");
    return;
  }

  const ports: number[] = [];
  for (const port of value) {
    if (!isValidPort(port)) {
      reject(`Invalid port number: ${port}. Must be an integer between 1 and 65535`);
      continue;
    }
    if (!ports.includes(port)) {
      ports.push(port);
    }
  }

  if (ports.length > MAX_TUNNEL_PORTS) {
    reject(`tunnelPorts must have ${MAX_TUNNEL_PORTS} or fewer entries`);
  }

  if (ports.length > 0) {
    result.tunnelPorts = ports.slice(0, MAX_TUNNEL_PORTS);
  }
}

function normalizePositiveIntegerSetting(
  value: unknown,
  name: string,
  reject: (message: string) => false
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    reject(`${name} must be a positive integer`);
    return undefined;
  }
  return value;
}
