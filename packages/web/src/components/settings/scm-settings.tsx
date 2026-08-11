"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  type ScmRepoSettings,
  type ScmSettings,
  type ScmGlobalConfig,
} from "@open-inspect/shared/types/integrations";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import {
  encodeRepositoryPathSegments,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";
import { IntegrationSettingsSkeleton } from "./integrations/integration-settings-skeleton";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const GLOBAL_SETTINGS_KEY = "/api/scm-settings";
const REPO_SETTINGS_KEY = "/api/scm-settings/repos";
const DEFAULT_ALWAYS_USE_DRAFT_MODE = false;
const DEFAULT_PULL_REQUEST_LABEL = "";

export function getScmRepoSettingsPath(fullName: string): `/api/${string}` | null {
  const repository = parseRepositoryFullName(fullName);
  return repository ? `${REPO_SETTINGS_KEY}/${encodeRepositoryPathSegments(repository)}` : null;
}

interface GlobalResponse {
  settings: ScmGlobalConfig | null;
}

interface RepoSettingsEntry {
  repo: string;
  settings: ScmRepoSettings;
}

interface RepoListResponse {
  repos: RepoSettingsEntry[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScmSettings(value: unknown): value is ScmSettings {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).some((key) => key !== "alwaysUseDraftMode" && key !== "pullRequestLabel")
  ) {
    return false;
  }
  return (
    (value.alwaysUseDraftMode === undefined || typeof value.alwaysUseDraftMode === "boolean") &&
    (value.pullRequestLabel === undefined || typeof value.pullRequestLabel === "string")
  );
}

function isScmRepoSettings(value: unknown): value is ScmRepoSettings {
  return isScmSettings(value);
}

function isGlobalResponse(value: unknown): value is GlobalResponse {
  if (!isRecord(value) || !("settings" in value)) return false;
  if (value.settings === null) return true;
  if (!isRecord(value.settings)) return false;
  if (Object.keys(value.settings).some((key) => key !== "defaults")) return false;
  if (value.settings.defaults === undefined) return true;
  return isScmSettings(value.settings.defaults);
}

function isRepoListResponse(value: unknown): value is RepoListResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.repos) &&
    value.repos.every(
      (entry) =>
        isRecord(entry) && typeof entry.repo === "string" && isScmRepoSettings(entry.settings)
    )
  );
}

export function ScmSettingsPage() {
  const {
    data: globalData,
    error: globalError,
    isLoading: globalLoading,
  } = useSWR<unknown>(GLOBAL_SETTINGS_KEY);
  const {
    data: repoSettingsData,
    error: repoSettingsError,
    isLoading: repoSettingsLoading,
  } = useSWR<unknown>(REPO_SETTINGS_KEY);
  const { data: reposData } = useSWR<ReposResponse>("/api/repos");

  if (globalLoading || repoSettingsLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  if (
    globalError ||
    repoSettingsError ||
    !isGlobalResponse(globalData) ||
    !isRepoListResponse(repoSettingsData)
  ) {
    return (
      <div role="alert" className="border border-destructive/40 rounded-md p-5 text-sm">
        Unable to load source control settings. Refresh the page to try again.
      </div>
    );
  }

  const settings = globalData.settings;
  const repoOverrides = repoSettingsData.repos;
  const availableRepos = reposData?.repos ?? [];

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">
        Source Code Management Settings
      </h2>
      <p className="text-sm text-muted-foreground mb-6">
        Defaults for pull and merge requests opened by coding sessions.
      </p>

      <GlobalSettingsSection settings={settings} />

      <Section
        title="Repository Overrides"
        description="Override pull and merge request defaults for specific repositories."
      >
        <RepoOverridesSection
          overrides={repoOverrides}
          availableRepos={availableRepos}
          globalDefault={settings?.defaults?.alwaysUseDraftMode ?? DEFAULT_ALWAYS_USE_DRAFT_MODE}
          globalLabel={settings?.defaults?.pullRequestLabel}
        />
      </Section>
    </div>
  );
}

function GlobalSettingsSection({ settings }: { settings: ScmGlobalConfig | null | undefined }) {
  const [alwaysUseDraftMode, setAlwaysUseDraftMode] = useState(
    settings?.defaults?.alwaysUseDraftMode ?? DEFAULT_ALWAYS_USE_DRAFT_MODE
  );
  const [pullRequestLabel, setPullRequestLabel] = useState(
    settings?.defaults?.pullRequestLabel ?? DEFAULT_PULL_REQUEST_LABEL
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !dirty) {
      setAlwaysUseDraftMode(
        settings?.defaults?.alwaysUseDraftMode ?? DEFAULT_ALWAYS_USE_DRAFT_MODE
      );
      setPullRequestLabel(settings?.defaults?.pullRequestLabel ?? DEFAULT_PULL_REQUEST_LABEL);
    }
  }, [settings, dirty]);

  const isConfigured = settings !== null && settings !== undefined;

  const handleConfirmReset = async () => {
    setSaving(true);

    try {
      const res = await browserApiFetch(GLOBAL_SETTINGS_KEY, { method: "DELETE" });

      if (res.ok) {
        await mutate(GLOBAL_SETTINGS_KEY);
        setAlwaysUseDraftMode(DEFAULT_ALWAYS_USE_DRAFT_MODE);
        setPullRequestLabel(DEFAULT_PULL_REQUEST_LABEL);
        setDirty(false);
        toast.success("Settings reset to defaults.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to reset settings");
      }
    } catch {
      toast.error("Failed to reset settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);

    const normalizedLabel = pullRequestLabel.trim();
    const defaults: ScmSettings = {
      alwaysUseDraftMode,
      ...(normalizedLabel ? { pullRequestLabel: normalizedLabel } : {}),
    };
    const body: ScmGlobalConfig = { defaults };

    try {
      const res = await browserApiFetch(GLOBAL_SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });

      if (res.ok) {
        await mutate(GLOBAL_SETTINGS_KEY);
        setPullRequestLabel(normalizedLabel);
        toast.success("Settings saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Defaults"
      description="Apply to pull and merge requests created by sessions across all repositories."
    >
      <div className="mb-4">
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <div>
            <span className="font-medium text-foreground">Always use draft mode</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Always open pull and merge requests as drafts
            </p>
          </div>
          <input
            type="checkbox"
            checked={alwaysUseDraftMode}
            onChange={() => {
              setAlwaysUseDraftMode(!alwaysUseDraftMode);
              setDirty(true);
            }}
            className="rounded border-border"
          />
        </label>
      </div>

      <div className="mb-4">
        <label htmlFor="pull-request-label" className="block text-sm font-medium mb-1">
          Pull request label
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          Applied to pull and merge requests created by sessions. Leave blank to apply no label.
        </p>
        <Input
          id="pull-request-label"
          value={pullRequestLabel}
          onChange={(event) => {
            setPullRequestLabel(event.target.value);
            setDirty(true);
          }}
          placeholder="e.g., open-inspect"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>

        {isConfigured && (
          <Button variant="destructive" onClick={() => setShowResetDialog(true)} disabled={saving}>
            Reset to defaults
          </Button>
        )}
      </div>

      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to defaults</AlertDialogTitle>
            <AlertDialogDescription>
              Reset the global pull/merge request defaults? Per-repository overrides will not be
              affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmReset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function RepoOverridesSection({
  overrides,
  availableRepos,
  globalDefault,
  globalLabel,
}: {
  overrides: RepoSettingsEntry[];
  availableRepos: EnrichedRepository[];
  globalDefault: boolean;
  globalLabel?: string;
}) {
  const [addingRepo, setAddingRepo] = useState("");

  const overriddenRepos = new Set(overrides.map((o) => o.repo));
  const availableForOverride = availableRepos.filter(
    (r) => !overriddenRepos.has(r.fullName.toLowerCase())
  );

  const handleAdd = async () => {
    if (!addingRepo) return;
    const settingsPath = getScmRepoSettingsPath(addingRepo);
    if (!settingsPath) return;

    try {
      const res = await browserApiFetch(settingsPath, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: {} }),
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        setAddingRepo("");
        toast.success("Override added.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to add override");
      }
    } catch {
      toast.error("Failed to add override");
    }
  };

  return (
    <div>
      {overrides.length > 0 ? (
        <div className="space-y-2 mb-4">
          {overrides.map((entry) => (
            <RepoOverrideRow
              key={entry.repo}
              entry={entry}
              globalDefault={globalDefault}
              globalLabel={globalLabel}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          No repository overrides yet. Add one to customize pull and merge request defaults.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Select value={addingRepo} onValueChange={setAddingRepo}>
          <SelectTrigger className="flex-1" aria-label="Select a repository">
            <SelectValue placeholder="Select a repository..." />
          </SelectTrigger>
          <SelectContent>
            {availableForOverride.map((repo) => (
              <SelectItem key={repo.fullName} value={repo.fullName.toLowerCase()}>
                {repo.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleAdd} disabled={!addingRepo}>
          Add Override
        </Button>
      </div>
    </div>
  );
}

type DraftOverrideMode = "inherit" | "draft" | "ready";

function deriveDraftOverrideMode(settings: ScmRepoSettings): DraftOverrideMode {
  if (settings.alwaysUseDraftMode === undefined) return "inherit";
  return settings.alwaysUseDraftMode ? "draft" : "ready";
}

function RepoOverrideRow({
  entry,
  globalDefault,
  globalLabel,
}: {
  entry: RepoSettingsEntry;
  globalDefault: boolean;
  globalLabel?: string;
}) {
  const [draftMode, setDraftMode] = useState<DraftOverrideMode>(() =>
    deriveDraftOverrideMode(entry.settings)
  );
  const [pullRequestLabel, setPullRequestLabel] = useState(
    entry.settings.pullRequestLabel ?? DEFAULT_PULL_REQUEST_LABEL
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty || saving) return;
    setDraftMode(deriveDraftOverrideMode(entry.settings));
    setPullRequestLabel(entry.settings.pullRequestLabel ?? DEFAULT_PULL_REQUEST_LABEL);
  }, [entry.settings, dirty, saving]);

  const handleSave = async () => {
    const settingsPath = getScmRepoSettingsPath(entry.repo);
    if (!settingsPath) return;
    setSaving(true);

    const normalizedLabel = pullRequestLabel.trim();
    const settings: ScmRepoSettings = {};
    if (draftMode === "draft") settings.alwaysUseDraftMode = true;
    if (draftMode === "ready") settings.alwaysUseDraftMode = false;
    if (normalizedLabel) settings.pullRequestLabel = normalizedLabel;

    try {
      const res = await browserApiFetch(settingsPath, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });

      if (res.ok) {
        await mutate(REPO_SETTINGS_KEY);
        setPullRequestLabel(normalizedLabel);
        setDirty(false);
        toast.success(`Override for ${entry.repo} saved.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save override");
      }
    } catch {
      toast.error("Failed to save override");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const settingsPath = getScmRepoSettingsPath(entry.repo);
    if (!settingsPath) return;

    try {
      const res = await browserApiFetch(settingsPath, {
        method: "DELETE",
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        toast.success(`Override for ${entry.repo} removed.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to delete override");
      }
    } catch {
      toast.error("Failed to delete override");
    }
  };

  return (
    <div className="px-4 py-3 border border-border rounded-sm space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground truncate">{entry.repo}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? "..." : "Save"}
          </Button>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            Remove
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="block text-muted-foreground mb-1">Draft mode override</span>
          <Select
            value={draftMode}
            onValueChange={(value: DraftOverrideMode) => {
              setDraftMode(value);
              setDirty(true);
            }}
          >
            <SelectTrigger density="compact" aria-label={`Draft mode override for ${entry.repo}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">
                Inherit global ({globalDefault ? "always draft" : "ready unless requested"})
              </SelectItem>
              <SelectItem value="draft">Override: always draft</SelectItem>
              <SelectItem value="ready">Override: ready unless requested</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="text-sm">
          <span className="block text-muted-foreground mb-1">Pull request label override</span>
          <Input
            value={pullRequestLabel}
            onChange={(event) => {
              setPullRequestLabel(event.target.value);
              setDirty(true);
            }}
            placeholder={globalLabel ? `Global: ${globalLabel}` : "No global label"}
            aria-label={`Pull request label override for ${entry.repo}`}
          />
          <span className="block text-xs text-muted-foreground mt-1">
            Leave blank to use the global default.
          </span>
        </label>
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
