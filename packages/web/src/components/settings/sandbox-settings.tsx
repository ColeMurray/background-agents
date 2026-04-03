"use client";

import { useRepos } from "@/hooks/use-repos";
import { useState, useCallback } from "react";
import { ChevronDownIcon, CheckIcon } from "@/components/ui/icons";
import { Combobox } from "@/components/ui/combobox";
import useSWR from "swr";
import type { SandboxSettings } from "@open-inspect/shared";

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

function parsePorts(value: string): number[] {
  const seen = new Set<number>();
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number)
    .filter((n) => n >= 1 && n <= 65535 && !seen.has(n) && seen.add(n));
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

  const [portsInput, setPortsInput] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Use current ports as display value unless user is editing
  const displayValue = portsInput ?? currentPorts.join(", ");

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const ports = parsePorts(displayValue);
      // Preserve existing enabledRepos when saving global settings
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

      setPortsInput(null);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [displayValue, isGlobal, apiUrl, mutate, data]);

  const hasChanges = portsInput !== null && portsInput !== currentPorts.join(", ");

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Tunnel Ports</label>
        <p className="text-xs text-muted-foreground mb-2">
          Expose additional ports from sandboxes via public tunnel URLs (e.g., dev server ports).
        </p>
        <input
          type="text"
          value={displayValue}
          onChange={(e) => setPortsInput(e.target.value)}
          placeholder="e.g. 3000, 3001, 5173"
          className="w-full max-w-sm px-3 py-2 text-sm border border-border bg-input text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent transition"
        />
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
