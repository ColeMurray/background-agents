import type { SandboxSettings } from "@open-inspect/shared";

export type DockerMode = "inherit" | "enabled" | "disabled";

export function isValidPort(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
}

export function isPositiveInteger(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) >= 1;
}

export function normalizePorts(input: string[]): { ports: number[]; invalid: string[] } {
  const nonEmpty = input.filter((row) => row.trim() !== "");
  const invalid = nonEmpty.filter((row) => !isValidPort(row.trim()));
  const ports = [
    ...new Set(nonEmpty.filter((row) => isValidPort(row.trim())).map((row) => Number(row.trim()))),
  ];
  return { ports, invalid };
}

export function resolveDockerMode({
  isGlobal,
  globalDefaults,
  repoSettings,
}: {
  isGlobal: boolean;
  globalDefaults?: SandboxSettings;
  repoSettings?: SandboxSettings | null;
}): DockerMode {
  if (isGlobal) {
    return globalDefaults?.dockerEnabled ? "enabled" : "disabled";
  }
  if (repoSettings?.dockerEnabled === undefined) {
    return "inherit";
  }
  return repoSettings.dockerEnabled ? "enabled" : "disabled";
}

export function resolveDockerEnabled(
  dockerMode: DockerMode,
  globalDefaults?: SandboxSettings
): boolean {
  return dockerMode === "enabled" || (dockerMode === "inherit" && !!globalDefaults?.dockerEnabled);
}

export function buildSettingsPayload({
  baseSettings,
  isGlobal,
  ports,
  terminalEnabled,
  dockerMode,
  maxConcurrentChildSessions,
  maxTotalChildSessions,
  maxConcurrentChildSessionsEdited,
  maxTotalChildSessionsEdited,
  repoSettings,
}: {
  baseSettings?: SandboxSettings | null;
  isGlobal: boolean;
  ports: number[];
  terminalEnabled: boolean;
  dockerMode: DockerMode;
  maxConcurrentChildSessions: string;
  maxTotalChildSessions: string;
  maxConcurrentChildSessionsEdited: boolean;
  maxTotalChildSessionsEdited: boolean;
  repoSettings?: SandboxSettings | null;
}): SandboxSettings {
  const settingsPayload: SandboxSettings = {
    ...baseSettings,
    tunnelPorts: ports,
    terminalEnabled,
  };

  if (!isGlobal && dockerMode === "inherit") {
    delete settingsPayload.dockerEnabled;
  } else {
    settingsPayload.dockerEnabled = dockerMode === "enabled";
  }
  if (
    isGlobal ||
    maxConcurrentChildSessionsEdited ||
    repoSettings?.maxConcurrentChildSessions !== undefined
  ) {
    settingsPayload.maxConcurrentChildSessions = Number(maxConcurrentChildSessions);
  }
  if (
    isGlobal ||
    maxTotalChildSessionsEdited ||
    repoSettings?.maxTotalChildSessions !== undefined
  ) {
    settingsPayload.maxTotalChildSessions = Number(maxTotalChildSessions);
  }

  return settingsPayload;
}
