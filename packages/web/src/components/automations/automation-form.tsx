"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  DEFAULT_MODEL,
  getReasoningConfig,
  isValidCron,
  isValidReasoningEffort,
  triggerSources,
  MAX_AUTOMATION_REPOSITORIES,
  TRIGGER_TYPE_TO_SOURCE,
  type AutomationRepositoryInput,
  type AutomationTriggerType,
  type AutomationEventSource,
  type TriggerCondition,
  type TriggerConfig,
} from "@open-inspect/shared";
import { useRepos } from "@/hooks/use-repos";
import { useEnvironments } from "@/hooks/use-environments";
import { useBranches } from "@/hooks/use-branches";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { formatModelNameLower } from "@/lib/format";
import { resolveEnabledModel } from "@/lib/model-selection";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RepoIcon,
  BranchIcon,
  ModelIcon,
  ChevronDownIcon,
  CheckIcon,
  FolderIcon,
  BoxIcon,
  SearchIcon,
} from "@/components/ui/icons";
import { CronPicker } from "./cron-picker";
import { TriggerTypeSelector } from "./trigger-type-selector";
import { ConditionBuilder } from "./condition-builder";
import { cn } from "@/lib/utils";
import { NO_REPOSITORY_LABEL, formatRepositoriesLabel } from "@/lib/repo-label";
import { parseRepoFullName, type SessionTarget } from "@/lib/session-target";

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
];
const COMMON_SET = new Set(COMMON_TIMEZONES);
const ALL_TIMEZONES = Intl.supportedValuesOf("timeZone");
const DEFAULT_REASONING_VALUE = "__default__";

// Keep in sync with MAX_INSTRUCTIONS_LENGTH in
// packages/control-plane/src/routes/automations.ts.
const INSTRUCTIONS_MAX_LENGTH = 15000;
const INSTRUCTIONS_WARNING_THRESHOLD = Math.floor(INSTRUCTIONS_MAX_LENGTH * 0.9);
type RepoSelectionMode = "single" | "multiple";

function requiresRepositoryContext(triggerType: AutomationTriggerType): boolean {
  return triggerType === "github_event" || triggerType === "linear_event";
}

/** Selection key for a repository: the lowercase full name, as the API stores it. */
function repositoryKey(repoOwner: string, repoName: string): string {
  return `${repoOwner}/${repoName}`.toLowerCase();
}

/**
 * One entry of the automation's fan-out selection, reusing the shared
 * session-target model (lib/session-target.ts). An automation targets an
 * ordered list of launchable session targets: each `repo` entry runs in its
 * own session and each `environment` entry opens one workspace session. The
 * empty list is the repo-less selection ("No repository"). Single-select mode
 * replaces the whole list, so repo/environment mutual exclusivity there is
 * structural rather than enforced by cross-clearing effects.
 */
type AutomationSessionTarget = Extract<SessionTarget, { kind: "repo" | "environment" }>;

/**
 * Leaving multi-select keeps one target: the first repository, or the first
 * environment when only environments are selected.
 */
function collapseToSingleTarget(targets: AutomationSessionTarget[]): AutomationSessionTarget[] {
  const firstRepository = targets.find((target) => target.kind === "repo");
  return firstRepository ? [firstRepository] : targets.slice(0, 1);
}

const toOption = (tz: string) => ({ value: tz, label: tz.replace(/_/g, " ") });

const TIMEZONE_GROUPS: ComboboxGroup[] = [
  { category: "Common", options: COMMON_TIMEZONES.map(toOption) },
  {
    category: "All Timezones",
    options: ALL_TIMEZONES.filter((tz) => !COMMON_SET.has(tz)).map(toOption),
  },
];

function FieldDescription({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("text-xs text-muted-foreground mt-1 leading-normal", className)}>{children}</p>
  );
}

export interface AutomationFormValues {
  name: string;
  /** Full repository selection; submit always sends it (empty = repo-less). */
  repositories?: AutomationRepositoryInput[];
  /**
   * Environment selection; submit always sends it (empty = none). Each firing
   * opens one workspace session per selected environment, alongside the
   * per-repository sessions.
   */
  environmentIds?: string[];
  model: string;
  reasoningEffort: string | null;
  scheduleCron: string;
  scheduleTz: string;
  instructions: string;
  triggerType: AutomationTriggerType;
  eventType?: string;
  triggerConfig?: TriggerConfig;
  sentryClientSecret?: string;
}

interface AutomationFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<AutomationFormValues>;
  onSubmit: (values: AutomationFormValues) => void;
  submitting: boolean;
}

export function AutomationForm({ mode, initialValues, onSubmit, submitting }: AutomationFormProps) {
  const { repos, loading: loadingRepos } = useRepos();
  const { environments, loading: loadingEnvironments } = useEnvironments();
  const { enabledModels, enabledModelOptions, loading: loadingModels } = useEnabledModels();
  const initialRepositories = useMemo(
    () => initialValues?.repositories ?? [],
    [initialValues?.repositories]
  );

  const [name, setName] = useState(initialValues?.name ?? "");
  // The fan-out selection as one ordered list of session targets; repositories
  // and environments hydrate in selection order within each kind.
  const [selectedTargets, setSelectedTargets] = useState<AutomationSessionTarget[]>(() => [
    ...initialRepositories.map(
      (repository): AutomationSessionTarget => ({
        kind: "repo",
        repoFullName: repositoryKey(repository.repoOwner, repository.repoName),
      })
    ),
    ...(initialValues?.environmentIds ?? []).map(
      (environmentId): AutomationSessionTarget => ({ kind: "environment", environmentId })
    ),
  ]);
  const [repoSelectionMode, setRepoSelectionMode] = useState<RepoSelectionMode>(() =>
    // Combined count: a lone-repo default here would let the single-select
    // collapse effect silently drop hydrated environment targets on edit.
    initialRepositories.length + (initialValues?.environmentIds?.length ?? 0) > 1
      ? "multiple"
      : "single"
  );
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  // Per-kind views of the selection, in target order. Payload fields and the
  // render's selected-state checks derive from these.
  const selectedRepoNames = useMemo(
    () =>
      selectedTargets.flatMap((target) => (target.kind === "repo" ? [target.repoFullName] : [])),
    [selectedTargets]
  );
  const selectedEnvironmentIds = useMemo(
    () =>
      selectedTargets.flatMap((target) =>
        target.kind === "environment" ? [target.environmentId] : []
      ),
    [selectedTargets]
  );
  const selectedRepoName = selectedRepoNames[0] ?? "";
  const usesSingleRepository = selectedTargets.length === 1 && selectedTargets[0].kind === "repo";
  const selectedRepository = usesSingleRepository ? parseRepoFullName(selectedRepoName) : null;
  const { branches, loading: loadingBranches } = useBranches(
    selectedRepository?.owner ?? "",
    selectedRepository?.name ?? ""
  );
  const [baseBranch, setBaseBranch] = useState(() =>
    initialRepositories.length === 1 ? (initialRepositories[0].baseBranch ?? "") : ""
  );
  const [model, setModel] = useState(initialValues?.model ?? DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState(initialValues?.reasoningEffort ?? "");
  const [scheduleCron, setScheduleCron] = useState(initialValues?.scheduleCron ?? "0 9 * * *");
  const [scheduleTz, setScheduleTz] = useState(
    initialValues?.scheduleTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [instructions, setInstructions] = useState(initialValues?.instructions ?? "");
  const [triggerType, setTriggerType] = useState<AutomationTriggerType>(
    initialValues?.triggerType ?? "schedule"
  );
  const repositoryRequired = requiresRepositoryContext(triggerType);
  const [eventType, setEventType] = useState(initialValues?.eventType ?? "");
  const [eventTypeError, setEventTypeError] = useState("");
  const [conditions, setConditions] = useState<TriggerCondition[]>(
    initialValues?.triggerConfig?.conditions ?? []
  );
  const [sentryClientSecret, setSentryClientSecret] = useState("");

  const isSchedule = triggerType === "schedule";
  // Multi-repository selections are schedule-only (the server rejects them for
  // event triggers), so the mode toggle only exists there.
  const multiRepoAllowed = isSchedule;
  const multipleSelectionEnabled = multiRepoAllowed && repoSelectionMode === "multiple";
  const isSlack = triggerType === "slack_event";
  const isScheduleValid = !isSchedule || isValidCron(scheduleCron);
  const repositorySelectionDescription = repositoryRequired
    ? "Repository-scoped triggers need exactly one repository."
    : multipleSelectionEnabled
      ? `Select up to ${MAX_AUTOMATION_REPOSITORIES} repositories and environments combined. Each firing works every selected repository in its own session and opens one session per selected environment's full workspace.`
      : "Select no repository, one repository, or one environment.";
  // Mirror the server rule: a slack_event needs a slack_channel. A text_match is
  // optional — without one it fires on every message in the watched channel.
  const slackConditionsValid = !isSlack || conditions.some((c) => c.type === "slack_channel");

  // The model we display and submit. The selector only lists enabled models, so
  // a disabled default (blank create), a disabled saved model (edit), or a
  // disabled template suggestion is coerced to an enabled one. Until preferences
  // load we can't know the enabled set, so the raw selection stands and submit
  // is blocked — keeping display, reasoning, and the payload in agreement
  // without relying on a post-load effect.
  const resolvedModel = useMemo(
    () => (loadingModels ? model : resolveEnabledModel(model, enabledModels)),
    [loadingModels, model, enabledModels]
  );

  const triggerMetadata = useMemo(
    () => triggerSources.find((sourceDef) => sourceDef.triggerType === triggerType),
    [triggerType]
  );
  const eventTypes = useMemo(() => triggerMetadata?.eventTypes ?? [], [triggerMetadata]);
  const showEventTypeSelector = Boolean(
    triggerMetadata?.supportsEventTypes && eventTypes.length > 0
  );
  const eventTypePlaceholder = triggerMetadata?.eventTypePlaceholder || "Select event type...";

  // Reset eventType when it becomes invalid for the current trigger type
  useEffect(() => {
    if (!eventType) return;
    const stillValid = eventTypes.some((et) => et.eventType === eventType);
    if (!stillValid) setEventType("");
  }, [eventType, eventTypes]);

  useEffect(() => {
    if (!showEventTypeSelector || eventType) {
      setEventTypeError("");
    }
  }, [showEventTypeSelector, eventType]);

  const findRepo = useCallback(
    (key: string) => repos.find((repo) => repo.fullName.toLowerCase() === key),
    [repos]
  );

  // Branch state follows repository membership: exactly one selected
  // repository pins baseBranch to its default, anything else clears it.
  // Environment-only mutations bypass this (setSelectedTargets directly) so a
  // branch pick survives adding and removing environments around its repo.
  const applyTargets = useCallback(
    (nextTargets: AutomationSessionTarget[]) => {
      setSelectedTargets(nextTargets);
      const nextRepoNames = nextTargets.flatMap((target) =>
        target.kind === "repo" ? [target.repoFullName] : []
      );
      if (nextRepoNames.length === 1) {
        setBaseBranch(findRepo(nextRepoNames[0])?.defaultBranch ?? "");
      } else {
        setBaseBranch("");
      }
    },
    [findRepo]
  );

  useEffect(() => {
    if (!multiRepoAllowed && repoSelectionMode === "multiple") {
      setRepoSelectionMode("single");
    }
  }, [multiRepoAllowed, repoSelectionMode]);

  // Repo-scoped triggers stay bound to the webhook's repository, so any
  // environment targets (e.g. hydrated before a trigger-type change) drop out.
  useEffect(() => {
    if (!repositoryRequired) return;
    if (!selectedTargets.some((target) => target.kind === "environment")) return;
    setSelectedTargets(selectedTargets.filter((target) => target.kind === "repo"));
  }, [repositoryRequired, selectedTargets]);

  useEffect(() => {
    if (multipleSelectionEnabled || selectedTargets.length <= 1) return;
    applyTargets(collapseToSingleTarget(selectedTargets));
  }, [applyTargets, multipleSelectionEnabled, selectedTargets]);

  const targetCount = selectedTargets.length;

  const handleRepoToggle = useCallback(
    (repoFullName: string) => {
      const target: AutomationSessionTarget = {
        kind: "repo",
        repoFullName: repoFullName.toLowerCase(),
      };
      if (!multipleSelectionEnabled) {
        applyTargets([target]);
        setRepoDropdownOpen(false);
        return;
      }

      const selected = selectedRepoNames.includes(target.repoFullName);
      if (!selected && targetCount >= MAX_AUTOMATION_REPOSITORIES) return;
      applyTargets(
        selected
          ? selectedTargets.filter(
              (entry) => !(entry.kind === "repo" && entry.repoFullName === target.repoFullName)
            )
          : [...selectedTargets, target]
      );
    },
    [applyTargets, multipleSelectionEnabled, selectedRepoNames, selectedTargets, targetCount]
  );

  const handleEnvironmentToggle = useCallback(
    (environmentId: string) => {
      const target: AutomationSessionTarget = { kind: "environment", environmentId };
      if (!multipleSelectionEnabled) {
        applyTargets([target]);
        setRepoDropdownOpen(false);
        return;
      }

      const selected = selectedEnvironmentIds.includes(environmentId);
      if (!selected && targetCount >= MAX_AUTOMATION_REPOSITORIES) return;
      setSelectedTargets(
        selected
          ? selectedTargets.filter(
              (entry) => !(entry.kind === "environment" && entry.environmentId === environmentId)
            )
          : [...selectedTargets, target]
      );
    },
    [applyTargets, multipleSelectionEnabled, selectedEnvironmentIds, selectedTargets, targetCount]
  );

  const handleNoRepository = useCallback(() => {
    if (repositoryRequired) return;
    applyTargets([]);
    setRepoDropdownOpen(false);
  }, [applyTargets, repositoryRequired]);

  const handleRepoSelectionModeToggle = useCallback(() => {
    if (!multiRepoAllowed) return;

    if (repoSelectionMode === "multiple") {
      setRepoSelectionMode("single");
      if (selectedTargets.length > 1) {
        applyTargets(collapseToSingleTarget(selectedTargets));
      }
      return;
    }

    setRepoSelectionMode("multiple");
  }, [applyTargets, multiRepoAllowed, repoSelectionMode, selectedTargets]);

  useEffect(() => {
    if (!repoDropdownOpen) {
      setRepoQuery("");
    }
  }, [repoDropdownOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Block until enabled models load: resolvedModel can't coerce against an
    // unknown set, so submitting now could persist a disabled model.
    if (loadingModels) return;
    if (
      !name.trim() ||
      (repositoryRequired && selectedRepoNames.length === 0) ||
      !instructions.trim() ||
      !isScheduleValid
    ) {
      return;
    }
    if (triggerType === "sentry" && mode === "create" && !sentryClientSecret.trim()) return;
    if (!slackConditionsValid) return;
    if (showEventTypeSelector && !eventType) {
      setEventTypeError("Event type is required.");
      return;
    }

    const values: AutomationFormValues = {
      name: name.trim(),
      // Always send the full selection — an empty list means none.
      environmentIds: selectedEnvironmentIds,
      model: resolvedModel,
      reasoningEffort:
        reasoningEffort && isValidReasoningEffort(resolvedModel, reasoningEffort)
          ? reasoningEffort
          : null,
      scheduleCron,
      scheduleTz,
      instructions: instructions.trim(),
      triggerType,
      // Always send the full selection — an empty list means repo-less.
      repositories: selectedRepoNames.map((key) => {
        const [entryOwner = "", entryName = ""] = key.split("/");
        const entry: AutomationRepositoryInput = { repoOwner: entryOwner, repoName: entryName };
        if (usesSingleRepository) {
          if (baseBranch.trim()) entry.baseBranch = baseBranch.trim();
        } else {
          // Multi-repo selections have no branch picker; keep the branch each
          // already-selected repository had so an unrelated edit can't reset it.
          const existing = initialRepositories.find(
            (repository) => repositoryKey(repository.repoOwner, repository.repoName) === key
          );
          if (existing?.baseBranch) entry.baseBranch = existing.baseBranch;
        }
        return entry;
      }),
    };

    if (!isSchedule) {
      // Don't send schedule fields for non-schedule types
      delete (values as Partial<AutomationFormValues>).scheduleCron;
      delete (values as Partial<AutomationFormValues>).scheduleTz;

      if (eventType) values.eventType = eventType;
      // Always send triggerConfig so clearing all conditions persists (PUT skips
      // trigger_config when triggerConfig is omitted).
      values.triggerConfig = { conditions };
      if (triggerType === "sentry" && mode === "create" && sentryClientSecret.trim()) {
        values.sentryClientSecret = sentryClientSecret.trim();
      }
    }

    onSubmit(values);
  };

  const filteredRepos = useMemo(() => {
    const query = repoQuery.trim().toLowerCase();
    if (!query) return repos;
    return repos.filter(
      (repo) =>
        repo.fullName.toLowerCase().includes(query) ||
        repo.name.toLowerCase().includes(query) ||
        repo.owner.toLowerCase().includes(query)
    );
  }, [repos, repoQuery]);
  const filteredEnvironments = useMemo(() => {
    // Environments are hidden for repo-scoped triggers, which must stay bound
    // to the webhook's repository.
    if (repositoryRequired) return [];
    const query = repoQuery.trim().toLowerCase();
    if (!query) return environments;
    return environments.filter((environment) => environment.name.toLowerCase().includes(query));
  }, [environments, repositoryRequired, repoQuery]);
  const environmentName = (environmentId: string) =>
    environments.find((environment) => environment.id === environmentId)?.name ??
    (loadingEnvironments ? "Loading..." : environmentId);
  const repositoryLabel = (() => {
    if (targetCount === 0) return NO_REPOSITORY_LABEL;
    if (selectedRepoNames.length === 1 && selectedEnvironmentIds.length === 0) {
      return findRepo(selectedRepoName)?.fullName ?? selectedRepoName;
    }
    if (selectedEnvironmentIds.length === 1 && selectedRepoNames.length === 0) {
      return environmentName(selectedEnvironmentIds[0]);
    }
    const parts: string[] = [];
    if (selectedRepoNames.length > 0) {
      parts.push(
        selectedRepoNames.length === 1 ? "1 repository" : `${selectedRepoNames.length} repositories`
      );
    }
    if (selectedEnvironmentIds.length > 0) {
      parts.push(
        selectedEnvironmentIds.length === 1
          ? "1 environment"
          : `${selectedEnvironmentIds.length} environments`
      );
    }
    return parts.join(" + ");
  })();
  const reasoningConfig = getReasoningConfig(resolvedModel);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Trigger Type */}
      {mode === "create" ? (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Trigger Type</label>
          <FieldDescription className="my-1">
            Scheduled automations run on a repeating timer. Other types run when the connected
            service sends an event (for example a GitHub webhook or Sentry alert).
          </FieldDescription>
          <TriggerTypeSelector value={triggerType} onChange={setTriggerType} />
        </div>
      ) : (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Trigger Type</label>
          <div className="text-sm text-muted-foreground px-3 py-2 border border-border-muted rounded-md bg-muted/30">
            {{
              schedule: "Schedule",
              sentry: "Sentry Alert",
              webhook: "Inbound Webhook",
              github_event: "GitHub Event",
              linear_event: "Linear Event",
              slack_event: "Slack Message",
            }[triggerType] || triggerType}
            <span className="text-xs ml-2">(cannot be changed)</span>
          </div>
          <FieldDescription>
            Trigger type is fixed after the automation is created. Create a new automation to use a
            different trigger.
          </FieldDescription>
        </div>
      )}

      {/* Name */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Name</label>
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isSchedule ? "Daily code review" : "Review new PRs"}
          maxLength={200}
          required
        />
      </div>

      {/* Repository Configuration */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">
          Repository Configuration
        </label>
        <Popover open={repoDropdownOpen} onOpenChange={setRepoDropdownOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm border border-border bg-input px-3 py-2 text-sm text-foreground transition hover:border-foreground/20 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              aria-label="Repository selection"
            >
              {selectedEnvironmentIds.length > 0 && selectedRepoNames.length === 0 ? (
                <BoxIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <RepoIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-left">
                {loadingRepos && targetCount === 0 ? "Loading..." : repositoryLabel}
              </span>
              {multipleSelectionEnabled && targetCount > 1 && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {targetCount}/{MAX_AUTOMATION_REPOSITORIES}
                </span>
              )}
              <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[min(34rem,calc(100vw-2rem))] p-0 sm:w-[var(--radix-popover-trigger-width)]"
          >
            <div className="border-b border-border-muted p-2">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={repoQuery}
                  onChange={(event) => setRepoQuery(event.target.value)}
                  placeholder={loadingRepos ? "Loading repositories..." : "Search repositories"}
                  disabled={loadingRepos}
                  autoFocus
                  className="pl-8"
                />
              </div>
            </div>
            {filteredEnvironments.length > 0 && (
              <>
                <div className="border-b border-border-muted px-3 py-2">
                  <span className="text-xs font-medium uppercase text-muted-foreground">
                    Environments
                  </span>
                </div>
                <div className="max-h-40 overflow-y-auto border-b border-border-muted py-1">
                  {filteredEnvironments.map((environment) => {
                    const selected = selectedEnvironmentIds.includes(environment.id);
                    const disabled =
                      multipleSelectionEnabled &&
                      !selected &&
                      targetCount >= MAX_AUTOMATION_REPOSITORIES;

                    return multipleSelectionEnabled ? (
                      <label
                        key={environment.id}
                        className={cn(
                          "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                          selected ? "bg-muted text-foreground" : "hover:bg-muted/60",
                          disabled && "cursor-not-allowed opacity-50"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={disabled}
                          onChange={() => handleEnvironmentToggle(environment.id)}
                          className="h-4 w-4 rounded border-border accent-accent"
                        />
                        <BoxIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{environment.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatRepositoriesLabel(environment.repositories)}
                        </span>
                      </label>
                    ) : (
                      <button
                        type="button"
                        key={environment.id}
                        onClick={() => handleEnvironmentToggle(environment.id)}
                        className={cn(
                          "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                          selected ? "bg-muted text-foreground" : "hover:bg-muted/60"
                        )}
                      >
                        <BoxIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{environment.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatRepositoriesLabel(environment.repositories)}
                        </span>
                        {selected && <CheckIcon className="h-4 w-4 shrink-0 text-accent" />}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className="flex items-center justify-between border-b border-border-muted px-3 py-2">
              <span className="text-xs font-medium uppercase text-muted-foreground">
                All repositories
              </span>
              {multiRepoAllowed && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={handleRepoSelectionModeToggle}
                >
                  {multipleSelectionEnabled ? "Select One" : "Select Multiple"}
                </Button>
              )}
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {multipleSelectionEnabled ? (
                <label
                  className={cn(
                    "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                    targetCount === 0 ? "bg-muted text-foreground" : "hover:bg-muted/60",
                    repositoryRequired && "cursor-not-allowed opacity-50"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={targetCount === 0}
                    disabled={repositoryRequired}
                    onChange={handleNoRepository}
                    className="h-4 w-4 rounded border-border accent-accent"
                  />
                  <RepoIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>{NO_REPOSITORY_LABEL}</span>
                </label>
              ) : (
                <button
                  type="button"
                  disabled={repositoryRequired}
                  onClick={handleNoRepository}
                  className={cn(
                    "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                    targetCount === 0 ? "bg-muted text-foreground" : "hover:bg-muted/60",
                    repositoryRequired && "cursor-not-allowed opacity-50"
                  )}
                >
                  <RepoIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{NO_REPOSITORY_LABEL}</span>
                  {targetCount === 0 && <CheckIcon className="h-4 w-4 text-accent" />}
                </button>
              )}
              {filteredRepos.map((repo) => {
                const checked = selectedRepoNames.includes(repo.fullName.toLowerCase());
                const disabled =
                  multipleSelectionEnabled &&
                  !checked &&
                  targetCount >= MAX_AUTOMATION_REPOSITORIES;

                return multipleSelectionEnabled ? (
                  <label
                    key={repo.fullName}
                    className={cn(
                      "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                      checked ? "bg-muted text-foreground" : "hover:bg-muted/60",
                      disabled && "cursor-not-allowed opacity-50"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => handleRepoToggle(repo.fullName)}
                      className="h-4 w-4 rounded border-border accent-accent"
                    />
                    <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {repo.owner}/{repo.name}
                    </span>
                    {repo.private && <span className="text-xs text-muted-foreground">private</span>}
                  </label>
                ) : (
                  <button
                    type="button"
                    key={repo.fullName}
                    onClick={() => handleRepoToggle(repo.fullName)}
                    className={cn(
                      "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                      checked ? "bg-muted text-foreground" : "hover:bg-muted/60"
                    )}
                  >
                    <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {repo.owner}/{repo.name}
                    </span>
                    {repo.private && <span className="text-xs text-muted-foreground">private</span>}
                    {checked && <CheckIcon className="h-4 w-4 shrink-0 text-accent" />}
                  </button>
                );
              })}
              {filteredRepos.length === 0 && (
                <div className="px-3 py-3 text-sm text-muted-foreground">No repositories found</div>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <FieldDescription>{repositorySelectionDescription}</FieldDescription>
      </div>

      {/* Branch (single-repository selections only; multi-repo runs use each repo's default) */}
      {usesSingleRepository && (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Branch</label>
          <Combobox
            value={baseBranch}
            onChange={setBaseBranch}
            items={branches.map((b) => ({
              value: b.name,
              label: b.name,
            }))}
            searchable
            searchPlaceholder="Search branches..."
            filterFn={(option, query) => option.label.toLowerCase().includes(query)}
            dropdownWidth="w-56"
            disabled={!selectedRepoName || loadingBranches}
            triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
          >
            <BranchIcon className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="truncate flex-1 text-left">
              {loadingBranches ? "Loading..." : baseBranch || "Select branch"}
            </span>
            <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
          </Combobox>
          <FieldDescription>
            Default branch checked out when a session run starts. Selecting a repository resets this
            to that repo&apos;s default branch. To filter pull requests by merge target, add a
            Target branch condition below; Head branch matches the PR source branch.
          </FieldDescription>
        </div>
      )}

      {/* Model */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Model</label>
        <Combobox
          value={resolvedModel}
          onChange={(nextModel) => {
            setModel(nextModel);
            if (reasoningEffort && !isValidReasoningEffort(nextModel, reasoningEffort)) {
              setReasoningEffort("");
            }
          }}
          items={
            enabledModelOptions.map((group) => ({
              category: group.category,
              options: group.models.map((m) => ({
                value: m.id,
                label: m.name,
                description: m.description,
              })),
            })) as ComboboxGroup[]
          }
          dropdownWidth="w-56"
          triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
        >
          <ModelIcon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="truncate flex-1 text-left">{formatModelNameLower(resolvedModel)}</span>
          <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
        </Combobox>
        <FieldDescription>
          Model used for the agent on each run of this automation.
        </FieldDescription>
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Reasoning Effort</label>
        <Select
          value={reasoningConfig ? reasoningEffort || DEFAULT_REASONING_VALUE : ""}
          onValueChange={(value) =>
            setReasoningEffort(value === DEFAULT_REASONING_VALUE ? "" : value)
          }
          disabled={!reasoningConfig}
        >
          <SelectTrigger className="w-full">
            <SelectValue
              placeholder={reasoningConfig ? "Use model default" : "Not supported for this model"}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_REASONING_VALUE}>Use model default</SelectItem>
            {(reasoningConfig?.efforts ?? []).map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          For models that support it, overrides how much chain-of-thought style reasoning is
          allowed. &quot;Use model default&quot; leaves the choice to the model.
        </FieldDescription>
      </div>

      {/* Schedule fields (only for schedule type) */}
      {isSchedule && (
        <>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Schedule</label>
            <CronPicker value={scheduleCron} onChange={setScheduleCron} timezone={scheduleTz} />
            <FieldDescription>
              How often this automation runs. Use a preset or a five-field cron expression (minute,
              hour, day of month, month, day of week).
            </FieldDescription>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Timezone</label>
            <Combobox
              value={scheduleTz}
              onChange={setScheduleTz}
              items={TIMEZONE_GROUPS}
              maxDisplayed={20}
              searchable
              searchPlaceholder="Search timezones..."
              filterFn={(option, query) =>
                option.label.toLowerCase().includes(query) ||
                String(option.value).toLowerCase().includes(query)
              }
              dropdownWidth="w-64"
              triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
            >
              <span className="truncate flex-1 text-left">{scheduleTz.replace(/_/g, " ")}</span>
              <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
            </Combobox>
            <FieldDescription>
              The schedule is evaluated in this time zone (for example, &quot;9:00&quot; is 9:00
              local time here).
            </FieldDescription>
          </div>
        </>
      )}

      {/* Event type selector (for trigger sources with event type support) */}
      {showEventTypeSelector && (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Event Type</label>
          <Select
            value={eventType}
            onValueChange={(value) => {
              setEventType(value);
              if (eventTypeError) setEventTypeError("");
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={eventTypePlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {eventTypes.map((et) => (
                <SelectItem key={et.eventType} value={et.eventType}>
                  {et.displayName}
                  <span className="text-muted-foreground ml-2 text-xs">{et.description}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            Only events of this type on the selected repository can start a run for this automation.
          </FieldDescription>
          {eventTypeError && <p className="mt-1 text-xs text-destructive">{eventTypeError}</p>}
        </div>
      )}

      {/* Sentry Client Secret (create mode only) */}
      {triggerType === "sentry" && mode === "create" && (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Sentry Client Secret
          </label>
          <Input
            type="password"
            value={sentryClientSecret}
            onChange={(e) => setSentryClientSecret(e.target.value)}
            placeholder="Paste your Sentry Custom Integration client secret"
            required
          />
          <p className="text-xs text-muted-foreground mt-1">
            Found in your Sentry Custom Integration settings. This will be encrypted and stored
            securely.
          </p>
        </div>
      )}

      {/* Conditions (for non-schedule types) */}
      {!isSchedule && TRIGGER_TYPE_TO_SOURCE[triggerType] && (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Conditions
            <span className="text-xs text-muted-foreground ml-1 font-normal">(optional)</span>
          </label>
          <ConditionBuilder
            conditions={conditions}
            onChange={setConditions}
            triggerSource={TRIGGER_TYPE_TO_SOURCE[triggerType] as AutomationEventSource}
          />
          <FieldDescription>
            Optional filters on incoming events. When you add conditions, every condition must pass
            before a run starts.
          </FieldDescription>
          {isSlack && !slackConditionsValid && (
            <p className="mt-1 text-xs text-destructive">
              Slack triggers require at least one Slack Channel condition.
            </p>
          )}
        </div>
      )}

      {/* Instructions */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Instructions</label>
        <FieldDescription className="mb-1.5">
          Main prompt for the agent when a run starts. For event-based triggers, a short summary of
          the event is inserted above this text.
        </FieldDescription>
        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={
            isSchedule
              ? "Run the test suite and fix any failing tests. If all tests pass, look for TODO comments and address the most impactful one."
              : triggerType === "sentry"
                ? "Investigate this Sentry error. Find the root cause in the codebase, then open a PR with a fix."
                : triggerType === "github_event"
                  ? "Review this pull request and provide feedback. Check for code quality issues, potential bugs, and suggest improvements."
                  : "Process this webhook payload and take the appropriate action."
          }
          maxLength={INSTRUCTIONS_MAX_LENGTH}
          required
          rows={6}
          aria-describedby="instructions-counter"
          className="resize-y"
        />
        <div
          id="instructions-counter"
          aria-live="polite"
          className={`mt-1 text-xs text-right ${
            instructions.length >= INSTRUCTIONS_MAX_LENGTH
              ? "text-destructive"
              : instructions.length >= INSTRUCTIONS_WARNING_THRESHOLD
                ? "text-warning"
                : "text-muted-foreground"
          }`}
        >
          {instructions.length >= INSTRUCTIONS_MAX_LENGTH ? (
            <span>Maximum length reached. </span>
          ) : null}
          {instructions.length.toLocaleString()} / {INSTRUCTIONS_MAX_LENGTH.toLocaleString()}
        </div>
      </div>

      {/* Submit */}
      <div className="flex justify-end gap-2">
        <Button
          type="submit"
          disabled={
            submitting ||
            loadingModels ||
            !name.trim() ||
            (repositoryRequired && selectedRepoNames.length === 0) ||
            !instructions.trim() ||
            !isScheduleValid ||
            !slackConditionsValid ||
            (showEventTypeSelector && !eventType) ||
            (triggerType === "sentry" && mode === "create" && !sentryClientSecret.trim())
          }
        >
          {submitting
            ? mode === "create"
              ? "Creating..."
              : "Saving..."
            : mode === "create"
              ? "Create Automation"
              : "Save Changes"}
        </Button>
      </div>
    </form>
  );
}
