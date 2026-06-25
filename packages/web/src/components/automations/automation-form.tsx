"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_RUNS_PER_HOUR,
  getReasoningConfig,
  isValidCron,
  isValidReasoningEffort,
  triggerSources,
  TRIGGER_TYPE_TO_SOURCE,
  type AutomationTriggerType,
  type AutomationEventSource,
  type TriggerCondition,
  type TriggerConfig,
} from "@open-inspect/shared";
import { useRepos } from "@/hooks/use-repos";
import { useBranches } from "@/hooks/use-branches";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { formatModelNameLower } from "@/lib/format";
import { resolveEnabledModel } from "@/lib/model-selection";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RepoIcon, BranchIcon, ModelIcon, ChevronDownIcon } from "@/components/ui/icons";
import { CronPicker } from "./cron-picker";
import { TriggerTypeSelector } from "./trigger-type-selector";
import { ConditionBuilder } from "./condition-builder";
import { cn } from "@/lib/utils";

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
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  model: string;
  reasoningEffort: string | null;
  scheduleCron: string;
  scheduleTz: string;
  instructions: string;
  triggerType: AutomationTriggerType;
  eventType?: string;
  triggerConfig?: TriggerConfig;
  sentryClientSecret?: string;
  maxRunsPerHour?: number | null;
}

interface AutomationFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<AutomationFormValues>;
  onSubmit: (values: AutomationFormValues) => void;
  submitting: boolean;
}

export function AutomationForm({ mode, initialValues, onSubmit, submitting }: AutomationFormProps) {
  const { repos, loading: loadingRepos } = useRepos();
  const { enabledModels, enabledModelOptions, loading: loadingModels } = useEnabledModels();

  const [name, setName] = useState(initialValues?.name ?? "");
  const [selectedRepo, setSelectedRepo] = useState(
    initialValues?.repoOwner && initialValues?.repoName
      ? `${initialValues.repoOwner}/${initialValues.repoName}`
      : ""
  );
  const repoOwner = selectedRepo.split("/")[0] ?? "";
  const repoName = selectedRepo.split("/")[1] ?? "";
  const { branches, loading: loadingBranches } = useBranches(repoOwner, repoName);
  const [baseBranch, setBaseBranch] = useState(initialValues?.baseBranch ?? "");
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
  const [eventType, setEventType] = useState(initialValues?.eventType ?? "");
  const [eventTypeError, setEventTypeError] = useState("");
  const [conditions, setConditions] = useState<TriggerCondition[]>(
    initialValues?.triggerConfig?.conditions ?? []
  );
  const [sentryClientSecret, setSentryClientSecret] = useState("");
  const [maxRunsPerHour, setMaxRunsPerHour] = useState(
    initialValues?.maxRunsPerHour != null ? String(initialValues.maxRunsPerHour) : ""
  );

  const isSchedule = triggerType === "schedule";
  const isSlack = triggerType === "slack_event";
  const isScheduleValid = !isSchedule || isValidCron(scheduleCron);
  // Mirror the server rule: a slack_event needs a slack_channel + a text_match.
  const slackConditionsValid =
    !isSlack ||
    (conditions.some((c) => c.type === "slack_channel") &&
      conditions.some((c) => c.type === "text_match"));
  // Mirror the server rule: blank uses the default, otherwise a positive integer.
  // Use Number (not parseInt) so "1.5" is rejected rather than truncated to 1.
  const trimmedMaxRuns = maxRunsPerHour.trim();
  const parsedMaxRuns = Number(trimmedMaxRuns);
  const maxRunsValid =
    !isSlack || trimmedMaxRuns === "" || (Number.isInteger(parsedMaxRuns) && parsedMaxRuns > 0);

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

  const handleRepoChange = useCallback(
    (repoFullName: string) => {
      setSelectedRepo(repoFullName);
      const repo = repos.find((r) => r.fullName === repoFullName);
      if (repo) setBaseBranch(repo.defaultBranch);
    },
    [repos]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Block until enabled models load: resolvedModel can't coerce against an
    // unknown set, so submitting now could persist a disabled model.
    if (loadingModels) return;
    if (!name.trim() || !selectedRepo || !instructions.trim() || !isScheduleValid) return;
    if (triggerType === "sentry" && mode === "create" && !sentryClientSecret.trim()) return;
    if (!slackConditionsValid) return;
    if (!maxRunsValid) return;
    if (showEventTypeSelector && !eventType) {
      setEventTypeError("Event type is required.");
      return;
    }

    const values: AutomationFormValues = {
      name: name.trim(),
      repoOwner,
      repoName,
      baseBranch,
      model: resolvedModel,
      reasoningEffort:
        reasoningEffort && isValidReasoningEffort(resolvedModel, reasoningEffort)
          ? reasoningEffort
          : null,
      scheduleCron,
      scheduleTz,
      instructions: instructions.trim(),
      triggerType,
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
      if (isSlack) {
        // Guarded by maxRunsValid above, so trimmedMaxRuns is "" or a positive integer.
        values.maxRunsPerHour = trimmedMaxRuns ? parsedMaxRuns : null;
      }
    }

    if (mode === "edit") {
      delete (values as Partial<AutomationFormValues>).repoOwner;
      delete (values as Partial<AutomationFormValues>).repoName;
    }
    onSubmit(values);
  };

  const selectedRepoObj = repos.find(
    (r) => r.fullName === selectedRepo || r.fullName.toLowerCase() === selectedRepo.toLowerCase()
  );
  const displayRepoName = selectedRepoObj
    ? selectedRepoObj.name
    : selectedRepo || "Select repository";
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

      {/* Repository */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Repository</label>
        <Combobox
          value={selectedRepo}
          onChange={handleRepoChange}
          items={repos.map((repo) => ({
            value: repo.fullName,
            label: repo.name,
            description: `${repo.owner}${repo.private ? " \u2022 private" : ""}`,
          }))}
          searchable
          searchPlaceholder="Search repositories..."
          filterFn={(option, query) =>
            option.label.toLowerCase().includes(query) ||
            (option.description?.toLowerCase().includes(query) ?? false) ||
            String(option.value).toLowerCase().includes(query)
          }
          dropdownWidth="w-72"
          disabled={loadingRepos || mode === "edit"}
          triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
        >
          <RepoIcon className="w-4 h-4 text-muted-foreground" />
          <span className="truncate flex-1 text-left">
            {loadingRepos ? "Loading..." : displayRepoName}
          </span>
          <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
        </Combobox>
        <FieldDescription>
          Runs clone and execute against this repository.
          {mode === "edit" ? " The repository cannot be changed after creation." : ""}
        </FieldDescription>
      </div>

      {/* Branch */}
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
          disabled={!selectedRepo || loadingBranches}
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
          to that repo&apos;s default branch. To filter pull requests by merge target, add a Target
          branch condition below; Head branch matches the PR source branch.
        </FieldDescription>
      </div>

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
              Slack triggers require at least one Slack Channel and one Message Text condition.
            </p>
          )}
        </div>
      )}

      {/* Slack rate limit (slack_event only) */}
      {isSlack && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Max runs per hour
            </label>
            <Input
              type="number"
              min={1}
              step={1}
              value={maxRunsPerHour}
              onChange={(e) => setMaxRunsPerHour(e.target.value)}
              placeholder={`Default (${DEFAULT_MAX_RUNS_PER_HOUR})`}
              className="w-40"
            />
            <FieldDescription>
              Caps how many runs this automation can start per hour. Extra matching messages are
              skipped. Leave blank to use the default ({DEFAULT_MAX_RUNS_PER_HOUR}).
            </FieldDescription>
            {!maxRunsValid && (
              <p className="mt-1 text-xs text-destructive">
                Max runs per hour must be a positive whole number.
              </p>
            )}
          </div>
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
            !selectedRepo ||
            !instructions.trim() ||
            !isScheduleValid ||
            !slackConditionsValid ||
            !maxRunsValid ||
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
