"use client";

import { useEffect, useState } from "react";
import { mutate } from "swr";
import { toast } from "sonner";
import {
  GITHUB_AUTOFIX_DEFAULTS,
  type EnrichedRepository,
  type GitHubGlobalConfig,
  type ResolvedGitHubAutofixSettings,
} from "@open-inspect/shared";
import type { ModelCategory } from "@open-inspect/shared/models";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioCard } from "@/components/ui/form-controls";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import { GitHubAutofixSettingsFields } from "./github-autofix-settings-fields";
import {
  IntegrationSettingsMessage,
  IntegrationSettingsSection,
} from "./integration-settings-section";
import { ModelReasoningDefaultsFields } from "./model-reasoning-defaults-fields";

const GLOBAL_SETTINGS_KEY = "/api/integration-settings/github";

export function GlobalSettingsSection({
  settings,
  availableRepos,
  enabledModelOptions,
}: {
  settings: GitHubGlobalConfig | null | undefined;
  availableRepos: EnrichedRepository[];
  enabledModelOptions: ModelCategory[];
}) {
  const [model, setModel] = useState(settings?.defaults?.model ?? "");
  const [effort, setEffort] = useState(settings?.defaults?.reasoningEffort ?? "");
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
  const [autofix, setAutofix] = useState<ResolvedGitHubAutofixSettings>({
    ...GITHUB_AUTOFIX_DEFAULTS,
    ...settings?.defaults?.autofix,
  });
  const [autofixTouched, setAutofixTouched] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setModel(settings.defaults?.model ?? "");
        setEffort(settings.defaults?.reasoningEffort ?? "");
        setAutoReviewOnOpen(settings.defaults?.autoReviewOnOpen ?? true);
        setEnabledRepos(settings.enabledRepos ?? []);
        setRepoScopeMode(settings.enabledRepos === undefined ? "all" : "selected");
        setAllowedTriggerUsers(settings.defaults?.allowedTriggerUsers ?? []);
        setTriggerUserMode(
          settings.defaults?.allowedTriggerUsers === undefined ? "write_access" : "specific"
        );
        setCodeReviewInstructions(settings.defaults?.codeReviewInstructions ?? "");
        setCommentActionInstructions(settings.defaults?.commentActionInstructions ?? "");
        setAutofix({
          ...GITHUB_AUTOFIX_DEFAULTS,
          ...settings.defaults?.autofix,
        });
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
      const res = await browserApiFetch(GLOBAL_SETTINGS_KEY, { method: "DELETE" });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        setModel("");
        setEffort("");
        setAutoReviewOnOpen(true);
        setEnabledRepos([]);
        setRepoScopeMode("all");
        setAllowedTriggerUsers([]);
        setTriggerUserMode("write_access");
        setCodeReviewInstructions("");
        setCommentActionInstructions("");
        setAutofix({ ...GITHUB_AUTOFIX_DEFAULTS });
        setAutofixTouched(false);
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
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        ...(triggerUserMode === "specific" ? { allowedTriggerUsers } : {}),
        ...(codeReviewInstructions ? { codeReviewInstructions } : {}),
        ...(commentActionInstructions ? { commentActionInstructions } : {}),
        ...(settings?.defaults?.autofix !== undefined || autofixTouched ? { autofix } : {}),
      },
    };

    if (repoScopeMode === "selected") {
      body.enabledRepos = enabledRepos;
    }

    try {
      const res = await browserApiFetch(GLOBAL_SETTINGS_KEY, {
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
    <IntegrationSettingsSection
      title="Defaults & Scope"
      description="Global behavior and repository scope."
    >
      {error && <IntegrationSettingsMessage tone="error" text={error} />}

      <ModelReasoningDefaultsFields
        model={model}
        reasoningEffort={effort}
        modelOptions={enabledModelOptions}
        onChange={(nextModel, nextEffort) => {
          setModel(nextModel);
          setEffort(nextEffort);
          setDirty(true);
          setError("");
        }}
      />

      <label
        htmlFor="auto-review-toggle"
        className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition cursor-pointer mb-4 rounded-sm"
      >
        <div>
          <span className="text-sm font-medium text-foreground">Auto-review new PRs</span>
          <span className="text-sm text-muted-foreground ml-2">
            Automatically review non-draft PRs when opened
          </span>
        </div>
        <Switch
          id="auto-review-toggle"
          checked={autoReviewOnOpen}
          onCheckedChange={(checked) => {
            setAutoReviewOnOpen(checked);
            setDirty(true);
            setError("");
          }}
        />
      </label>

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
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => toggleRepo(repo.fullName)}
                      />
                      <span className="text-foreground">{repo.fullName}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {enabledRepos.length === 0 && availableRepos.length > 0 && (
              <p className="text-xs text-warning mt-1">
                No repositories selected. The bot will not respond to webhooks.
              </p>
            )}
          </>
        )}
      </div>

      <div className="mb-4 border-t border-border pt-4">
        <p className="text-sm font-medium text-foreground mb-1">PR Feedback Autofix</p>
        <p className="text-xs text-muted-foreground mb-3">
          Continue the pull request&apos;s owning session when eligible feedback arrives. Bot
          mentions keep the existing fresh-session behavior; one submitted review creates one
          attempt even when it contains several inline comments.
        </p>
        <GitHubAutofixSettingsFields
          value={autofix}
          onDirty={() => {
            setAutofixTouched(true);
            setDirty(true);
          }}
          onChange={(value) => {
            setAutofix(value);
            setAutofixTouched(true);
            setDirty(true);
            setError("");
          }}
        />
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
              <Input
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addUsername();
                  }
                }}
                placeholder="GitHub username"
                className="flex-1 h-8"
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
              <p className="text-xs text-warning mt-1">
                No users configured. The bot will not respond to any manual triggers (such as
                @mentions or review requests).
              </p>
            )}
          </>
        )}
      </div>

      <div className="mb-4">
        <label
          htmlFor="github-code-review-instructions"
          className="block text-sm font-medium text-foreground mb-1"
        >
          Code Review Instructions
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          Custom instructions appended to code review prompts. Use this to focus reviews on specific
          areas or coding standards.
        </p>
        <Textarea
          id="github-code-review-instructions"
          value={codeReviewInstructions}
          onChange={(e) => {
            setCodeReviewInstructions(e.target.value);
            setDirty(true);
            setError("");
          }}
          rows={3}
          placeholder="e.g., Focus on security best practices and ensure all API endpoints validate input."
          className="resize-y"
        />
      </div>

      <div className="mb-4">
        <label
          htmlFor="github-comment-action-instructions"
          className="block text-sm font-medium text-foreground mb-1"
        >
          Comment Action Instructions
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          Custom instructions appended to comment action prompts (@mention responses). Use this to
          guide how the bot responds to comments.
        </p>
        <Textarea
          id="github-comment-action-instructions"
          value={commentActionInstructions}
          onChange={(e) => {
            setCommentActionInstructions(e.target.value);
            setDirty(true);
            setError("");
          }}
          rows={3}
          placeholder="e.g., Always run tests before pushing changes. Prefer minimal diffs."
          className="resize-y"
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
    </IntegrationSettingsSection>
  );
}
