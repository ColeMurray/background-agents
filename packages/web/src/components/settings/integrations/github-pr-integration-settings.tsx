"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  type EnrichedRepository,
  type GitHubPrSettings,
  type GitHubPrGlobalConfig,
} from "@open-inspect/shared";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { Button } from "@/components/ui/button";
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

const GLOBAL_SETTINGS_KEY = "/api/integration-settings/github-pr";
const REPO_SETTINGS_KEY = "/api/integration-settings/github-pr/repos";

interface GlobalResponse {
  settings: GitHubPrGlobalConfig | null;
}

interface RepoSettingsEntry {
  repo: string;
  settings: GitHubPrSettings;
}

interface RepoListResponse {
  repos: RepoSettingsEntry[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

export function GitHubPrIntegrationSettings() {
  const { data: globalData, isLoading: globalLoading } =
    useSWR<GlobalResponse>(GLOBAL_SETTINGS_KEY);
  const { data: repoSettingsData, isLoading: repoSettingsLoading } =
    useSWR<RepoListResponse>(REPO_SETTINGS_KEY);
  const { data: reposData } = useSWR<ReposResponse>("/api/repos");

  if (globalLoading || repoSettingsLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  const settings = globalData?.settings;
  const repoOverrides = repoSettingsData?.repos ?? [];
  const availableRepos = reposData?.repos ?? [];

  return (
    <div>
      <h3 className="text-lg font-semibold text-foreground mb-1">GitHub</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Defaults for pull requests opened by coding sessions. These are separate from the GitHub Bot
        settings, which control automated PR reviews and comment actions.
      </p>

      <GlobalSettingsSection settings={settings} />

      <Section
        title="Repository Overrides"
        description="Override the draft default for specific repositories."
      >
        <RepoOverridesSection
          overrides={repoOverrides}
          availableRepos={availableRepos}
          globalDefault={settings?.defaults?.alwaysUseDraftMode ?? false}
        />
      </Section>
    </div>
  );
}

function GlobalSettingsSection({
  settings,
}: {
  settings: GitHubPrGlobalConfig | null | undefined;
}) {
  const [alwaysUseDraftMode, setAlwaysUseDraftMode] = useState(
    settings?.defaults?.alwaysUseDraftMode ?? false
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setAlwaysUseDraftMode(settings.defaults?.alwaysUseDraftMode ?? false);
      }
      setInitialized(true);
    }
  }, [settings, initialized]);

  const isConfigured = settings !== null && settings !== undefined;

  const handleConfirmReset = async () => {
    setSaving(true);

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, { method: "DELETE" });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        setAlwaysUseDraftMode(false);
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

    const defaults: GitHubPrSettings = { alwaysUseDraftMode };
    const body: GitHubPrGlobalConfig = { defaults };

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
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
      description="Apply to pull requests created by sessions across all repositories."
    >
      <div className="mb-4">
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <div>
            <span className="font-medium text-foreground">Always use draft mode</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Open new pull requests as drafts by default
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
              Reset the global pull request defaults? Per-repository overrides will not be affected.
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
}: {
  overrides: RepoSettingsEntry[];
  availableRepos: EnrichedRepository[];
  globalDefault: boolean;
}) {
  const [addingRepo, setAddingRepo] = useState("");

  const overriddenRepos = new Set(overrides.map((o) => o.repo));
  const availableForOverride = availableRepos.filter(
    (r) => !overriddenRepos.has(r.fullName.toLowerCase())
  );

  const handleAdd = async () => {
    if (!addingRepo) return;
    const [owner, name] = addingRepo.split("/");

    try {
      const res = await fetch(`/api/integration-settings/github-pr/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Seed the new override from the current global default so adding one
        // doesn't silently flip a repo to draft when the global is off.
        body: JSON.stringify({ settings: { alwaysUseDraftMode: globalDefault } }),
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
            <RepoOverrideRow key={entry.repo} entry={entry} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          No repository overrides yet. Add one to set the draft default per repo.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Select value={addingRepo} onValueChange={setAddingRepo}>
          <SelectTrigger className="flex-1">
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

function RepoOverrideRow({ entry }: { entry: RepoSettingsEntry }) {
  const [alwaysUseDraftMode, setAlwaysUseDraftMode] = useState(
    entry.settings.alwaysUseDraftMode ?? false
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const handleSave = async () => {
    setSaving(true);

    const [owner, name] = entry.repo.split("/");
    const settings: GitHubPrSettings = { alwaysUseDraftMode };

    try {
      const res = await fetch(`/api/integration-settings/github-pr/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
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
    const [owner, name] = entry.repo.split("/");

    try {
      const res = await fetch(`/api/integration-settings/github-pr/repos/${owner}/${name}`, {
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
    <div className="flex items-center justify-between gap-2 px-4 py-3 border border-border rounded-sm">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className="text-sm font-medium text-foreground truncate">{entry.repo}</span>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={alwaysUseDraftMode}
            onChange={() => {
              setAlwaysUseDraftMode(!alwaysUseDraftMode);
              setDirty(true);
            }}
            className="rounded border-border"
          />
          <span className="text-muted-foreground">Always use draft mode</span>
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
