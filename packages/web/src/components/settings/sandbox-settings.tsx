"use client";

import { useRepos } from "@/hooks/use-repos";
import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, CheckIcon, PlusIcon } from "@/components/ui/icons";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import useSWR from "swr";
import type { ConfiguredSandboxPort, SandboxSettings } from "@open-inspect/shared";
import {
  DEFAULT_BUILD_TIMEOUT_SECONDS,
  DEFAULT_CODE_SERVER_PORT,
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
  DEFAULT_TERMINAL_PORT,
  encodeRepositoryPathSegments,
  findSandboxPortConflict,
  MAX_BUILD_TIMEOUT_SECONDS,
  MAX_TUNNEL_PORTS,
} from "@open-inspect/shared";

const GLOBAL_SCOPE = "__global__";
type ResourceField = "cpuCores" | "memoryMib";

interface GlobalSettingsResponse {
  integrationId: string;
  settings: { defaults?: SandboxSettings; enabledRepos?: string[] } | null;
}

interface RepoSettingsResponse {
  integrationId: string;
  repo: string;
  settings: SandboxSettings | null;
}

interface EnvironmentSettingsResponse {
  integrationId: string;
  environmentId: string;
  settings: SandboxSettings | null;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function isValidPort(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
}

function isPositiveInteger(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) >= 1;
}

function isValidCpuCores(value: string): boolean {
  if (!/^\d*\.?\d+$/.test(value)) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function isValidMemoryMib(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  return Number(value) >= 1;
}

function isValidBuildTimeout(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= MAX_BUILD_TIMEOUT_SECONDS;
}

const numOrUndef = (v: number | null | undefined): number | undefined =>
  typeof v === "number" ? v : undefined;

/** Value to show in the input: the scope's own override, else the inherited base (display only). */
function resourceDisplayValue(
  own: SandboxSettings | undefined,
  base: SandboxSettings | undefined,
  field: ResourceField
): number | undefined {
  const ownValue = own?.[field];
  if (ownValue !== undefined) return numOrUndef(ownValue); // own value (null → blank)
  return numOrUndef(base?.[field]);
}

/**
 * The value to persist for a resource field, or `undefined` to omit it from the
 * payload (`null` means "use the provider default"). A stored JSON value is never
 * `undefined`, so returning `prior` directly preserves an existing override and
 * skips an inherited-only field in one move.
 */
function resourcePayloadValue(
  isGlobal: boolean,
  editState: string | null,
  trimmed: string,
  prior: number | null | undefined
): number | null | undefined {
  if (isGlobal) return trimmed === "" ? undefined : Number(trimmed);
  if (editState !== null) return trimmed === "" ? null : Number(trimmed);
  return prior; // not edited: keep existing override, or undefined → don't pin
}

/**
 * Like {@link resourcePayloadValue} but for optional numeric fields with no
 * explicit-null form (service ports, build timeout): at override scopes a
 * cleared field is omitted — back to inheriting — instead of pinned as null.
 */
function numberPayloadValue(
  isGlobal: boolean,
  editState: string | null,
  trimmed: string,
  prior: number | undefined
): number | undefined {
  if (isGlobal || editState !== null) return trimmed === "" ? undefined : Number(trimmed);
  return prior; // not edited: keep existing override, or undefined → don't pin
}

/** What a sandbox-settings scope reads/writes and what it inherits from. */
interface SandboxScopeModel {
  apiUrl: string;
  /** This scope's own stored settings (at global scope, the stored defaults). */
  ownSettings: SandboxSettings | undefined;
  /** The layer beneath this scope's overrides (undefined at global scope). */
  baseDefaults: SandboxSettings | undefined;
  /** Preserved on global saves so a defaults update can't drop the allowlist. */
  enabledRepos: string[] | undefined;
  isLoading: boolean;
  mutate: () => Promise<unknown>;
}

/**
 * Resolve a sandbox-settings scope so the form itself stays scope-agnostic:
 *
 * - **global** — edits the stored defaults; inherits nothing.
 * - **repo** — edits that repo's overrides; inherits the global defaults.
 * - **environment** — edits that environment's overrides (design §13.5);
 *   inherits the global defaults merged with the PRIMARY repository's
 *   overrides, mirroring what its sessions resolve beneath the environment
 *   layer.
 */
function useSandboxSettingsScope(
  scope: "global" | "repo" | "environment",
  owner?: string,
  name?: string,
  environmentId?: string
): SandboxScopeModel {
  const isGlobal = scope === "global";
  const globalApiUrl = "/api/integration-settings/sandbox";
  const repoPath =
    owner && name ? encodeRepositoryPathSegments({ repoOwner: owner, repoName: name }) : "";
  const repoApiUrl = `/api/integration-settings/sandbox/repos/${repoPath}`;
  const apiUrl = isGlobal
    ? globalApiUrl
    : scope === "repo"
      ? repoApiUrl
      : `/api/integration-settings/sandbox/environments/${environmentId}`;

  const { data, mutate, isLoading } = useSWR<
    GlobalSettingsResponse | RepoSettingsResponse | EnvironmentSettingsResponse
  >(apiUrl, fetcher);
  const { data: globalData, isLoading: isLoadingGlobal } = useSWR<GlobalSettingsResponse>(
    isGlobal ? null : globalApiUrl,
    fetcher
  );
  const { data: primaryRepoData, isLoading: isLoadingPrimaryRepo } = useSWR<RepoSettingsResponse>(
    scope === "environment" && owner && name ? repoApiUrl : null,
    fetcher
  );

  const globalSettings = isGlobal
    ? (data as GlobalSettingsResponse | undefined)?.settings
    : undefined;
  const ownSettings = isGlobal
    ? globalSettings?.defaults
    : ((data as RepoSettingsResponse | EnvironmentSettingsResponse | undefined)?.settings ??
      undefined);
  const baseDefaults = isGlobal
    ? undefined
    : scope === "environment"
      ? { ...globalData?.settings?.defaults, ...primaryRepoData?.settings }
      : globalData?.settings?.defaults;

  return {
    apiUrl,
    ownSettings,
    baseDefaults,
    enabledRepos: globalSettings?.enabledRepos,
    isLoading: isLoading || isLoadingGlobal || isLoadingPrimaryRepo,
    mutate,
  };
}

export function SandboxSettingsEditor({
  scope,
  owner,
  name,
  environmentId,
}: {
  scope: "global" | "repo" | "environment";
  /**
   * At repo scope: the repo being edited. At environment scope: the
   * environment's primary repository, whose resolved settings are the
   * inherited layer beneath the environment's overrides (design §13.5).
   */
  owner?: string;
  name?: string;
  environmentId?: string;
}) {
  const isGlobal = scope === "global";
  const { apiUrl, ownSettings, baseDefaults, enabledRepos, isLoading, mutate } =
    useSandboxSettingsScope(scope, owner, name, environmentId);

  // Display values: the scope's own setting, else the inherited base. Only
  // explicitly edited fields (or pre-existing overrides) are written back on
  // save, so displaying an inherited value never silently pins it as an
  // override.
  const currentPorts: number[] = ownSettings?.tunnelPorts ?? baseDefaults?.tunnelPorts ?? [];

  const currentTerminalEnabled: boolean =
    ownSettings?.terminalEnabled ?? baseDefaults?.terminalEnabled ?? false;

  const currentCodeServerPort: number | undefined =
    ownSettings?.codeServerPort ?? baseDefaults?.codeServerPort;

  const currentTerminalPort: number | undefined =
    ownSettings?.terminalPort ?? baseDefaults?.terminalPort;

  const currentBuildTimeoutSeconds: number | undefined =
    ownSettings?.buildTimeoutSeconds ?? baseDefaults?.buildTimeoutSeconds;

  const currentMaxConcurrentChildSessions: number =
    ownSettings?.maxConcurrentChildSessions ??
    baseDefaults?.maxConcurrentChildSessions ??
    DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS;

  const currentMaxTotalChildSessions: number =
    ownSettings?.maxTotalChildSessions ??
    baseDefaults?.maxTotalChildSessions ??
    DEFAULT_MAX_TOTAL_CHILD_SESSIONS;

  const currentCpuCores = resourceDisplayValue(ownSettings, baseDefaults, "cpuCores");
  const currentMemoryMib = resourceDisplayValue(ownSettings, baseDefaults, "memoryMib");

  const [portRows, setPortRows] = useState<string[] | null>(null);
  const [terminalEnabled, setTerminalEnabled] = useState<boolean | null>(null);
  const [codeServerPort, setCodeServerPort] = useState<string | null>(null);
  const [terminalPort, setTerminalPort] = useState<string | null>(null);
  const [buildTimeoutSeconds, setBuildTimeoutSeconds] = useState<string | null>(null);
  const [maxConcurrentChildSessions, setMaxConcurrentChildSessions] = useState<string | null>(null);
  const [maxTotalChildSessions, setMaxTotalChildSessions] = useState<string | null>(null);
  const [cpuCores, setCpuCores] = useState<string | null>(null);
  const [memoryMib, setMemoryMib] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Resolve terminal toggle: local edit or server state
  const resolvedTerminalEnabled = terminalEnabled ?? currentTerminalEnabled;

  // Use server state unless user is editing
  const rows = portRows ?? currentPorts.map(String);
  const resolvedMaxConcurrentChildSessions =
    maxConcurrentChildSessions ?? String(currentMaxConcurrentChildSessions);
  const resolvedMaxTotalChildSessions =
    maxTotalChildSessions ?? String(currentMaxTotalChildSessions);
  const resolvedCpuCores =
    cpuCores ?? (currentCpuCores !== undefined ? String(currentCpuCores) : "");
  const resolvedMemoryMib =
    memoryMib ?? (currentMemoryMib !== undefined ? String(currentMemoryMib) : "");
  const resolvedCodeServerPort =
    codeServerPort ?? (currentCodeServerPort !== undefined ? String(currentCodeServerPort) : "");
  const resolvedTerminalPort =
    terminalPort ?? (currentTerminalPort !== undefined ? String(currentTerminalPort) : "");
  const resolvedBuildTimeoutSeconds =
    buildTimeoutSeconds ??
    (currentBuildTimeoutSeconds !== undefined ? String(currentBuildTimeoutSeconds) : "");

  const handleAddRow = () => {
    if (rows.length >= MAX_TUNNEL_PORTS) return;
    setPortRows([...rows, ""]);
  };

  const handleUpdateRow = (index: number, value: string) => {
    const updated = [...rows];
    updated[index] = value;
    setPortRows(updated);
  };

  const handleRemoveRow = (index: number) => {
    const updated = rows.filter((_, i) => i !== index);
    setPortRows(updated);
  };

  /** Trim, filter empty, validate, parse to number, dedupe. */
  const normalizePorts = (input: string[]): { ports: number[]; invalid: string[] } => {
    const nonEmpty = input.filter((r) => r.trim() !== "");
    const invalid = nonEmpty.filter((r) => !isValidPort(r.trim()));
    const ports = [
      ...new Set(nonEmpty.filter((r) => isValidPort(r.trim())).map((r) => Number(r.trim()))),
    ];
    return { ports, invalid };
  };

  const handleSave = useCallback(async () => {
    setError(null);
    setSuccess(false);

    const { ports, invalid } = normalizePorts(rows);
    if (invalid.length > 0) {
      setError(`Invalid port numbers: ${invalid.join(", ")}`);
      return;
    }

    if (
      !isPositiveInteger(resolvedMaxConcurrentChildSessions) ||
      !isPositiveInteger(resolvedMaxTotalChildSessions)
    ) {
      setError("Child session limits must be positive whole numbers.");
      return;
    }

    const trimmedCpu = resolvedCpuCores.trim();
    if (trimmedCpu !== "" && !isValidCpuCores(trimmedCpu)) {
      setError("CPU cores must be a positive number.");
      return;
    }

    const trimmedMemory = resolvedMemoryMib.trim();
    if (trimmedMemory !== "" && !isValidMemoryMib(trimmedMemory)) {
      setError("Memory must be a positive whole number of MiB.");
      return;
    }

    const trimmedCodeServerPort = resolvedCodeServerPort.trim();
    if (trimmedCodeServerPort !== "" && !isValidPort(trimmedCodeServerPort)) {
      setError("Code server port must be a whole number between 1 and 65535.");
      return;
    }

    const trimmedTerminalPort = resolvedTerminalPort.trim();
    if (trimmedTerminalPort !== "" && !isValidPort(trimmedTerminalPort)) {
      setError("Terminal port must be a whole number between 1 and 65535.");
      return;
    }

    const trimmedBuildTimeout = resolvedBuildTimeoutSeconds.trim();
    if (trimmedBuildTimeout !== "" && !isValidBuildTimeout(trimmedBuildTimeout)) {
      setError(
        `Build timeout must be a whole number of seconds, at most ${MAX_BUILD_TIMEOUT_SECONDS}.`
      );
      return;
    }

    // Validate against the EFFECTIVE service ports the runtime will bind: an
    // explicit value, else the inherited base, else the shared default. A
    // blank field still occupies its default port, so a tunnel on 8080/7680
    // must be caught here just like an explicit collision.
    const effectiveCodeServerPort =
      trimmedCodeServerPort !== ""
        ? Number(trimmedCodeServerPort)
        : (baseDefaults?.codeServerPort ?? DEFAULT_CODE_SERVER_PORT);
    const effectiveTerminalPort =
      trimmedTerminalPort !== ""
        ? Number(trimmedTerminalPort)
        : (baseDefaults?.terminalPort ?? DEFAULT_TERMINAL_PORT);
    const configuredPorts: ConfiguredSandboxPort[] = [
      ...ports.map((port) => ({ port, label: "tunnel port" })),
      { port: effectiveCodeServerPort, label: "code server port" },
      { port: effectiveTerminalPort, label: "terminal port" },
    ];
    const portConflict = findSandboxPortConflict(configuredPorts);
    if (portConflict) {
      setError(
        portConflict.kind === "reserved"
          ? `Port ${portConflict.port} is reserved for the internal terminal and cannot be used.`
          : "Code server, terminal, and tunnel ports must all be different."
      );
      return;
    }

    setSaving(true);
    try {
      // Every field follows the same rule: persist when edited, when this
      // scope already stored it, or at global scope (where the form IS the
      // stored defaults); otherwise omit it and keep inheriting.
      const settingsPayload: SandboxSettings = {};
      if (isGlobal || portRows !== null || ownSettings?.tunnelPorts !== undefined) {
        settingsPayload.tunnelPorts = ports;
      }
      if (isGlobal || terminalEnabled !== null || ownSettings?.terminalEnabled !== undefined) {
        settingsPayload.terminalEnabled = resolvedTerminalEnabled;
      }
      const codeServerPortValue = numberPayloadValue(
        isGlobal,
        codeServerPort,
        trimmedCodeServerPort,
        ownSettings?.codeServerPort
      );
      if (codeServerPortValue !== undefined) {
        settingsPayload.codeServerPort = codeServerPortValue;
      }
      const terminalPortValue = numberPayloadValue(
        isGlobal,
        terminalPort,
        trimmedTerminalPort,
        ownSettings?.terminalPort
      );
      if (terminalPortValue !== undefined) {
        settingsPayload.terminalPort = terminalPortValue;
      }
      const buildTimeoutValue = numberPayloadValue(
        isGlobal,
        buildTimeoutSeconds,
        trimmedBuildTimeout,
        ownSettings?.buildTimeoutSeconds
      );
      if (buildTimeoutValue !== undefined) {
        settingsPayload.buildTimeoutSeconds = buildTimeoutValue;
      }
      if (
        isGlobal ||
        maxConcurrentChildSessions !== null ||
        ownSettings?.maxConcurrentChildSessions !== undefined
      ) {
        settingsPayload.maxConcurrentChildSessions = Number(resolvedMaxConcurrentChildSessions);
      }
      if (
        isGlobal ||
        maxTotalChildSessions !== null ||
        ownSettings?.maxTotalChildSessions !== undefined
      ) {
        settingsPayload.maxTotalChildSessions = Number(resolvedMaxTotalChildSessions);
      }
      const cpu = resourcePayloadValue(isGlobal, cpuCores, trimmedCpu, ownSettings?.cpuCores);
      if (cpu !== undefined) settingsPayload.cpuCores = cpu;
      const memory = resourcePayloadValue(
        isGlobal,
        memoryMib,
        trimmedMemory,
        ownSettings?.memoryMib
      );
      if (memory !== undefined) settingsPayload.memoryMib = memory;
      const body = isGlobal
        ? { settings: { defaults: settingsPayload, enabledRepos } }
        : { settings: settingsPayload };

      const res = await fetch(apiUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Failed to save (${res.status})`);
      }

      await mutate();
      setPortRows(null);
      setTerminalEnabled(null);
      setMaxConcurrentChildSessions(null);
      setMaxTotalChildSessions(null);
      setCpuCores(null);
      setMemoryMib(null);
      setCodeServerPort(null);
      setTerminalPort(null);
      setBuildTimeoutSeconds(null);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [
    rows,
    isGlobal,
    apiUrl,
    mutate,
    enabledRepos,
    resolvedTerminalEnabled,
    resolvedMaxConcurrentChildSessions,
    resolvedMaxTotalChildSessions,
    resolvedCpuCores,
    resolvedMemoryMib,
    resolvedCodeServerPort,
    resolvedTerminalPort,
    resolvedBuildTimeoutSeconds,
    portRows,
    terminalEnabled,
    codeServerPort,
    terminalPort,
    buildTimeoutSeconds,
    cpuCores,
    memoryMib,
    maxConcurrentChildSessions,
    maxTotalChildSessions,
    ownSettings,
    baseDefaults?.codeServerPort,
    baseDefaults?.terminalPort,
  ]);

  const hasPortChanges =
    portRows !== null &&
    JSON.stringify(normalizePorts(portRows).ports) !== JSON.stringify(currentPorts);
  const hasTerminalChange = terminalEnabled !== null && terminalEnabled !== currentTerminalEnabled;
  const hasConcurrentLimitChange =
    maxConcurrentChildSessions !== null &&
    maxConcurrentChildSessions !== String(currentMaxConcurrentChildSessions);
  const hasTotalLimitChange =
    maxTotalChildSessions !== null &&
    maxTotalChildSessions !== String(currentMaxTotalChildSessions);
  const currentCpuCoresString = currentCpuCores !== undefined ? String(currentCpuCores) : "";
  const currentMemoryMibString = currentMemoryMib !== undefined ? String(currentMemoryMib) : "";
  const hasCpuChange = cpuCores !== null && cpuCores.trim() !== currentCpuCoresString;
  const hasMemoryChange = memoryMib !== null && memoryMib.trim() !== currentMemoryMibString;
  const currentCodeServerPortString =
    currentCodeServerPort !== undefined ? String(currentCodeServerPort) : "";
  const currentTerminalPortString =
    currentTerminalPort !== undefined ? String(currentTerminalPort) : "";
  const hasCodeServerPortChange =
    codeServerPort !== null && codeServerPort.trim() !== currentCodeServerPortString;
  const hasTerminalPortChange =
    terminalPort !== null && terminalPort.trim() !== currentTerminalPortString;
  const currentBuildTimeoutSecondsString =
    currentBuildTimeoutSeconds !== undefined ? String(currentBuildTimeoutSeconds) : "";
  const hasBuildTimeoutChange =
    buildTimeoutSeconds !== null && buildTimeoutSeconds.trim() !== currentBuildTimeoutSecondsString;
  const hasChanges =
    hasPortChanges ||
    hasTerminalChange ||
    hasConcurrentLimitChange ||
    hasTotalLimitChange ||
    hasCpuChange ||
    hasMemoryChange ||
    hasCodeServerPortChange ||
    hasTerminalPortChange ||
    hasBuildTimeoutChange;

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-4">
      {/* Web Terminal toggle */}
      <div className="max-w-sm">
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-foreground">Web Terminal</label>
            <p className="text-xs text-muted-foreground">
              Enable a browser-based terminal in sandbox sessions.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={resolvedTerminalEnabled}
            onClick={() => setTerminalEnabled(!resolvedTerminalEnabled)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              resolvedTerminalEnabled ? "bg-accent" : "bg-muted"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                resolvedTerminalEnabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Service Ports</label>
        <p className="text-xs text-muted-foreground mb-2">
          Ports code-server and the web terminal bind to. Leave blank for the defaults (
          {DEFAULT_CODE_SERVER_PORT} and {DEFAULT_TERMINAL_PORT}). Change a port to free the default
          for your own service on a tunnel. Code-server is enabled in its own settings.
        </p>
        <div className="grid gap-3 max-w-sm sm:grid-cols-2">
          <div>
            <label
              htmlFor="code-server-port"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Code server port
            </label>
            <Input
              id="code-server-port"
              type="text"
              inputMode="numeric"
              value={resolvedCodeServerPort}
              onChange={(e) => setCodeServerPort(e.target.value)}
              placeholder={String(DEFAULT_CODE_SERVER_PORT)}
            />
          </div>
          <div>
            <label
              htmlFor="terminal-port"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Terminal port
            </label>
            <Input
              id="terminal-port"
              type="text"
              inputMode="numeric"
              value={resolvedTerminalPort}
              onChange={(e) => setTerminalPort(e.target.value)}
              placeholder={String(DEFAULT_TERMINAL_PORT)}
            />
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between max-w-sm mb-1.5">
          <label className="block text-sm font-medium text-foreground">Tunnel Ports</label>
          <Button
            type="button"
            variant="subtle"
            size="xs"
            onClick={handleAddRow}
            disabled={rows.length >= MAX_TUNNEL_PORTS}
            className="text-accent hover:text-accent/80"
          >
            <PlusIcon className="w-3 h-3" />
            Add port
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-2">
          Expose additional ports from sandboxes via public tunnel URLs (e.g., dev server ports).
        </p>
        <div className="space-y-2 max-w-sm">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No tunnel ports configured.</p>
          ) : (
            rows.map((value, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="text"
                  inputMode="numeric"
                  value={value}
                  onChange={(e) => handleUpdateRow(index, e.target.value)}
                  placeholder="e.g. 3000"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  onClick={() => handleRemoveRow(index)}
                >
                  Remove
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Child Sessions</label>
        <p className="text-xs text-muted-foreground mb-2">
          Limit agent-spawned child sessions to prevent runaway sandbox usage.
        </p>
        <div className="grid gap-3 max-w-sm sm:grid-cols-2">
          <div>
            <label
              htmlFor="max-concurrent-child-sessions"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Max concurrent child sessions
            </label>
            <Input
              id="max-concurrent-child-sessions"
              type="number"
              min="1"
              inputMode="numeric"
              value={resolvedMaxConcurrentChildSessions}
              onChange={(e) => setMaxConcurrentChildSessions(e.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor="max-total-child-sessions"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Max total child sessions
            </label>
            <Input
              id="max-total-child-sessions"
              type="number"
              min="1"
              inputMode="numeric"
              value={resolvedMaxTotalChildSessions}
              onChange={(e) => setMaxTotalChildSessions(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Resources</label>
        <p className="text-xs text-muted-foreground mb-2">
          Reserve CPU and memory for each sandbox. Leave blank to use the provider&apos;s default
          reservation.
        </p>
        <div className="grid gap-3 max-w-sm sm:grid-cols-2">
          <div>
            <label
              htmlFor="sandbox-cpu-cores"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              CPU cores
            </label>
            <Input
              id="sandbox-cpu-cores"
              type="text"
              inputMode="decimal"
              value={resolvedCpuCores}
              onChange={(e) => setCpuCores(e.target.value)}
              placeholder="provider default"
            />
          </div>
          <div>
            <label
              htmlFor="sandbox-memory-mib"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Memory (MiB)
            </label>
            <Input
              id="sandbox-memory-mib"
              type="number"
              min={1}
              inputMode="numeric"
              value={resolvedMemoryMib}
              onChange={(e) => setMemoryMib(e.target.value)}
              placeholder="provider default"
            />
          </div>
        </div>
      </div>

      <div>
        <label
          htmlFor="sandbox-build-timeout"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Image Build Timeout
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          How long a pre-built image may take to build (clone + setup), in seconds. Raise it for
          large repositories with slow setup. Leave blank for the default (
          {DEFAULT_BUILD_TIMEOUT_SECONDS}s). Builds only — sessions are unaffected.
        </p>
        <div className="max-w-sm">
          <Input
            id="sandbox-build-timeout"
            type="number"
            min={1}
            max={MAX_BUILD_TIMEOUT_SECONDS}
            inputMode="numeric"
            value={resolvedBuildTimeoutSeconds}
            onChange={(e) => setBuildTimeoutSeconds(e.target.value)}
            placeholder={String(DEFAULT_BUILD_TIMEOUT_SECONDS)}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Maximum: {MAX_BUILD_TIMEOUT_SECONDS} seconds.
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !hasChanges} size="sm">
          {saving ? "Saving..." : "Save Settings"}
        </Button>
        {success && <span className="text-sm text-success">Saved</span>}
      </div>
    </div>
  );
}

export function SandboxSettingsPage() {
  const { repos, loading: loadingRepos } = useRepos();
  const [selectedRepo, setSelectedRepo] = useState(GLOBAL_SCOPE);

  const selectedRepoObj = repos.find((r) => r.fullName === selectedRepo);
  const isGlobal = selectedRepo === GLOBAL_SCOPE;
  const displayRepoName = isGlobal
    ? "All Repositories (Global)"
    : selectedRepoObj
      ? selectedRepoObj.fullName
      : loadingRepos
        ? "Loading..."
        : "Select a repository";

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Sandbox</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Configure sandbox environment settings. Per-repo settings override global defaults.
      </p>

      {/* Repo selector */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-foreground mb-1.5">Repository</label>
        <Combobox
          value={selectedRepo}
          onChange={setSelectedRepo}
          items={repos.map((repo) => ({
            value: repo.fullName,
            label: repo.name,
            description: `${repo.owner}${repo.private ? " \u2022 private" : ""}`,
          }))}
          searchable
          searchPlaceholder="Search repositories..."
          filterFn={(option, query) =>
            option.label.toLowerCase().includes(query) ||
            (option.description?.toLowerCase().includes(query) ?? false) ||
            String(option.value).toLowerCase().includes(query)
          }
          direction="down"
          dropdownWidth="w-full max-w-sm"
          disabled={loadingRepos}
          triggerClassName="w-full max-w-sm flex items-center justify-between px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
          prependContent={({ select }) => (
            <>
              <button
                type="button"
                onClick={() => select(GLOBAL_SCOPE)}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted transition ${
                  isGlobal ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                <div className="flex flex-col items-start text-left">
                  <span className="font-medium">All Repositories (Global)</span>
                  <span className="text-xs text-secondary-foreground">
                    Shared across all repositories
                  </span>
                </div>
                {isGlobal && <CheckIcon className="w-4 h-4 text-accent" />}
              </button>
              {repos.length > 0 && <div className="border-t border-border my-1" />}
            </>
          )}
        >
          <span className="truncate">{displayRepoName}</span>
          <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
        </Combobox>
      </div>

      {isGlobal ? (
        <SandboxSettingsEditor scope="global" />
      ) : selectedRepoObj ? (
        <SandboxSettingsEditor
          key={selectedRepoObj.fullName}
          scope="repo"
          owner={selectedRepoObj.owner}
          name={selectedRepoObj.name}
        />
      ) : null}
    </div>
  );
}
