import {
  DEFAULT_CODE_SERVER_PORT,
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
  DEFAULT_TERMINAL_PORT,
  DEFAULT_VNC_PORT,
  MAX_BUILD_TIMEOUT_SECONDS,
  findSandboxPortConflict,
  validateSandboxChildSessionLimits,
  type ConfiguredSandboxPort,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";
import { sandboxTimeoutMinutesFromMs, sandboxTimeoutMsFromMinutes } from "./sandbox-timeout";

type DraftKey<K> = K extends "sandboxTimeoutMs" ? "sandboxTimeoutMinutes" : K;

export type SandboxSettingsDraftValues = {
  [K in keyof SandboxSettings as DraftKey<K>]-?: K extends "tunnelPorts"
    ? string[]
    : K extends "terminalEnabled"
      ? boolean
      : string;
};

// Absent fields are unedited; blank inputs are clears, not inherited values.
export type SandboxSettingsDraft = Partial<SandboxSettingsDraftValues>;

type Field<K extends keyof SandboxSettings> = {
  draftKey: DraftKey<K>;
  format: (value: SandboxSettings[K]) => SandboxSettingsDraftValues[DraftKey<K>];
  parse: (value: SandboxSettingsDraftValues[DraftKey<K>]) => {
    value?: SandboxSettings[K];
    error?: string;
  };
  isChanged: (
    value: SandboxSettingsDraftValues[DraftKey<K>],
    current: SandboxSettingsDraftValues[DraftKey<K>]
  ) => boolean;
  clearValue?: SandboxSettings[K];
};

const positiveInteger = (value: string) => /^\d+$/.test(value) && Number(value) >= 1;
const validPort = (value: string) => positiveInteger(value) && Number(value) <= 65535;

function normalizePorts(rows: string[]) {
  const ports = new Set<number>();
  const invalid: string[] = [];
  for (const row of rows) {
    const trimmed = row.trim();
    if (trimmed === "") continue;
    if (validPort(trimmed)) ports.add(Number(trimmed));
    else invalid.push(row);
  }
  return { ports: [...ports], invalid };
}

function numberField(validate: (value: string) => boolean, error: string, defaultValue?: number) {
  return {
    format: (value: number | null | undefined) =>
      value == null ? (defaultValue === undefined ? "" : String(defaultValue)) : String(value),
    parse: (value: string) => {
      const trimmed = defaultValue === undefined ? value.trim() : value;
      if (trimmed === "" && defaultValue === undefined) return { value: undefined };
      return validate(trimmed) ? { value: Number(trimmed) } : { error };
    },
    isChanged: (value: string, current: string) =>
      (defaultValue === undefined ? value.trim() : value) !== current,
  };
}

type FieldRegistry<Keys extends keyof SandboxSettings = keyof SandboxSettings> = {
  [K in Keys]: Field<K>;
};

// Registry order also preserves the form's first-validation-error precedence.
const fields: FieldRegistry = {
  tunnelPorts: {
    draftKey: "tunnelPorts",
    format: (value) => (value ?? []).map(String),
    parse: (rows) => {
      const { ports, invalid } = normalizePorts(rows);
      return invalid.length
        ? { error: `Invalid port numbers: ${invalid.join(", ")}` }
        : { value: ports };
    },
    isChanged: (rows, current) =>
      JSON.stringify(normalizePorts(rows).ports) !== JSON.stringify(current.map(Number)),
  },
  terminalEnabled: {
    draftKey: "terminalEnabled",
    format: (value) => value ?? false,
    parse: (value) => ({ value }),
    isChanged: (value, current) => value !== current,
  },
  maxSessionCostUsd: {
    draftKey: "maxSessionCostUsd",
    ...numberField(
      (value) => Number.isFinite(Number(value)) && Number(value) > 0,
      "Session cost limit must be a positive USD amount."
    ),
  },
  maxConcurrentChildSessions: {
    draftKey: "maxConcurrentChildSessions",
    ...numberField(
      positiveInteger,
      "Child session limits must be positive whole numbers.",
      DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS
    ),
  },
  maxTotalChildSessions: {
    draftKey: "maxTotalChildSessions",
    ...numberField(
      positiveInteger,
      "Child session limits must be positive whole numbers.",
      DEFAULT_MAX_TOTAL_CHILD_SESSIONS
    ),
  },
  cpuCores: {
    draftKey: "cpuCores",
    ...numberField(
      (value) => /^\d*\.?\d+$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0,
      "CPU cores must be a positive number."
    ),
    clearValue: null,
  },
  memoryMib: {
    draftKey: "memoryMib",
    ...numberField(positiveInteger, "Memory must be a positive whole number of MiB."),
    clearValue: null,
  },
  codeServerPort: {
    draftKey: "codeServerPort",
    ...numberField(validPort, "Code server port must be a whole number between 1 and 65535."),
  },
  vncPort: {
    draftKey: "vncPort",
    ...numberField(validPort, "VNC port must be a whole number between 1 and 65535."),
  },
  terminalPort: {
    draftKey: "terminalPort",
    ...numberField(validPort, "Terminal port must be a whole number between 1 and 65535."),
  },
  buildTimeoutSeconds: {
    draftKey: "buildTimeoutSeconds",
    ...numberField(
      (value) => positiveInteger(value) && Number(value) <= MAX_BUILD_TIMEOUT_SECONDS,
      `Build timeout must be a whole number of seconds, at most ${MAX_BUILD_TIMEOUT_SECONDS}.`
    ),
  },
  sandboxTimeoutMs: {
    draftKey: "sandboxTimeoutMinutes",
    format: sandboxTimeoutMinutesFromMs,
    parse: (input) => {
      const trimmed = input.trim();
      const value = sandboxTimeoutMsFromMinutes(trimmed);
      return trimmed !== "" && value === undefined
        ? { error: "Session timeout must be at least one second, in one-second increments." }
        : { value };
    },
    isChanged: (value, current) => value.trim() !== current,
  },
};

export function resolveSandboxSettingsDraft({
  isGlobal,
  ownSettings,
  baseDefaults,
  draft,
}: {
  isGlobal: boolean;
  ownSettings?: SandboxSettings;
  baseDefaults?: SandboxSettings;
  draft: SandboxSettingsDraft;
}): {
  values: SandboxSettingsDraftValues;
  hasChanges: boolean;
  result: { settings: SandboxSettings; error?: never } | { error: string; settings?: never };
} {
  const values = {} as SandboxSettingsDraftValues;
  const settings: SandboxSettings = {};
  const effective: SandboxSettings = {};
  let hasChanges = false;
  let error: string | undefined;

  function resolveField<K extends keyof SandboxSettings>(key: K) {
    const field: Field<K> = fields[key];
    const prior = ownSettings?.[key];
    // Explicit resource nulls mask inheritance, rather than falling through it.
    const current = field.format(prior !== undefined ? prior : baseDefaults?.[key]);
    const edit = draft[field.draftKey];
    const value = edit ?? current;
    values[field.draftKey] = value;
    const parsed = field.parse(value);
    hasChanges ||=
      edit !== undefined && (parsed.error !== undefined || field.isChanged(edit, current));
    error ??= parsed.error;

    const payload =
      isGlobal || edit !== undefined
        ? (parsed.value ?? (!isGlobal ? field.clearValue : undefined))
        : prior;
    if (payload !== undefined) settings[key] = payload;
    effective[key] = payload !== undefined ? payload : (parsed.value ?? baseDefaults?.[key]);
  }

  for (const key of Object.keys(fields) as (keyof SandboxSettings)[]) resolveField(key);

  error ??= validateSandboxChildSessionLimits(effective);

  if (!error) {
    const configuredPorts: ConfiguredSandboxPort[] = [
      ...(effective.tunnelPorts ?? []).map((port) => ({ port, label: "tunnel port" })),
      { port: effective.codeServerPort ?? DEFAULT_CODE_SERVER_PORT, label: "code server port" },
      { port: effective.terminalPort ?? DEFAULT_TERMINAL_PORT, label: "terminal port" },
      { port: effective.vncPort ?? DEFAULT_VNC_PORT, label: "VNC port" },
    ];
    const conflict = findSandboxPortConflict(configuredPorts);
    if (conflict) {
      error =
        conflict.kind === "reserved"
          ? `Port ${conflict.port} is reserved for an internal sandbox service and cannot be used.`
          : "Code server, VNC, terminal, and tunnel ports must all be different.";
    }
  }

  return { values, hasChanges, result: error ? { error } : { settings } };
}
