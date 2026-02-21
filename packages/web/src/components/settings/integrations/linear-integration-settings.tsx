"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import {
  MODEL_REASONING_CONFIG,
  isValidReasoningEffort,
  type EnrichedRepository,
  type LinearBotSettings,
  type LinearGlobalConfig,
  type ValidModel,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { Button } from "@/components/ui/button";
import { RadioCard, Select } from "@/components/ui/form-controls";

const GLOBAL_SETTINGS_KEY = "/api/integration-settings/linear";
const REPO_SETTINGS_KEY = "/api/integration-settings/linear/repos";

interface GlobalResponse {
  settings: LinearGlobalConfig | null;
}

interface RepoSettingsEntry {
  repo: string;
  settings: LinearBotSettings;
}

interface RepoListResponse {
  repos: RepoSettingsEntry[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

export function LinearIntegrationSettings() {
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
      <h3 className="text-lg font-semibold text-foreground mb-1">Linear Agent</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Configure model defaults, repository targeting, and runtime behavior for Linear-triggered
        sessions.
      </p>

      <Section title="Connection" description="Linear uses control-plane repository access.">
        {availableRepos.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Repository access is available. You can target all repos or limit the integration to a
            selected allowlist.
          </p>
        ) : (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 px-4 py-3 rounded-sm">
            No repositories are currently accessible from the control plane. Repository filtering is
            unavailable until repository access is configured.
          </p>
        )}
      </Section>

      <GlobalSettingsSection
        settings={settings}
        availableRepos={availableRepos}
        enabledModelOptions={enabledModelOptions}
      />

      <Section
        title="Repository Overrides"
        description="Override model selection and behavior for specific repositories."
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
  enabledModelOptions,
}: {
  settings: LinearGlobalConfig | null | undefined;
  availableRepos: EnrichedRepository[];
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [model, setModel] = useState(settings?.defaults?.model ?? "");
  const [effort, setEffort] = useState(settings?.defaults?.reasoningEffort ?? "");
  const [enabledRepos, setEnabledRepos] = useState<string[]>(settings?.enabledRepos ?? []);
  const [repoScopeMode, setRepoScopeMode] = useState<"all" | "selected">(
    settings?.enabledRepos == null ? "all" : "selected"
  );
  const [allowUserPreferenceOverride, setAllowUserPreferenceOverride] = useState(
    settings?.defaults?.allowUserPreferenceOverride ?? true
  );
  const [allowLabelModelOverride, setAllowLabelModelOverride] = useState(
    settings?.defaults?.allowLabelModelOverride ?? true
  );
  const [emitToolProgressActivities, setEmitToolProgressActivities] = useState(
    settings?.defaults?.emitToolProgressActivities ?? true
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setModel(settings.defaults?.model ?? "");
        setEffort(settings.defaults?.reasoningEffort ?? "");
        setEnabledRepos(settings.enabledRepos ?? []);
        setRepoScopeMode(settings.enabledRepos === undefined ? "all" : "selected");
        setAllowUserPreferenceOverride(settings.defaults?.allowUserPreferenceOverride ?? true);
        setAllowLabelModelOverride(settings.defaults?.allowLabelModelOverride ?? true);
        setEmitToolProgressActivities(settings.defaults?.emitToolProgressActivities ?? true);
      }
      setInitialized(true);
    }
  }, [settings, initialized]);

  const isConfigured = settings !== null && settings !== undefined;
  const reasoningConfig = model ? MODEL_REASONING_CONFIG[model as ValidModel] : undefined;

  const resetNotice =
    "Reset all Linear settings to defaults? This enables both label/user model overrides.";

  const handleReset = async () => {
    if (!window.confirm(resetNotice)) {
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, { method: "DELETE" });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        setModel("");
        setEffort("");
        setEnabledRepos([]);
        setRepoScopeMode("all");
        setAllowUserPreferenceOverride(true);
        setAllowLabelModelOverride(true);
        setEmitToolProgressActivities(true);
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

    const defaults: LinearBotSettings = {
      allowUserPreferenceOverride,
      allowLabelModelOverride,
      emitToolProgressActivities,
    };

    if (model) defaults.model = model;
    if (effort) defaults.reasoningEffort = effort;

    const body: LinearGlobalConfig = { defaults };
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
    <Section
      title="Defaults & Scope"
      description="Global model, fallback behavior, and repository targeting."
    >
      {error && <Message tone="error" text={error} />}
      {success && <Message tone="success" text={success} />}

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <label className="text-sm">
          <span className="block text-foreground font-medium mb-1">Default model</span>
          <Select
            value={model}
            onChange={(e) => {
              const nextModel = e.target.value;
              setModel(nextModel);
              if (effort && nextModel && !isValidReasoningEffort(nextModel, effort)) {
                setEffort("");
              }
              setDirty(true);
              setError("");
              setSuccess("");
            }}
            className="w-full"
          >
            <option value="">Use system default</option>
            {enabledModelOptions.map((group) => (
              <optgroup key={group.category} label={group.category}>
                {group.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </label>

        <label className="text-sm">
          <span className="block text-foreground font-medium mb-1">Default reasoning effort</span>
          <Select
            value={effort}
            onChange={(e) => {
              setEffort(e.target.value);
              setDirty(true);
              setError("");
              setSuccess("");
            }}
            disabled={!reasoningConfig}
            className="w-full"
          >
            <option value="">Use model default</option>
            {(reasoningConfig?.efforts ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-2 mb-4">
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <span>Allow user model preferences</span>
          <input
            type="checkbox"
            checked={allowUserPreferenceOverride}
            onChange={() => {
              setAllowUserPreferenceOverride(!allowUserPreferenceOverride);
              setDirty(true);
              setError("");
              setSuccess("");
            }}
            className="rounded border-border"
          />
        </label>
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <span>Allow model labels (model:*)</span>
          <input
            type="checkbox"
            checked={allowLabelModelOverride}
            onChange={() => {
              setAllowLabelModelOverride(!allowLabelModelOverride);
              setDirty(true);
              setError("");
              setSuccess("");
            }}
            className="rounded border-border"
          />
        </label>
      </div>

      <div className="mb-4">
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <span>Emit tool progress activities</span>
          <input
            type="checkbox"
            checked={emitToolProgressActivities}
            onChange={() => {
              setEmitToolProgressActivities(!emitToolProgressActivities);
              setDirty(true);
              setError("");
              setSuccess("");
            }}
            className="rounded border-border"
          />
        </label>
      </div>

      <div className="mb-4">
        <p className="text-sm font-medium text-foreground mb-2">Repository Scope</p>
        <div className="grid sm:grid-cols-2 gap-2 mb-3">
          <RadioCard
            name="linear-repo-scope"
            checked={repoScopeMode === "all"}
            onChange={() => {
              setRepoScopeMode("all");
              setDirty(true);
              setError("");
              setSuccess("");
            }}
            label="All repositories"
            description="Linear events can run against every accessible repository."
          />
          <RadioCard
            name="linear-repo-scope"
            checked={repoScopeMode === "selected"}
            onChange={() => {
              setRepoScopeMode("selected");
              setDirty(true);
              setError("");
              setSuccess("");
            }}
            label="Selected repositories"
            description="Linear events run only for repositories in the allowlist."
          />
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
                No repositories selected. The Linear integration will ignore all issues.
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
      const res = await fetch(`/api/integration-settings/linear/repos/${owner}/${name}`, {
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
        <Select
          value={addingRepo}
          onChange={(e) => setAddingRepo(e.target.value)}
          className="flex-1"
        >
          <option value="">Select a repository...</option>
          {availableForOverride.map((repo) => (
            <option key={repo.fullName} value={repo.fullName.toLowerCase()}>
              {repo.fullName}
            </option>
          ))}
        </Select>
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
  const [allowUserPreferenceOverride, setAllowUserPreferenceOverride] = useState(
    entry.settings.allowUserPreferenceOverride ?? true
  );
  const [allowLabelModelOverride, setAllowLabelModelOverride] = useState(
    entry.settings.allowLabelModelOverride ?? true
  );
  const [emitToolProgressActivities, setEmitToolProgressActivities] = useState(
    entry.settings.emitToolProgressActivities ?? true
  );
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
    const settings: LinearBotSettings = {
      allowUserPreferenceOverride,
      allowLabelModelOverride,
      emitToolProgressActivities,
    };
    if (model) settings.model = model;
    if (effort) settings.reasoningEffort = effort;

    try {
      const res = await fetch(`/api/integration-settings/linear/repos/${owner}/${name}`, {
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
      const res = await fetch(`/api/integration-settings/linear/repos/${owner}/${name}`, {
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
    <div className="grid gap-2 px-4 py-3 border border-border rounded-sm">
      <div className="text-sm font-medium text-foreground">{entry.repo}</div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <Select value={model} onChange={(e) => handleModelChange(e.target.value)} density="compact">
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
        </Select>

        <Select
          value={effort}
          onChange={(e) => {
            setEffort(e.target.value);
            setDirty(true);
          }}
          disabled={!reasoningConfig}
          density="compact"
        >
          <option value="">Default effort</option>
          {(reasoningConfig?.efforts ?? []).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>

        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>Tool updates</span>
          <input
            type="checkbox"
            checked={emitToolProgressActivities}
            onChange={() => {
              setEmitToolProgressActivities(!emitToolProgressActivities);
              setDirty(true);
            }}
            className="rounded border-border"
          />
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-2">
        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>User preference override</span>
          <input
            type="checkbox"
            checked={allowUserPreferenceOverride}
            onChange={() => {
              setAllowUserPreferenceOverride(!allowUserPreferenceOverride);
              setDirty(true);
            }}
            className="rounded border-border"
          />
        </label>
        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>Label model override</span>
          <input
            type="checkbox"
            checked={allowLabelModelOverride}
            onChange={() => {
              setAllowLabelModelOverride(!allowLabelModelOverride);
              setDirty(true);
            }}
            className="rounded border-border"
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "..." : "Save"}
        </Button>

        <Button variant="destructive" size="sm" onClick={handleDelete}>
          Remove
        </Button>
      </div>
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
