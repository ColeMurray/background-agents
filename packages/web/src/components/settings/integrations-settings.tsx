"use client";

import { useState, useEffect } from "react";
import useSWR, { mutate } from "swr";
import {
  MODEL_REASONING_CONFIG,
  isValidReasoningEffort,
  type GitHubGlobalConfig,
  type GitHubBotSettings,
  type EnrichedRepository,
  type ValidModel,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";

const GLOBAL_SETTINGS_KEY = "/api/integration-settings/github";
const REPO_SETTINGS_KEY = "/api/integration-settings/github/repos";

interface GlobalResponse {
  integrationId: string;
  settings: GitHubGlobalConfig | null;
}

interface RepoSettingsEntry {
  repo: string;
  settings: GitHubBotSettings;
}

interface RepoListResponse {
  integrationId: string;
  repos: RepoSettingsEntry[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

export function IntegrationsSettings() {
  const { data: globalData, isLoading: globalLoading } =
    useSWR<GlobalResponse>(GLOBAL_SETTINGS_KEY);
  const { data: repoSettingsData, isLoading: repoSettingsLoading } =
    useSWR<RepoListResponse>(REPO_SETTINGS_KEY);
  const { data: reposData } = useSWR<ReposResponse>("/api/repos");
  const { enabledModelOptions } = useEnabledModels();

  const loading = globalLoading || repoSettingsLoading;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        Loading integration settings...
      </div>
    );
  }

  const settings = globalData?.settings;
  const repoOverrides = repoSettingsData?.repos ?? [];
  const availableRepos = reposData?.repos ?? [];

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">GitHub Bot</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Configure automated PR reviews and comment-triggered actions.
      </p>

      <GlobalSettingsSection settings={settings} availableRepos={availableRepos} />

      <div className="mt-8 border-t border-border-muted pt-8">
        <RepoOverridesSection
          overrides={repoOverrides}
          availableRepos={availableRepos}
          enabledModelOptions={enabledModelOptions}
        />
      </div>
    </div>
  );
}

function GlobalSettingsSection({
  settings,
  availableRepos,
}: {
  settings: GitHubGlobalConfig | null | undefined;
  availableRepos: EnrichedRepository[];
}) {
  const [autoReviewOnOpen, setAutoReviewOnOpen] = useState(
    settings?.defaults?.autoReviewOnOpen ?? true
  );
  const [enabledRepos, setEnabledRepos] = useState<string[]>(settings?.enabledRepos ?? []);
  const [allReposMode, setAllReposMode] = useState(settings?.enabledRepos === undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Sync SWR data into local state once on initial load
  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setAutoReviewOnOpen(settings.defaults?.autoReviewOnOpen ?? true);
        setEnabledRepos(settings.enabledRepos ?? []);
        setAllReposMode(settings.enabledRepos === undefined);
      }
      setInitialized(true);
    }
  }, [settings, initialized]);

  const isConfigured = settings !== null && settings !== undefined;

  const handleReset = async () => {
    if (
      !window.confirm(
        "Reset all GitHub bot settings to defaults? The bot will respond to all repos with auto-review enabled."
      )
    ) {
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, { method: "DELETE" });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        setAutoReviewOnOpen(true);
        setEnabledRepos([]);
        setAllReposMode(true);
        setDirty(false);
        setSuccess("Settings reset to defaults.");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to reset settings");
      }
    } catch {
      setError("Failed to reset settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSuccess("");

    const body: GitHubGlobalConfig = {
      defaults: { autoReviewOnOpen },
    };
    if (!allReposMode) {
      body.enabledRepos = enabledRepos;
    }

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        setSuccess("Settings saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to save settings");
      }
    } catch {
      setError("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const toggleRepo = (fullName: string) => {
    const lower = fullName.toLowerCase();
    setEnabledRepos((prev) =>
      prev.includes(lower) ? prev.filter((r) => r !== lower) : [...prev, lower]
    );
    setDirty(true);
    setError("");
    setSuccess("");
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-foreground uppercase tracking-wider mb-3">
        Global Settings
      </h3>

      {error && (
        <div className="mb-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 border border-red-200 dark:border-red-800 text-sm">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 px-4 py-3 border border-green-200 dark:border-green-800 text-sm">
          {success}
        </div>
      )}

      {/* Auto-review toggle */}
      <label className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition cursor-pointer mb-4">
        <div>
          <span className="text-sm font-medium text-foreground">Auto-review new PRs</span>
          <span className="text-sm text-muted-foreground ml-2">
            Automatically review non-draft PRs when opened
          </span>
        </div>
        <div className="relative">
          <input
            type="checkbox"
            checked={autoReviewOnOpen}
            onChange={() => {
              setAutoReviewOnOpen(!autoReviewOnOpen);
              setDirty(true);
              setError("");
              setSuccess("");
            }}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-muted rounded-full peer-checked:bg-accent transition-colors" />
          <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
        </div>
      </label>

      {/* Repo scope */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-foreground">Enabled Repositories</span>
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={allReposMode}
              onChange={() => {
                setAllReposMode(!allReposMode);
                setDirty(true);
                setError("");
                setSuccess("");
              }}
              className="rounded border-border"
            />
            All repos
          </label>
        </div>

        {!allReposMode && (
          <>
            {availableRepos.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-3 border border-border">
                GitHub App not configured — repository filtering unavailable. The bot will respond
                to all repos.
              </p>
            ) : (
              <div className="border border-border max-h-48 overflow-y-auto">
                {availableRepos.map((repo) => {
                  const fullName = repo.fullName.toLowerCase();
                  const isChecked = enabledRepos.includes(fullName);
                  return (
                    <label
                      key={repo.fullName}
                      className="flex items-center gap-2 px-4 py-2 hover:bg-muted/50 transition cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleRepo(repo.fullName)}
                        className="rounded border-border"
                      />
                      <span className="text-foreground">{repo.fullName}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {enabledRepos.length === 0 && availableRepos.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                No repos selected — the bot will not respond to any webhooks.
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className="px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {saving ? "Saving..." : "Save"}
        </button>

        {isConfigured && (
          <button
            type="button"
            onClick={handleReset}
            disabled={saving}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            Reset to defaults
          </button>
        )}
      </div>
    </div>
  );
}

function RepoOverridesSection({
  overrides,
  availableRepos,
  enabledModelOptions,
}: {
  overrides: RepoSettingsEntry[];
  availableRepos: EnrichedRepository[];
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [addingRepo, setAddingRepo] = useState<string>("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const overriddenRepos = new Set(overrides.map((o) => o.repo));
  const availableForOverride = availableRepos.filter(
    (r) => !overriddenRepos.has(r.fullName.toLowerCase())
  );

  const handleAdd = async () => {
    if (!addingRepo) return;
    const [owner, name] = addingRepo.split("/");
    setError("");
    setSuccess("");

    try {
      const res = await fetch(`/api/integration-settings/github/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: {} }),
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        setAddingRepo("");
        setSuccess("Override added.");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to add override");
      }
    } catch {
      setError("Failed to add override");
    }
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-foreground uppercase tracking-wider mb-1">
        Per-Repo Model Overrides
      </h3>
      <p className="text-sm text-muted-foreground mb-4">
        Repos without an override use the deployment default.
      </p>

      {error && (
        <div className="mb-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 border border-red-200 dark:border-red-800 text-sm">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 px-4 py-3 border border-green-200 dark:border-green-800 text-sm">
          {success}
        </div>
      )}

      {overrides.length > 0 && (
        <div className="space-y-2 mb-4">
          {overrides.map((entry) => (
            <RepoOverrideRow
              key={entry.repo}
              entry={entry}
              enabledModelOptions={enabledModelOptions}
              onError={setError}
              onSuccess={setSuccess}
            />
          ))}
        </div>
      )}

      {/* Add override */}
      <div className="flex items-center gap-2">
        <select
          value={addingRepo}
          onChange={(e) => setAddingRepo(e.target.value)}
          className="flex-1 px-3 py-2 text-sm border border-border bg-background text-foreground"
        >
          <option value="">Select a repo...</option>
          {availableForOverride.map((repo) => (
            <option key={repo.fullName} value={repo.fullName.toLowerCase()}>
              {repo.fullName}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!addingRepo}
          className="px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          Add Override
        </button>
      </div>
    </div>
  );
}

function RepoOverrideRow({
  entry,
  enabledModelOptions,
  onError,
  onSuccess,
}: {
  entry: RepoSettingsEntry;
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}) {
  const [model, setModel] = useState(entry.settings.model ?? "");
  const [effort, setEffort] = useState(entry.settings.reasoningEffort ?? "");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const reasoningConfig = model ? MODEL_REASONING_CONFIG[model as ValidModel] : undefined;

  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    setDirty(true);
    // Clear stale effort if invalid for new model
    if (effort && newModel && !isValidReasoningEffort(newModel, effort)) {
      setEffort("");
    }
  };

  const handleSave = async () => {
    setSaving(true);
    onError("");
    onSuccess("");

    const [owner, name] = entry.repo.split("/");
    const settings: GitHubBotSettings = {};
    if (model) settings.model = model;
    if (effort) settings.reasoningEffort = effort;

    try {
      const res = await fetch(`/api/integration-settings/github/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        setDirty(false);
        onSuccess(`Override for ${entry.repo} saved.`);
      } else {
        const data = await res.json();
        onError(data.error || "Failed to save override");
      }
    } catch {
      onError("Failed to save override");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const [owner, name] = entry.repo.split("/");
    onError("");
    onSuccess("");

    try {
      const res = await fetch(`/api/integration-settings/github/repos/${owner}/${name}`, {
        method: "DELETE",
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        onSuccess(`Override for ${entry.repo} removed.`);
      } else {
        const data = await res.json();
        onError(data.error || "Failed to delete override");
      }
    } catch {
      onError("Failed to delete override");
    }
  };

  return (
    <div className="flex items-center gap-2 px-4 py-3 border border-border">
      <span className="text-sm font-medium text-foreground min-w-[140px] truncate">
        {entry.repo}
      </span>

      <select
        value={model}
        onChange={(e) => handleModelChange(e.target.value)}
        className="flex-1 px-2 py-1 text-sm border border-border bg-background text-foreground"
      >
        <option value="">Default model</option>
        {enabledModelOptions.map((group) => (
          <optgroup key={group.category} label={group.category}>
            {group.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {reasoningConfig && (
        <select
          value={effort}
          onChange={(e) => {
            setEffort(e.target.value);
            setDirty(true);
          }}
          className="w-28 px-2 py-1 text-sm border border-border bg-background text-foreground"
        >
          <option value="">Default effort</option>
          {reasoningConfig.efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={saving || !dirty}
        className="px-3 py-1 text-sm font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {saving ? "..." : "Save"}
      </button>

      <button
        type="button"
        onClick={handleDelete}
        className="px-3 py-1 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition"
        title="Remove override"
      >
        Remove
      </button>
    </div>
  );
}
