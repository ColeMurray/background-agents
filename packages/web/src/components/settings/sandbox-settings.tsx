"use client";

import { useRepos } from "@/hooks/use-repos";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, CheckIcon, PlusIcon } from "@/components/ui/icons";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import useSWR from "swr";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import {
  DEFAULT_BUILD_TIMEOUT_SECONDS,
  DEFAULT_CODE_SERVER_PORT,
  DEFAULT_TERMINAL_PORT,
  DEFAULT_VNC_PORT,
  MAX_BUILD_TIMEOUT_SECONDS,
  MAX_TUNNEL_PORTS,
} from "@open-inspect/shared/types/integrations";
import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import { MIN_SANDBOX_TIMEOUT_MINUTES } from "./sandbox-timeout";
import { resolveSandboxSettingsDraft, type SandboxSettingsDraft } from "./sandbox-settings-draft";
import { SessionCostSettingsFields } from "./session-cost-settings-fields";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

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

interface EnvironmentSettingsResponse {
  integrationId: string;
  environmentId: string;
  settings: SandboxSettings | null;
}

const fetcher = (url: BrowserApiPath) => browserApiFetch(url).then((r) => r.json());

/** What a sandbox-settings scope reads/writes and what it inherits from. */
interface SandboxScopeModel {
  apiUrl: BrowserApiPath;
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
  const globalApiUrl: BrowserApiPath = "/api/integration-settings/sandbox";
  const repoPath =
    owner && name ? encodeRepositoryPathSegments({ repoOwner: owner, repoName: name }) : "";
  const repoApiUrl: BrowserApiPath = `/api/integration-settings/sandbox/repos/${repoPath}`;
  const apiUrl: BrowserApiPath = isGlobal
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

/**
 * Edits inherited sandbox settings for one scope, becoming read-only without that scope's management permission.
 */
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
  const { hasPermission } = useCurrentUserAuthorization();
  const isGlobal = scope === "global";
  const canManage = hasPermission(
    scope === "global"
      ? "integrations.manage"
      : scope === "repo"
        ? "repositories.settings.manage"
        : "environments.settings.manage"
  );
  const { apiUrl, ownSettings, baseDefaults, enabledRepos, isLoading, mutate } =
    useSandboxSettingsScope(scope, owner, name, environmentId);

  const [draft, setDraft] = useState<SandboxSettingsDraft>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const { values, hasChanges, result } = resolveSandboxSettingsDraft({
    isGlobal,
    ownSettings,
    baseDefaults,
    draft,
  });
  const rows = values.tunnelPorts;

  function updateField<K extends keyof SandboxSettingsDraft>(
    field: K,
    value: SandboxSettingsDraft[K]
  ) {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  const handleAddRow = () => {
    if (rows.length >= MAX_TUNNEL_PORTS) return;
    updateField("tunnelPorts", [...rows, ""]);
  };

  const handleUpdateRow = (index: number, value: string) => {
    const updated = [...rows];
    updated[index] = value;
    updateField("tunnelPorts", updated);
  };

  const handleRemoveRow = (index: number) => {
    const updated = rows.filter((_, i) => i !== index);
    updateField("tunnelPorts", updated);
  };

  const handleSave = async () => {
    setError(null);
    setSuccess(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    setSaving(true);
    try {
      const body = isGlobal
        ? { settings: { defaults: result.settings, enabledRepos } }
        : { settings: result.settings };

      const res = await browserApiFetch(apiUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Failed to save (${res.status})`);
      }

      await mutate();
      setDraft({});
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <fieldset disabled={!canManage} className="min-w-0 space-y-4">
      {/* Web Terminal toggle */}
      <div className="max-w-sm">
        <div className="flex items-center justify-between">
          <div>
            <label
              htmlFor="web-terminal-enabled"
              className="block text-sm font-medium text-foreground"
            >
              Web Terminal
            </label>
            <p className="text-xs text-muted-foreground">
              Enable a browser-based terminal in sandbox sessions.
            </p>
          </div>
          <button
            id="web-terminal-enabled"
            type="button"
            role="switch"
            aria-label="Web Terminal"
            aria-checked={values.terminalEnabled}
            onClick={() => updateField("terminalEnabled", !values.terminalEnabled)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              values.terminalEnabled ? "bg-accent" : "bg-muted"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                values.terminalEnabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      <fieldset className="min-w-0">
        <legend className="block text-sm font-medium text-foreground mb-1.5">Service Ports</legend>
        <p className="text-xs text-muted-foreground mb-2">
          Ports code-server, noVNC, and the web terminal bind to. Leave blank for the defaults (
          {DEFAULT_CODE_SERVER_PORT}, {DEFAULT_VNC_PORT}, and {DEFAULT_TERMINAL_PORT}). Change a
          port to free the default for your own service on a tunnel. Code-server and VNC are enabled
          in their own settings.
        </p>
        <div className="grid gap-3 max-w-lg sm:grid-cols-3">
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
              value={values.codeServerPort}
              onChange={(e) => updateField("codeServerPort", e.target.value)}
              placeholder={String(DEFAULT_CODE_SERVER_PORT)}
            />
          </div>
          <div>
            <label
              htmlFor="vnc-port"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              VNC port
            </label>
            <Input
              id="vnc-port"
              type="text"
              inputMode="numeric"
              value={values.vncPort}
              onChange={(e) => updateField("vncPort", e.target.value)}
              placeholder={String(DEFAULT_VNC_PORT)}
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
              value={values.terminalPort}
              onChange={(e) => updateField("terminalPort", e.target.value)}
              placeholder={String(DEFAULT_TERMINAL_PORT)}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="min-w-0">
        <legend className="sr-only">Tunnel Ports</legend>
        <div className="flex items-center justify-between max-w-sm mb-1.5">
          <span aria-hidden="true" className="block text-sm font-medium text-foreground">
            Tunnel Ports
          </span>
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
      </fieldset>

      <SessionCostSettingsFields
        isGlobal={isGlobal}
        maxSessionCostUsd={values.maxSessionCostUsd}
        onMaxSessionCostUsdChange={(value) => updateField("maxSessionCostUsd", value)}
      />

      <fieldset className="min-w-0">
        <legend className="block text-sm font-medium text-foreground mb-1.5">Child Sessions</legend>
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
              value={values.maxConcurrentChildSessions}
              onChange={(e) => updateField("maxConcurrentChildSessions", e.target.value)}
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
              value={values.maxTotalChildSessions}
              onChange={(e) => updateField("maxTotalChildSessions", e.target.value)}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="min-w-0">
        <legend className="block text-sm font-medium text-foreground mb-1.5">Resources</legend>
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
              value={values.cpuCores}
              onChange={(e) => updateField("cpuCores", e.target.value)}
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
              value={values.memoryMib}
              onChange={(e) => updateField("memoryMib", e.target.value)}
              placeholder="provider default"
            />
          </div>
        </div>
      </fieldset>

      <div>
        <label
          htmlFor="sandbox-session-timeout"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Session Timeout (minutes)
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          Requested lifetime for each sandbox session, in minutes. Leave blank to inherit a parent
          setting, or use the provider default if none is configured. Provider support and limits
          vary.
        </p>
        <div className="max-w-sm">
          <Input
            id="sandbox-session-timeout"
            type="number"
            min={MIN_SANDBOX_TIMEOUT_MINUTES}
            step={MIN_SANDBOX_TIMEOUT_MINUTES}
            inputMode="decimal"
            value={values.sandboxTimeoutMinutes}
            onChange={(e) => updateField("sandboxTimeoutMinutes", e.target.value)}
            placeholder="provider default"
          />
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
            value={values.buildTimeoutSeconds}
            onChange={(e) => updateField("buildTimeoutSeconds", e.target.value)}
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
    </fieldset>
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
        <label
          id="sandbox-repository-label"
          htmlFor="sandbox-repository"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Repository
        </label>
        <Combobox
          id="sandbox-repository"
          labelId="sandbox-repository-label"
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
