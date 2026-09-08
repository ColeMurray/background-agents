"use client";

import { useState } from "react";
import { mutate } from "swr";
import { toast } from "sonner";
import {
  encodeRepositoryPathSegments,
  parseRepositoryFullName,
  type EnrichedRepository,
  type GitHubAutofixSettings,
  type GitHubBotSettings,
  type ResolvedGitHubAutofixSettings,
} from "@open-inspect/shared";
import {
  MODEL_REASONING_CONFIG,
  isValidReasoningEffort,
  type ModelCategory,
  type ValidModel,
} from "@open-inspect/shared/models";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GitHubAutofixSettingsFields } from "./github-autofix-settings-fields";

const REPO_SETTINGS_KEY = "/api/integration-settings/github/repos";

export interface RepoSettingsEntry {
  repo: string;
  settings: GitHubBotSettings;
}

export function RepoOverridesSection({
  overrides,
  availableRepos,
  enabledModelOptions,
  defaultAutoReviewOnOpen,
  defaultAutofix,
}: {
  overrides: RepoSettingsEntry[];
  availableRepos: EnrichedRepository[];
  enabledModelOptions: ModelCategory[];
  defaultAutoReviewOnOpen: boolean;
  defaultAutofix: ResolvedGitHubAutofixSettings;
}) {
  const [addingRepo, setAddingRepo] = useState("");

  const overriddenRepos = new Set(overrides.map((o) => o.repo));
  const availableForOverride = availableRepos.filter(
    (r) => !overriddenRepos.has(r.fullName.toLowerCase())
  );

  const handleAdd = async () => {
    if (!addingRepo) return;
    const repository = parseRepositoryFullName(addingRepo);
    if (!repository) return;

    try {
      const res = await browserApiFetch(
        `${REPO_SETTINGS_KEY}/${encodeRepositoryPathSegments(repository)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: {} }),
        }
      );

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
              defaultAutoReviewOnOpen={defaultAutoReviewOnOpen}
              defaultAutofix={defaultAutofix}
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
  defaultAutoReviewOnOpen,
  defaultAutofix,
}: {
  entry: RepoSettingsEntry;
  enabledModelOptions: ModelCategory[];
  defaultAutoReviewOnOpen: boolean;
  defaultAutofix: ResolvedGitHubAutofixSettings;
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
  const [autoReviewMode, setAutoReviewMode] = useState<"global" | "override">(
    entry.settings.autoReviewOnOpen !== undefined ? "override" : "global"
  );
  const [autoReviewOnOpen, setAutoReviewOnOpen] = useState(
    entry.settings.autoReviewOnOpen ?? defaultAutoReviewOnOpen
  );
  const [autofixMode, setAutofixMode] = useState<"global" | "override">(
    entry.settings.autofix === undefined ? "global" : "override"
  );
  const [autofixOverrides, setAutofixOverrides] = useState<GitHubAutofixSettings>(
    entry.settings.autofix ?? {}
  );
  const autofix: ResolvedGitHubAutofixSettings = {
    ...defaultAutofix,
    ...autofixOverrides,
  };
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

  const handleAutoReviewModeChange = (newMode: "global" | "override") => {
    setAutoReviewMode(newMode);
    if (newMode === "override" && entry.settings.autoReviewOnOpen === undefined) {
      setAutoReviewOnOpen(defaultAutoReviewOnOpen);
    }
    setDirty(true);
  };

  const handleSave = async () => {
    const repository = parseRepositoryFullName(entry.repo);
    if (!repository) return;
    setSaving(true);
    const settings: GitHubBotSettings = {};
    if (model) settings.model = model;
    if (effort) settings.reasoningEffort = effort;
    if (triggerUserMode === "override") settings.allowedTriggerUsers = allowedTriggerUsers;
    if (codeReviewMode === "override") settings.codeReviewInstructions = codeReviewInstructions;
    if (commentActionMode === "override")
      settings.commentActionInstructions = commentActionInstructions;
    if (autoReviewMode === "override") settings.autoReviewOnOpen = autoReviewOnOpen;
    if (autofixMode === "override") settings.autofix = autofixOverrides;

    try {
      const res = await browserApiFetch(
        `${REPO_SETTINGS_KEY}/${encodeRepositoryPathSegments(repository)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings }),
        }
      );

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
    const repository = parseRepositoryFullName(entry.repo);
    if (!repository) return;

    try {
      const res = await browserApiFetch(
        `${REPO_SETTINGS_KEY}/${encodeRepositoryPathSegments(repository)}`,
        {
          method: "DELETE",
        }
      );

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
        <p className="text-xs font-medium text-muted-foreground mb-1">Auto-review new PRs</p>
        <div className="flex items-center gap-2 mb-1">
          <Select value={autoReviewMode} onValueChange={handleAutoReviewModeChange}>
            <SelectTrigger density="compact" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">Use global default</SelectItem>
              <SelectItem value="override">Override for this repo</SelectItem>
            </SelectContent>
          </Select>
          {autoReviewMode === "override" && (
            <label className="flex items-center gap-2 text-xs text-foreground">
              <Switch
                checked={autoReviewOnOpen}
                onCheckedChange={(checked) => {
                  setAutoReviewOnOpen(checked);
                  setDirty(true);
                }}
              />
              <span>{autoReviewOnOpen ? "Enabled" : "Disabled"}</span>
            </label>
          )}
        </div>
      </div>

      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">PR Feedback Autofix</p>
        <div className="flex items-center gap-2 mb-2">
          <Select
            value={autofixMode}
            onValueChange={(value: "global" | "override") => {
              setAutofixMode(value);
              if (value === "override" && entry.settings.autofix === undefined) {
                setAutofixOverrides({});
              }
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
        {autofixMode === "override" && (
          <GitHubAutofixSettingsFields
            value={autofix}
            compact
            onDirty={() => setDirty(true)}
            onChange={(value, changedKey) => {
              setAutofixOverrides((current) => ({
                ...current,
                [changedKey]: value[changedKey],
              }));
              setDirty(true);
            }}
          />
        )}
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
              <Input
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addRepoUsername();
                  }
                }}
                placeholder="GitHub username"
                className="flex-1 h-auto px-2 py-1 text-xs"
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
              <p className="text-xs text-warning">
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
          <Textarea
            value={codeReviewInstructions}
            onChange={(e) => {
              setCodeReviewInstructions(e.target.value);
              setDirty(true);
            }}
            rows={2}
            placeholder="Custom review instructions for this repo..."
            className="px-2 py-1 text-xs resize-y"
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
          <Textarea
            value={commentActionInstructions}
            onChange={(e) => {
              setCommentActionInstructions(e.target.value);
              setDirty(true);
            }}
            rows={2}
            placeholder="Custom comment action instructions for this repo..."
            className="px-2 py-1 text-xs resize-y"
          />
        )}
      </div>
    </div>
  );
}
