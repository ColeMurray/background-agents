"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import {
  MODEL_REASONING_CONFIG,
  isValidReasoningEffort,
  type EnrichedRepository,
  type GitHubBotSettings,
  type GitHubGlobalConfig,
  type ValidModel,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { Button } from "@/components/ui/button";

const GLOBAL_SETTINGS_KEY = "/api/integration-settings/github";
const REPO_SETTINGS_KEY = "/api/integration-settings/github/repos";

interface GlobalResponse {
  settings: GitHubGlobalConfig | null;
}

interface RepoSettingsEntry {
  repo: string;
  settings: GitHubBotSettings;
}

interface RepoListResponse {
  repos: RepoSettingsEntry[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

export function GitHubIntegrationSettings() {
  const { data: globalData, isLoading: globalLoading } =
    useSWR<GlobalResponse>(GLOBAL_SETTINGS_KEY);
  const { data: repoSettingsData, isLoading: repoSettingsLoading } =
    useSWR<RepoListResponse>(REPO_SETTINGS_KEY);
  const { data: reposData } = useSWR<ReposResponse>("/api/repos");
  const { enabledModelOptions } = useEnabledModels();

  if (globalLoading || repoSettingsLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  const settings = globalData?.settings;
  const repoOverrides = repoSettingsData?.repos ?? [];
  const availableRepos = reposData?.repos ?? [];

  return (
    <div>
      <h3 className="text-lg font-semibold text-foreground mb-1">GitHub Bot</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Configure automated PR reviews and comment-triggered actions.
      </p>

      <Section
        title="Connection"
        description="GitHub App access used for repo discovery and scope."
      >
        {availableRepos.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Repository access is available. You can limit the bot to selected repositories below.
          </p>
        ) : (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 px-4 py-3 rounded-sm">
            GitHub App is not configured or has no accessible repositories. Repository filtering is
            currently unavailable.
          </p>
        )}
      </Section>

      <GlobalSettingsSection settings={settings} availableRepos={availableRepos} />

      <Section
        title="Repository Overrides"
        description="Set model and reasoning overrides for specific repositories."
      >
        <RepoOverridesSection
          overrides={repoOverrides}
          availableRepos={availableRepos}
          enabledModelOptions={enabledModelOptions}
        />
      </Section>
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
  const [repoScopeMode, setRepoScopeMode] = useState<"all" | "selected">(
    settings?.enabledRepos === undefined ? "all" : "selected"
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setAutoReviewOnOpen(settings.defaults?.autoReviewOnOpen ?? true);
        setEnabledRepos(settings.enabledRepos ?? []);
        setRepoScopeMode(settings.enabledRepos === undefined ? "all" : "selected");
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
        setRepoScopeMode("all");
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

    if (repoScopeMode === "selected") {
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
    <Section title="Defaults & Scope" description="Global behavior and repository targeting.">
      {error && <Message tone="error" text={error} />}
      {success && <Message tone="success" text={success} />}

      <label className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition cursor-pointer mb-4 rounded-sm">
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

      <div className="mb-4">
        <p className="text-sm font-medium text-foreground mb-2">Repository Scope</p>
        <div className="grid sm:grid-cols-2 gap-2 mb-3">
          <label className="flex items-center gap-2 px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
            <input
              type="radio"
              name="repo-scope"
              checked={repoScopeMode === "all"}
              onChange={() => {
                setRepoScopeMode("all");
                setDirty(true);
                setError("");
                setSuccess("");
              }}
            />
            All repositories
          </label>
          <label className="flex items-center gap-2 px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
            <input
              type="radio"
              name="repo-scope"
              checked={repoScopeMode === "selected"}
              onChange={() => {
                setRepoScopeMode("selected");
                setDirty(true);
                setError("");
                setSuccess("");
              }}
            />
            Selected repositories
          </label>
        </div>

        {repoScopeMode === "selected" && (
          <>
            {availableRepos.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-3 border border-border rounded-sm">
                Repository filtering is unavailable because no repositories are accessible.
              </p>
            ) : (
              <div className="border border-border max-h-56 overflow-y-auto rounded-sm">
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
              <p className="text-xs text-amber-700 mt-1">
                No repositories selected. The bot will not respond to webhooks.
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>

        {isConfigured && (
          <Button variant="destructive" onClick={handleReset} disabled={saving}>
            Reset to defaults
          </Button>
        )}
      </div>
    </Section>
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
  const [addingRepo, setAddingRepo] = useState("");
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
      {error && <Message tone="error" text={error} />}
      {success && <Message tone="success" text={success} />}

      {overrides.length > 0 ? (
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
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          No repository overrides yet. Add one to customize model behavior per repo.
        </p>
      )}

      <div className="flex items-center gap-2">
        <select
          value={addingRepo}
          onChange={(e) => setAddingRepo(e.target.value)}
          className="flex-1 px-3 py-2 text-sm border border-border bg-background text-foreground rounded-sm"
        >
          <option value="">Select a repository...</option>
          {availableForOverride.map((repo) => (
            <option key={repo.fullName} value={repo.fullName.toLowerCase()}>
              {repo.fullName}
            </option>
          ))}
        </select>
        <Button onClick={handleAdd} disabled={!addingRepo}>
          Add Override
        </Button>
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
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 border border-border rounded-sm">
      <span className="text-sm font-medium text-foreground min-w-[180px] truncate">
        {entry.repo}
      </span>

      <select
        value={model}
        onChange={(e) => handleModelChange(e.target.value)}
        className="flex-1 min-w-[180px] px-2 py-1 text-sm border border-border bg-background text-foreground rounded-sm"
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
          className="w-36 px-2 py-1 text-sm border border-border bg-background text-foreground rounded-sm"
        >
          <option value="">Default effort</option>
          {reasoningConfig.efforts.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      )}

      <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
        {saving ? "..." : "Save"}
      </Button>

      <Button variant="destructive" size="sm" onClick={handleDelete}>
        Remove
      </Button>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-border-muted rounded-md p-5 mb-5">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-foreground mb-1">
        {title}
      </h4>
      <p className="text-sm text-muted-foreground mb-4">{description}</p>
      {children}
    </section>
  );
}

function Message({ tone, text }: { tone: "error" | "success"; text: string }) {
  const classes =
    tone === "error"
      ? "mb-4 bg-red-50 text-red-700 px-4 py-3 border border-red-200 text-sm rounded-sm"
      : "mb-4 bg-green-50 text-green-700 px-4 py-3 border border-green-200 text-sm rounded-sm";

  return (
    <div className={classes} aria-live="polite">
      {text}
    </div>
  );
}
