"use client";

import { useRepos } from "@/hooks/use-repos";
import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, CheckIcon, PlusIcon } from "@/components/ui/icons";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import useSWR from "swr";
import type { SandboxSettings } from "@open-inspect/shared";
import {
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
  MAX_TUNNEL_PORTS,
} from "@open-inspect/shared";

const GLOBAL_SCOPE = "__global__";

interface GlobalSettingsResponse {
  integrationId: string;
  settings: { defaults?: SandboxSettings; enabledRepos?: string[] } | null;
}

interface RepoSettingsResponse {
  integrationId: string;
  repo: string;
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

function SandboxSettingsEditor({
  scope,
  owner,
  name,
}: {
  scope: "global" | "repo";
  owner?: string;
  name?: string;
}) {
  const isGlobal = scope === "global";
  const globalApiUrl = "/api/integration-settings/sandbox";
  const apiUrl = isGlobal
    ? globalApiUrl
    : `/api/integration-settings/sandbox/repos/${owner}/${name}`;

  const { data, mutate, isLoading } = useSWR<GlobalSettingsResponse | RepoSettingsResponse>(
    apiUrl,
    fetcher
  );
  const { data: globalData, isLoading: isLoadingGlobal } = useSWR<GlobalSettingsResponse>(
    isGlobal ? null : globalApiUrl,
    fetcher
  );

  const globalDefaults = isGlobal
    ? (data as GlobalSettingsResponse | undefined)?.settings?.defaults
    : globalData?.settings?.defaults;
  const repoSettings = isGlobal ? undefined : (data as RepoSettingsResponse | undefined)?.settings;

  const currentPorts: number[] = isGlobal
    ? ((data as GlobalSettingsResponse)?.settings?.defaults?.tunnelPorts ?? [])
    : ((data as RepoSettingsResponse)?.settings?.tunnelPorts ?? []);

  const currentTerminalEnabled: boolean = isGlobal
    ? ((data as GlobalSettingsResponse)?.settings?.defaults?.terminalEnabled ?? false)
    : ((data as RepoSettingsResponse)?.settings?.terminalEnabled ?? false);

  const currentMaxConcurrentChildSessions: number = isGlobal
    ? (globalDefaults?.maxConcurrentChildSessions ?? DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS)
    : (repoSettings?.maxConcurrentChildSessions ??
      globalDefaults?.maxConcurrentChildSessions ??
      DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS);

  const currentMaxTotalChildSessions: number = isGlobal
    ? (globalDefaults?.maxTotalChildSessions ?? DEFAULT_MAX_TOTAL_CHILD_SESSIONS)
    : (repoSettings?.maxTotalChildSessions ??
      globalDefaults?.maxTotalChildSessions ??
      DEFAULT_MAX_TOTAL_CHILD_SESSIONS);

  // Resource reservations have no app-level default — unset means "use the
  // provider's default reservation", so resolve to an empty string, not a number.
  const currentCpuCores: number | undefined = isGlobal
    ? globalDefaults?.cpuCores
    : (repoSettings?.cpuCores ?? globalDefaults?.cpuCores);
  const currentMemoryMib: number | undefined = isGlobal
    ? globalDefaults?.memoryMib
    : (repoSettings?.memoryMib ?? globalDefaults?.memoryMib);

  const [portRows, setPortRows] = useState<string[] | null>(null);
  const [terminalEnabled, setTerminalEnabled] = useState<boolean | null>(null);
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

    setSaving(true);
    try {
      const existingEnabledRepos = isGlobal
        ? (data as GlobalSettingsResponse)?.settings?.enabledRepos
        : undefined;
      const settingsPayload: SandboxSettings = {
        tunnelPorts: ports,
        terminalEnabled: resolvedTerminalEnabled,
      };
      if (
        isGlobal ||
        maxConcurrentChildSessions !== null ||
        repoSettings?.maxConcurrentChildSessions !== undefined
      ) {
        settingsPayload.maxConcurrentChildSessions = Number(resolvedMaxConcurrentChildSessions);
      }
      if (
        isGlobal ||
        maxTotalChildSessions !== null ||
        repoSettings?.maxTotalChildSessions !== undefined
      ) {
        settingsPayload.maxTotalChildSessions = Number(resolvedMaxTotalChildSessions);
      }
      // Omit when blank so the field is dropped from stored settings and the
      // provider's default reservation applies. For a repo, only persist a value
      // that is global, explicitly edited, or already an override — otherwise an
      // inherited global default would get pinned as a per-repo override.
      if (
        trimmedCpu !== "" &&
        (isGlobal || cpuCores !== null || repoSettings?.cpuCores !== undefined)
      ) {
        settingsPayload.cpuCores = Number(trimmedCpu);
      }
      if (
        trimmedMemory !== "" &&
        (isGlobal || memoryMib !== null || repoSettings?.memoryMib !== undefined)
      ) {
        settingsPayload.memoryMib = Number(trimmedMemory);
      }
      const body = isGlobal
        ? { settings: { defaults: settingsPayload, enabledRepos: existingEnabledRepos } }
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
    data,
    resolvedTerminalEnabled,
    resolvedMaxConcurrentChildSessions,
    resolvedMaxTotalChildSessions,
    resolvedCpuCores,
    resolvedMemoryMib,
    cpuCores,
    memoryMib,
    maxConcurrentChildSessions,
    maxTotalChildSessions,
    repoSettings?.maxConcurrentChildSessions,
    repoSettings?.maxTotalChildSessions,
    repoSettings?.cpuCores,
    repoSettings?.memoryMib,
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
  const hasChanges =
    hasPortChanges ||
    hasTerminalChange ||
    hasConcurrentLimitChange ||
    hasTotalLimitChange ||
    hasCpuChange ||
    hasMemoryChange;

  if (isLoading || isLoadingGlobal) {
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
