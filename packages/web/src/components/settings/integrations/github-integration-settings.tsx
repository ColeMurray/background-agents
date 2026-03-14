"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
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
import { RadioCard } from "@/components/ui/form-controls";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
        description="Set model, reasoning, and custom instruction overrides for specific repositories."
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
  const [allowedTriggerUsers, setAllowedTriggerUsers] = useState<string[]>(
    settings?.defaults?.allowedTriggerUsers ?? []
  );
  const [triggerUserMode, setTriggerUserMode] = useState<"write_access" | "specific">(
    settings?.defaults?.allowedTriggerUsers === undefined ? "write_access" : "specific"
  );
  const [codeReviewInstructions, setCodeReviewInstructions] = useState(
    settings?.defaults?.codeReviewInstructions ?? ""
  );
  const [commentActionInstructions, setCommentActionInstructions] = useState(
    settings?.defaults?.commentActionInstructions ?? ""
  );
  const [newUsername, setNewUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setAutoReviewOnOpen(settings.defaults?.autoReviewOnOpen ?? true);
        setEnabledRepos(settings.enabledRepos ?? []);
        setRepoScopeMode(settings.enabledRepos === undefined ? "all" : "selected");
        setAllowedTriggerUsers(settings.defaults?.allowedTriggerUsers ?? []);
        setTriggerUserMode(
          settings.defaults?.allowedTriggerUsers === undefined ? "write_access" : "specific"
        );
        setCodeReviewInstructions(settings.defaults?.codeReviewInstructions ?? "");
        setCommentActionInstructions(settings.defaults?.commentActionInstructions ?? "");
      }
      setInitialized(true);
    }
  }, [settings, initialized]);

  const isConfigured = settings !== null && settings !== undefined;

  const handleReset = () => {
    setShowResetDialog(true);
  };

  const handleConfirmReset = async () => {
    setSaving(true);
    setError("");

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, { method: "DELETE" });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        setAutoReviewOnOpen(true);
        setEnabledRepos([]);
        setRepoScopeMode("all");
        setAllowedTriggerUsers([]);
        setTriggerUserMode("write_access");
        setCodeReviewInstructions("");
        setCommentActionInstructions("");
        setNewUsername("");
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
    setError("");

    const body: GitHubGlobalConfig = {
      defaults: {
        autoReviewOnOpen,
        ...(triggerUserMode === "specific" ? { allowedTriggerUsers } : {}),
        ...(codeReviewInstructions ? { codeReviewInstructions } : {}),
        ...(commentActionInstructions ? { commentActionInstructions } : {}),
      },
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

  const addUsername = () => {
    const trimmed = newUsername.trim().toLowerCase();
    if (trimmed && !allowedTriggerUsers.includes(trimmed)) {
      setAllowedTriggerUsers((prev) => [...prev, trimmed]);
      setNewUsername("");
      setDirty(true);
      setError("");
    }
  };

  const toggleRepo = (fullName: string) => {
    const lower = fullName.toLowerCase();
    setEnabledRepos((prev) =>
      prev.includes(lower) ? prev.filter((r) => r !== lower) : [...prev, lower]
    );
    setDirty(true);
    setError("");
  };

  return (
    <Section title="Defaults & Scope" description="Global behavior and repository targeting.">
      {error && <Message tone="error" text={error} />}

      <div className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition mb-4 rounded-sm">
        <div>
          <span className="text-sm font-medium text-foreground">Auto-review new PRs</span>
          <span className="text-sm text-muted-foreground ml-2">
            Automatically review non-draft PRs when opened
          </span>
        </div>
        <Switch
          checked={autoReviewOnOpen}
          onCheckedChange={() => {
            setAutoReviewOnOpen(!autoReviewOnOpen);
            setDirty(true);
            setError("");
          }}
        />
      </div>

      <div className="mb-4">
        <p className="text-sm font-medium text-foreground mb-2">Repository Scope</p>
        <div className="grid sm:grid-cols-2 gap-2 mb-3">
          <RadioCard
            name="repo-scope"
            checked={repoScopeMode === "all"}
            onChange={() => {
              setRepoScopeMode("all");
              setDirty(true);
              setError("");
            }}
            label="All repositories"
            description="Bot responds in every accessible repository."
          />
          <RadioCard
            name="repo-scope"
            checked={repoScopeMode === "selected"}
            onChange={() => {
              setRepoScopeMode("selected");
              setDirty(true);
              setError("");
            }}
            label="Selected repositories"
            description="Bot only responds in the allowlisted repositories."
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
                No repositories selected. The bot will not respond to webhooks.
              </p>
            )}
          </>
        )}
      </div>

      <div className="mb-4">
        <p className="text-sm font-medium text-foreground mb-2">Allowed Trigger Users</p>
        <div className="grid sm:grid-cols-2 gap-2 mb-3">
          <RadioCard
            name="trigger-users"
            checked={triggerUserMode === "write_access"}
            onChange={() => {
              setTriggerUserMode("write_access");
              setDirty(true);
              setError("");
            }}
            label="All users with write access"
            description="Anyone with write permission on the repo can trigger the bot."
          />
          <RadioCard
            name="trigger-users"
            checked={triggerUserMode === "specific"}
            onChange={() => {
              setTriggerUserMode("specific");
              setDirty(true);
              setError("");
            }}
            label="Only specific users"
            description="Only listed GitHub usernames can trigger the bot."
          />
        </div>

        {triggerUserMode === "specific" && (
          <>
            <div className="flex items-center gap-2 mb-2">
              <input
                type="text"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addUsername();
                  }
                }}
                placeholder="GitHub username"
                className="flex-1 px-3 py-1.5 text-sm border border-border rounded-sm bg-background text-foreground placeholder:text-muted-foreground"
              />
              <Button size="sm" onClick={addUsername} disabled={!newUsername.trim()}>
                Add
              </Button>
            </div>

            {allowedTriggerUsers.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {allowedTriggerUsers.map((user) => (
                  <span
                    key={user}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-sm bg-muted text-foreground rounded-sm border border-border"
                  >
                    {user}
                    <button
                      type="button"
                      onClick={() => {
                        setAllowedTriggerUsers((prev) => prev.filter((u) => u !== user));
                        setDirty(true);
                        setError("");
                      }}
                      className="text-muted-foreground hover:text-foreground ml-0.5"
                      aria-label={`Remove ${user}`}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}

            {allowedTriggerUsers.length === 0 && (
              <p className="text-xs text-amber-700 mt-1">
                No users configured. The bot will not respond to any manual triggers (such as
                @mentions or review requests).
              </p>
            )}
          </>
        )}
      </div>

      <div className="mb-4">
        <label className="block text-sm font-medium text-foreground mb-1">
          Code Review Instructions
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          Custom instructions appended to code review prompts. Use this to focus reviews on specific
          areas or coding standards.
        </p>
        <textarea
          value={codeReviewInstructions}
          onChange={(e) => {
            setCodeReviewInstructions(e.target.value);
            setDirty(true);
            setError("");
          }}
          rows={3}
          placeholder="e.g., Focus on security best practices and ensure all API endpoints validate input."
          className="w-full px-3 py-2 text-sm border border-border rounded-sm bg-background text-foreground placeholder:text-muted-foreground resize-y"
        />
      </div>

      <div className="mb-4">
        <label className="block text-sm font-medium text-foreground mb-1">
          Comment Action Instructions
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          Custom instructions appended to comment action prompts (@mention responses). Use this to
          guide how the bot responds to comments.
        </p>
        <textarea
          value={commentActionInstructions}
          onChange={(e) => {
            setCommentActionInstructions(e.target.value);
            setDirty(true);
            setError("");
          }}
          rows={3}
          placeholder="e.g., Always run tests before pushing changes. Prefer minimal diffs."
          className="w-full px-3 py-2 text-sm border border-border rounded-sm bg-background text-foreground placeholder:text-muted-foreground resize-y"
        />
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

      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to defaults</AlertDialogTitle>
            <AlertDialogDescription>
              Reset all GitHub bot settings to defaults? The bot will respond to all repos with
              auto-review enabled.
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
  enabledModelOptions,
}: {
  overrides: RepoSettingsEntry[];
  availableRepos: EnrichedRepository[];
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
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
      const res = await fetch(`/api/integration-settings/github/repos/${owner}/${name}`, {
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
              enabledModelOptions={enabledModelOptions}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          No repository overrides yet. Add one to customize model behavior per repo.
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

function RepoOverrideRow({
  entry,
  enabledModelOptions,
}: {
  entry: RepoSettingsEntry;
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [model, setModel] = useState(entry.settings.model ?? "");
  const [effort, setEffort] = useState(entry.settings.reasoningEffort ?? "");
  const [triggerUserMode, setTriggerUserMode] = useState<"global" | "override">(
    entry.settings.allowedTriggerUsers !== undefined ? "override" : "global"
  );
  const [allowedTriggerUsers, setAllowedTriggerUsers] = useState<string[]>(
    entry.settings.allowedTriggerUsers ?? []
  );
  const [codeReviewMode, setCodeReviewMode] = useState<"global" | "override">(
    entry.settings.codeReviewInstructions !== undefined ? "override" : "global"
  );
  const [codeReviewInstructions, setCodeReviewInstructions] = useState(
    entry.settings.codeReviewInstructions ?? ""
  );
  const [commentActionMode, setCommentActionMode] = useState<"global" | "override">(
    entry.settings.commentActionInstructions !== undefined ? "override" : "global"
  );
  const [commentActionInstructions, setCommentActionInstructions] = useState(
    entry.settings.commentActionInstructions ?? ""
  );
  const [newUsername, setNewUsername] = useState("");
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

    const [owner, name] = entry.repo.split("/");
    const settings: GitHubBotSettings = {};
    if (model) settings.model = model;
    if (effort) settings.reasoningEffort = effort;
    if (triggerUserMode === "override") settings.allowedTriggerUsers = allowedTriggerUsers;
    if (codeReviewMode === "override") settings.codeReviewInstructions = codeReviewInstructions;
    if (commentActionMode === "override")
      settings.commentActionInstructions = commentActionInstructions;

    try {
      const res = await fetch(`/api/integration-settings/github/repos/${owner}/${name}`, {
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
      const res = await fetch(`/api/integration-settings/github/repos/${owner}/${name}`, {
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

  const addRepoUsername = () => {
    const trimmed = newUsername.trim().toLowerCase();
    if (trimmed && !allowedTriggerUsers.includes(trimmed)) {
      setAllowedTriggerUsers((prev) => [...prev, trimmed]);
      setNewUsername("");
      setDirty(true);
    }
  };

  return (
    <div className="px-4 py-3 border border-border rounded-sm space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground min-w-[180px] truncate">
          {entry.repo}
        </span>

        <Select value={model} onValueChange={handleModelChange}>
          <SelectTrigger density="compact" className="flex-1 min-w-[180px]">
            <SelectValue placeholder="Default model" />
          </SelectTrigger>
          <SelectContent>
            {enabledModelOptions.map((group) => (
              <SelectGroup key={group.category}>
                <SelectLabel>{group.category}</SelectLabel>
                {group.models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>

        {reasoningConfig && (
          <Select
            value={effort}
            onValueChange={(v) => {
              setEffort(v);
              setDirty(true);
            }}
          >
            <SelectTrigger density="compact" className="w-36">
              <SelectValue placeholder="Default effort" />
            </SelectTrigger>
            <SelectContent>
              {reasoningConfig.efforts.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "..." : "Save"}
        </Button>

        <Button variant="destructive" size="sm" onClick={handleDelete}>
          Remove
        </Button>
      </div>

      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">Allowed Trigger Users</p>
        <div className="flex items-center gap-2 mb-1">
          <Select
            value={triggerUserMode}
            onValueChange={(v: "global" | "override") => {
              setTriggerUserMode(v);
              setDirty(true);
            }}
          >
            <SelectTrigger density="compact" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">Use global default</SelectItem>
              <SelectItem value="override">Override for this repo</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {triggerUserMode === "override" && (
          <>
            <div className="flex items-center gap-2 mb-1">
              <input
                type="text"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addRepoUsername();
                  }
                }}
                placeholder="GitHub username"
                className="flex-1 px-2 py-1 text-xs border border-border rounded-sm bg-background text-foreground placeholder:text-muted-foreground"
              />
              <Button size="sm" onClick={addRepoUsername} disabled={!newUsername.trim()}>
                Add
              </Button>
            </div>

            {allowedTriggerUsers.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {allowedTriggerUsers.map((user) => (
                  <span
                    key={user}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-muted text-foreground rounded-sm border border-border"
                  >
                    {user}
                    <button
                      type="button"
                      onClick={() => {
                        setAllowedTriggerUsers((prev) => prev.filter((u) => u !== user));
                        setDirty(true);
                      }}
                      className="text-muted-foreground hover:text-foreground ml-0.5"
                      aria-label={`Remove ${user}`}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}

            {allowedTriggerUsers.length === 0 && (
              <p className="text-xs text-amber-700">
                No users configured. The bot will not respond to any manual triggers for this repo.
              </p>
            )}
          </>
        )}
      </div>

      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">Code Review Instructions</p>
        <div className="flex items-center gap-2 mb-1">
          <Select
            value={codeReviewMode}
            onValueChange={(v: "global" | "override") => {
              setCodeReviewMode(v);
              setDirty(true);
            }}
          >
            <SelectTrigger density="compact" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">Use global default</SelectItem>
              <SelectItem value="override">Override for this repo</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {codeReviewMode === "override" && (
          <textarea
            value={codeReviewInstructions}
            onChange={(e) => {
              setCodeReviewInstructions(e.target.value);
              setDirty(true);
            }}
            rows={2}
            placeholder="Custom review instructions for this repo..."
            className="w-full px-2 py-1 text-xs border border-border rounded-sm bg-background text-foreground placeholder:text-muted-foreground resize-y"
          />
        )}
      </div>

      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">
          Comment Action Instructions
        </p>
        <div className="flex items-center gap-2 mb-1">
          <Select
            value={commentActionMode}
            onValueChange={(v: "global" | "override") => {
              setCommentActionMode(v);
              setDirty(true);
            }}
          >
            <SelectTrigger density="compact" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">Use global default</SelectItem>
              <SelectItem value="override">Override for this repo</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {commentActionMode === "override" && (
          <textarea
            value={commentActionInstructions}
            onChange={(e) => {
              setCommentActionInstructions(e.target.value);
              setDirty(true);
            }}
            rows={2}
            placeholder="Custom comment action instructions for this repo..."
            className="w-full px-2 py-1 text-xs border border-border rounded-sm bg-background text-foreground placeholder:text-muted-foreground resize-y"
          />
        )}
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
