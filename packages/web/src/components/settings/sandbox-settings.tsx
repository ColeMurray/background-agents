"use client";

import { useRepos } from "@/hooks/use-repos";
import { useState, useCallback } from "react";
import { ChevronDownIcon, CheckIcon, PlusIcon } from "@/components/ui/icons";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import useSWR from "swr";
import type { SandboxSettings } from "@open-inspect/shared";
import { MAX_TUNNEL_PORTS } from "@open-inspect/shared";

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
  const apiUrl = isGlobal
    ? "/api/integration-settings/sandbox"
    : `/api/integration-settings/sandbox/repos/${owner}/${name}`;

  const { data, mutate, isLoading } = useSWR<GlobalSettingsResponse | RepoSettingsResponse>(
    apiUrl,
    fetcher
  );

  const currentPorts: number[] = isGlobal
    ? ((data as GlobalSettingsResponse)?.settings?.defaults?.tunnelPorts ?? [])
    : ((data as RepoSettingsResponse)?.settings?.tunnelPorts ?? []);

  const [portRows, setPortRows] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Use server state unless user is editing
  const rows = portRows ?? currentPorts.map(String);

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

    setSaving(true);
    try {
      const existingEnabledRepos = isGlobal
        ? (data as GlobalSettingsResponse)?.settings?.enabledRepos
        : undefined;
      const body = isGlobal
        ? { settings: { defaults: { tunnelPorts: ports }, enabledRepos: existingEnabledRepos } }
        : { settings: { tunnelPorts: ports } };

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
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [rows, isGlobal, apiUrl, mutate, data]);

  const hasChanges =
    portRows !== null &&
    JSON.stringify(normalizePorts(portRows).ports) !== JSON.stringify(currentPorts);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between max-w-sm mb-1.5">
          <label className="block text-sm font-medium text-foreground">Tunnel Ports</label>
          <button
            type="button"
            onClick={handleAddRow}
            disabled={rows.length >= MAX_TUNNEL_PORTS}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <PlusIcon className="w-3 h-3" />
            Add port
          </button>
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
                <button
                  type="button"
                  onClick={() => handleRemoveRow(index)}
                  className="text-xs px-2 py-1 border border-border-muted text-muted-foreground hover:text-red-500 hover:border-red-300 transition"
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className="px-3 py-1.5 text-sm bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
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
