"use client";

import { useEffect, useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  encodeRepositoryPathSegments,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import {
  DEFAULT_LINEAR_UNBOUND_CHANNELS,
  type LinearBotGlobalSettings,
  type LinearBotSettings,
  type LinearGlobalConfig,
} from "@open-inspect/shared/types/integrations";
import {
  MODEL_REASONING_CONFIG,
  getValidModelOrDefault,
  isValidReasoningEffort,
  type ModelCategory,
  type ValidModel,
} from "@open-inspect/shared/models";
import {
  DEFAULT_HARNESS,
  checkHarnessCompatibility,
  getHarnessLabel,
  getValidHarnessOrDefault,
  harnessSupportsModel,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { filterModelOptionsForHarness } from "@/lib/session-harness";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { SettingsCardSection } from "../settings-card-section";
import { RepoOverrideSelector } from "../repo-override-selector";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { RadioCard } from "@/components/ui/form-controls";
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
import { ModelReasoningDefaultsFields } from "./model-reasoning-defaults-fields";
import { HarnessSelect } from "./harness-select";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

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

/**
 * Displays Linear integration settings with global and repository edits gated by their respective permissions.
 */
export function LinearIntegrationSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canManageGlobal = hasPermission("integrations.manage");
  const canManageRepos = hasPermission("repositories.settings.manage");
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
      <h2 className="text-lg font-semibold text-foreground mb-1">Linear Agent</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Configure model defaults, repository scope, and runtime behavior for Linear-triggered
        sessions.
      </p>

      <SettingsCardSection
        title="Connection"
        description="Linear uses control-plane repository access."
      >
        {availableRepos.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Repository access is available. You can target all repos or limit the integration to a
            selected allowlist.
          </p>
        ) : (
          <p className="text-sm text-warning bg-warning-muted border border-warning/20 px-4 py-3 rounded-sm">
            No repositories are currently accessible from the control plane. Repository filtering is
            unavailable until repository access is configured.
          </p>
        )}
      </SettingsCardSection>

      <fieldset disabled={!canManageGlobal} className="min-w-0">
        <GlobalSettingsSection
          settings={settings}
          canManageGlobal={canManageGlobal}
          availableRepos={availableRepos}
          enabledModelOptions={enabledModelOptions}
        />
      </fieldset>

      <SettingsCardSection
        title="Repository Overrides"
        description="Override model selection and behavior for specific repositories. The unbound Linear teams policy is workspace-wide and cannot be overridden per repository."
      >
        <fieldset disabled={!canManageRepos} className="min-w-0">
          <RepoOverridesSection
            overrides={repoOverrides}
            availableRepos={availableRepos}
            enabledModelOptions={enabledModelOptions}
            inheritedHarness={getValidHarnessOrDefault(settings?.defaults?.harness)}
            inheritedModel={settings?.defaults?.model}
          />
        </fieldset>
      </SettingsCardSection>
    </div>
  );
}

function GlobalSettingsSection({
  settings,
  canManageGlobal,
  availableRepos,
  enabledModelOptions,
}: {
  settings: LinearGlobalConfig | null | undefined;
  canManageGlobal: boolean;
  availableRepos: EnrichedRepository[];
  enabledModelOptions: ModelCategory[];
}) {
  const [harness, setHarness] = useState<HarnessId>(
    getValidHarnessOrDefault(settings?.defaults?.harness)
  );
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
  const [issueSessionInstructions, setIssueSessionInstructions] = useState(
    settings?.defaults?.issueSessionInstructions ?? ""
  );
  const [unboundChannels, setUnboundChannels] = useState<"workspace" | "reject">(
    settings?.defaults?.unboundChannels ?? DEFAULT_LINEAR_UNBOUND_CHANNELS
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  useEffect(() => {
    if (settings === undefined || dirty || saving) return;
    setHarness(getValidHarnessOrDefault(settings?.defaults?.harness));
    setModel(settings?.defaults?.model ?? "");
    setEffort(settings?.defaults?.reasoningEffort ?? "");
    setEnabledRepos(settings?.enabledRepos ?? []);
    setRepoScopeMode(settings?.enabledRepos == null ? "all" : "selected");
    setAllowUserPreferenceOverride(settings?.defaults?.allowUserPreferenceOverride ?? true);
    setAllowLabelModelOverride(settings?.defaults?.allowLabelModelOverride ?? true);
    setEmitToolProgressActivities(settings?.defaults?.emitToolProgressActivities ?? true);
    setIssueSessionInstructions(settings?.defaults?.issueSessionInstructions ?? "");
    setUnboundChannels(settings?.defaults?.unboundChannels ?? DEFAULT_LINEAR_UNBOUND_CHANNELS);
  }, [settings, dirty, saving]);

  const isConfigured = settings !== null && settings !== undefined;
  const resetNotice =
    "Reset all Linear settings to defaults? New sessions run on OpenCode, both label/user model overrides are enabled, and the default policy for unbound Linear teams is restored.";

  const handleReset = () => {
    setShowResetDialog(true);
  };

  const handleConfirmReset = async () => {
    if (!canManageGlobal || saving) return;
    setSaving(true);
    setError("");

    try {
      const res = await browserApiFetch(GLOBAL_SETTINGS_KEY, { method: "DELETE" });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY, { settings: null });
        setHarness(DEFAULT_HARNESS);
        setModel("");
        setEffort("");
        setEnabledRepos([]);
        setRepoScopeMode("all");
        setAllowUserPreferenceOverride(true);
        setAllowLabelModelOverride(true);
        setEmitToolProgressActivities(true);
        setIssueSessionInstructions("");
        setUnboundChannels(DEFAULT_LINEAR_UNBOUND_CHANNELS);
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
    if (!canManageGlobal || saving || !dirty) return;
    setSaving(true);
    setError("");

    const defaults: LinearBotGlobalSettings = {
      allowUserPreferenceOverride,
      allowLabelModelOverride,
      emitToolProgressActivities,
      unboundChannels,
    };

    if (harness !== DEFAULT_HARNESS) defaults.harness = harness;
    if (model) defaults.model = model;
    if (effort) defaults.reasoningEffort = effort;
    if (issueSessionInstructions) defaults.issueSessionInstructions = issueSessionInstructions;

    const body: LinearGlobalConfig = { defaults };
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
        mutate(GLOBAL_SETTINGS_KEY, { settings: body });
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

  const toggleRepo = (fullName: string) => {
    const lower = fullName.toLowerCase();
    setEnabledRepos((prev) =>
      prev.includes(lower) ? prev.filter((r) => r !== lower) : [...prev, lower]
    );
    setDirty(true);
    setError("");
  };

  return (
    <SettingsCardSection
      title="Defaults & Scope"
      description="Global model, fallback behavior, and repository scope."
    >
      <fieldset disabled={saving} className="min-w-0">
        {error && <Message tone="error" text={error} />}

        <div className="mb-4">
          <label
            htmlFor="linear-unbound-channels"
            className="block text-sm font-medium text-foreground mb-2"
          >
            Unbound Linear teams
          </label>
          <p id="linear-unbound-channels-help" className="text-xs text-muted-foreground mb-2">
            Choose what happens when a request comes from a Linear team without a team binding.
            Manage bindings in a team&apos;s Channels tab. This policy applies workspace-wide.
          </p>
          <Select
            value={unboundChannels}
            disabled={!canManageGlobal || saving}
            onValueChange={(value) => {
              setUnboundChannels(value as "workspace" | "reject");
              setDirty(true);
              setError("");
            }}
          >
            <SelectTrigger
              id="linear-unbound-channels"
              aria-describedby="linear-unbound-channels-help"
              className="w-full sm:w-96"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="workspace">Create workspace-level sessions</SelectItem>
              <SelectItem value="reject">Reject requests until bound</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="mb-4">
          <label
            htmlFor="linear-harness"
            className="block text-sm font-medium text-foreground mb-2"
          >
            Agent harness
          </label>
          <p id="linear-harness-help" className="text-xs text-muted-foreground mb-2">
            Harness for new Linear sessions; running sessions keep theirs. Claude Agent runs
            Anthropic models only, so a session whose model resolves to another provider (from a
            model label, a user preference, or the system default) runs on OpenCode. Claude Agent
            sessions use the default Claude account when its Automated authentication in Provider
            Accounts allows it, and the Anthropic API key otherwise.
          </p>
          <HarnessSelect
            id="linear-harness"
            describedBy="linear-harness-help"
            className="w-full sm:w-96"
            value={harness}
            onChange={(nextHarness = DEFAULT_HARNESS) => {
              setHarness(nextHarness);
              if (model && !harnessSupportsModel(nextHarness, model)) {
                setModel("");
                setEffort("");
              }
              setDirty(true);
              setError("");
            }}
          />
        </div>

        <ModelReasoningDefaultsFields
          model={model}
          reasoningEffort={effort}
          modelOptions={filterModelOptionsForHarness(harness, enabledModelOptions)}
          onChange={(nextModel, nextEffort) => {
            setModel(nextModel);
            setEffort(nextEffort);
            setDirty(true);
            setError("");
          }}
        />

        <div className="grid sm:grid-cols-2 gap-2 mb-4">
          <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
            <span>Allow user model preferences</span>
            <Checkbox
              checked={allowUserPreferenceOverride}
              onCheckedChange={(checked) => {
                setAllowUserPreferenceOverride(!!checked);
                setDirty(true);
                setError("");
              }}
            />
          </label>
          <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
            <span>Allow model labels (model:*)</span>
            <Checkbox
              checked={allowLabelModelOverride}
              onCheckedChange={(checked) => {
                setAllowLabelModelOverride(!!checked);
                setDirty(true);
                setError("");
              }}
            />
          </label>
        </div>

        <div className="mb-4">
          <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
            <span>Emit tool progress activities</span>
            <Checkbox
              checked={emitToolProgressActivities}
              onCheckedChange={(checked) => {
                setEmitToolProgressActivities(!!checked);
                setDirty(true);
                setError("");
              }}
            />
          </label>
        </div>

        <div className="mb-4">
          <label
            htmlFor="linear-issue-session-instructions"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Issue Session Instructions
          </label>
          <p className="text-xs text-muted-foreground mb-2">
            Custom instructions appended to agent prompts for all Linear issue sessions. Use this to
            guide how the agent approaches issues (e.g., coding standards, preferred tools, MR
            conventions).
          </p>
          <Textarea
            id="linear-issue-session-instructions"
            value={issueSessionInstructions}
            onChange={(e) => {
              setIssueSessionInstructions(e.target.value);
              setDirty(true);
              setError("");
            }}
            rows={3}
            placeholder="e.g., Always run tests before pushing changes. Prefer minimal diffs."
            className="resize-y"
          />
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
      </fieldset>
      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to defaults</AlertDialogTitle>
            <AlertDialogDescription>{resetNotice}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmReset} disabled={!canManageGlobal || saving}>
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCardSection>
  );
}

function RepoOverridesSection({
  overrides,
  availableRepos,
  enabledModelOptions,
  inheritedHarness,
  inheritedModel,
}: {
  overrides: RepoSettingsEntry[];
  availableRepos: EnrichedRepository[];
  enabledModelOptions: ModelCategory[];
  inheritedHarness: HarnessId;
  inheritedModel: string | undefined;
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
              inheritedHarness={inheritedHarness}
              inheritedModel={inheritedModel}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          No repository overrides yet. Add one to customize model behavior per repo.
        </p>
      )}

      <RepoOverrideSelector
        value={addingRepo}
        onValueChange={setAddingRepo}
        repositories={availableForOverride}
        onAdd={handleAdd}
      />
    </div>
  );
}

function RepoOverrideRow({
  entry,
  enabledModelOptions,
  inheritedHarness,
  inheritedModel,
}: {
  entry: RepoSettingsEntry;
  enabledModelOptions: ModelCategory[];
  inheritedHarness: HarnessId;
  inheritedModel: string | undefined;
}) {
  const [harness, setHarness] = useState(entry.settings.harness);
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
  const effectiveHarness = harness ?? inheritedHarness;
  // Save-time validation only sees one level; a clash across levels falls back at launch.
  const effectiveModel = model || inheritedModel;
  const mismatch = effectiveModel
    ? checkHarnessCompatibility(effectiveHarness, getValidModelOrDefault(effectiveModel))
    : null;

  const handleHarnessChange = (newHarness: HarnessId | undefined) => {
    setHarness(newHarness);
    setDirty(true);

    if (model && !harnessSupportsModel(newHarness ?? inheritedHarness, model)) {
      setModel("");
      setEffort("");
    }
  };

  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    setDirty(true);

    if (effort && newModel && !isValidReasoningEffort(newModel, effort)) {
      setEffort("");
    }
  };

  const handleSave = async () => {
    const repository = parseRepositoryFullName(entry.repo);
    if (!repository) return;
    setSaving(true);
    const settings: LinearBotSettings = {
      allowUserPreferenceOverride,
      allowLabelModelOverride,
      emitToolProgressActivities,
    };
    if (harness) settings.harness = harness;
    if (model) settings.model = model;
    if (effort) settings.reasoningEffort = effort;

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

  return (
    <div className="grid gap-2 px-4 py-3 border border-border rounded-sm">
      <div className="text-sm font-medium text-foreground">{entry.repo}</div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <HarnessSelect
          density="compact"
          value={harness}
          onChange={handleHarnessChange}
          inheritLabel={`Inherit (${getHarnessLabel(inheritedHarness)})`}
        />

        <Select value={model} onValueChange={handleModelChange}>
          <SelectTrigger density="compact">
            <SelectValue placeholder="Default model" />
          </SelectTrigger>
          <SelectContent>
            {filterModelOptionsForHarness(effectiveHarness, enabledModelOptions).map((group) => (
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

        <Select
          value={effort}
          onValueChange={(v) => {
            setEffort(v);
            setDirty(true);
          }}
          disabled={!reasoningConfig}
        >
          <SelectTrigger density="compact">
            <SelectValue placeholder="Default effort" />
          </SelectTrigger>
          <SelectContent>
            {(reasoningConfig?.efforts ?? []).map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>Tool updates</span>
          <Checkbox
            checked={emitToolProgressActivities}
            onCheckedChange={(checked) => {
              setEmitToolProgressActivities(!!checked);
              setDirty(true);
            }}
          />
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-2">
        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>User preference override</span>
          <Checkbox
            checked={allowUserPreferenceOverride}
            onCheckedChange={(checked) => {
              setAllowUserPreferenceOverride(!!checked);
              setDirty(true);
            }}
          />
        </label>
        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>Label model override</span>
          <Checkbox
            checked={allowLabelModelOverride}
            onCheckedChange={(checked) => {
              setAllowLabelModelOverride(!!checked);
              setDirty(true);
            }}
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

      {mismatch && (
        <p className="text-xs text-warning">
          {mismatch.message} Sessions using this default model will fall back to OpenCode.
        </p>
      )}
    </div>
  );
}

function Message({ tone, text }: { tone: "error" | "success"; text: string }) {
  const classes =
    tone === "error"
      ? "mb-4 bg-destructive-muted text-destructive px-4 py-3 border border-destructive-border text-sm rounded-sm"
      : "mb-4 bg-success-muted text-success px-4 py-3 border border-success/20 text-sm rounded-sm";

  return (
    <div className={classes} aria-live="polite">
      {text}
    </div>
  );
}
