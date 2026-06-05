import { MAX_TUNNEL_PORTS, type SandboxSettings } from "@open-inspect/shared";

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

  return result;
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
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
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
