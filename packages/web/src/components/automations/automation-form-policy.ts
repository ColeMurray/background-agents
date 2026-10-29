import { isValidTimeZone, validateAutomationCron } from "@open-inspect/shared/cron";
import {
  conditionRegistry,
  hasSlackActorIncludeList,
  hasValidSlackChannelCondition,
  triggerSources,
  validateTriggerConditions,
  type AutomationTriggerType,
  type TriggerCondition,
  type TriggerConfig,
} from "@open-inspect/shared/triggers";
import {
  DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
  MAX_AUTOMATION_CONCURRENT_RUNS,
  MAX_AUTOMATION_NAME_LENGTH,
  validateAutomationTargetCounts,
  type Automation,
  type AutomationRepositoryInput,
} from "@open-inspect/shared/types/automations";
import { isValidHarnessReasoningEffort } from "@open-inspect/shared/harnesses";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import {
  getValidHarnessOrDefault,
  reconcileProviderSelectionsForHarness,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import type { HarnessModelAvailability } from "@/lib/session-harness";
import { repositoryKey } from "./automation-target-selection";
import type { ModelProviderSelections } from "@open-inspect/shared/types/provider-accounts";

export interface AutomationFormValues {
  teamId?: string | null;
  name: string;
  repositories: AutomationRepositoryInput[];
  environmentIds: string[];
  harness: HarnessId;
  model: string;
  reasoningEffort: string | null;
  scheduleCron?: string;
  scheduleOnceAt?: number;
  scheduleTz?: string;
  maxConcurrentRuns?: number;

  /** Launch retries; submitted for schedule triggers only. */
  maxRetries?: number;
  instructions: string;
  triggerType: AutomationTriggerType;
  eventType?: string;
  triggerConfig?: TriggerConfig;
  sentryClientSecret?: string;
  providerSelections: ModelProviderSelections;
}

export interface AutomationTriggerDraft {
  type: AutomationTriggerType;
  scheduleCron: string;
  scheduleMode: "recurring" | "once";
  scheduleOnceAt: string;
  scheduleTz: string;
  maxConcurrentRuns: number;

  maxRetries: number;
  eventType: string;
  conditions: TriggerCondition[];
  /** Slack triggers only: let other bots' messages trigger the automation. */
  includeBotMessages: boolean;
  sentryClientSecret: string;
}

export interface AutomationAgentDraft {
  harness: HarnessId;
  model: string;
  reasoningEffort: string;
}

export interface AutomationFormDraft {
  name: string;
  instructions: string;
  providerSelections: ModelProviderSelections;
  trigger: AutomationTriggerDraft;
  agent: AutomationAgentDraft;
}

export type AutomationFormMode = "create" | "edit";

type AutomationFormInvalidReason =
  | "models-loading"
  | "no-compatible-model"
  | "required-fields"
  | "invalid-schedule"
  | "invalid-target-selection"
  | "repository-required"
  | "event-type-required"
  | "invalid-conditions"
  | "slack-channel-required"
  | "slack-bot-allow-list-required"
  | "sentry-secret-required";

export type AutomationFormEvaluation =
  | { valid: true; values: AutomationFormValues }
  | {
      valid: false;
      reason: Exclude<AutomationFormInvalidReason, "invalid-conditions">;
    }
  | {
      valid: false;
      reason: "invalid-conditions";
      conditionErrors: string[];
    };

type InitialAutomationFormValues = Partial<AutomationFormValues>;

export const DEFAULT_AUTOMATION_SCHEDULE_CRON = "0 9 * * *";

/**
 * Coerce a stored or template concurrency to the range the API accepts. An
 * automation created before the field existed, or a template that omits it,
 * reads as DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS rather than as an invalid
 * form.
 */
export function clampConcurrentRuns(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS;
  }
  return Math.min(MAX_AUTOMATION_CONCURRENT_RUNS, Math.max(1, Math.trunc(value)));
}

function toLocalDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function createAutomationFormDraft(
  initialValues: InitialAutomationFormValues = {}
): AutomationFormDraft {
  const harness = getValidHarnessOrDefault(initialValues.harness);
  return {
    name: initialValues.name ?? "",
    instructions: initialValues.instructions ?? "",
    providerSelections: reconcileProviderSelectionsForHarness(
      harness,
      initialValues.providerSelections ?? {}
    ),
    trigger: {
      type: initialValues.triggerType ?? "schedule",
      scheduleCron: initialValues.scheduleCron ?? DEFAULT_AUTOMATION_SCHEDULE_CRON,
      scheduleMode: initialValues.scheduleOnceAt != null ? "once" : "recurring",
      scheduleOnceAt:
        initialValues.scheduleOnceAt != null ? toLocalDateTime(initialValues.scheduleOnceAt) : "",
      scheduleTz: initialValues.scheduleTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      maxConcurrentRuns: clampConcurrentRuns(initialValues.maxConcurrentRuns),

      maxRetries: initialValues.maxRetries ?? 0,
      eventType: initialValues.eventType ?? "",
      conditions: initialValues.triggerConfig?.conditions ?? [],
      includeBotMessages: initialValues.triggerConfig?.slack?.includeBotMessages === true,
      sentryClientSecret: "",
    },
    agent: {
      harness,
      model: initialValues.model ?? DEFAULT_MODEL,
      reasoningEffort: initialValues.reasoningEffort ?? "",
    },
  };
}

/** Form values for an existing automation, used to edit or duplicate it. */
export function automationToFormValues(automation: Automation): InitialAutomationFormValues {
  return {
    teamId: automation.ownerTeamId ?? null,
    name: automation.name,
    repositories: automation.repositories,
    environmentIds: automation.environmentIds,
    harness: automation.harness,
    model: automation.model,
    reasoningEffort: automation.reasoningEffort,
    scheduleCron: automation.scheduleCron ?? DEFAULT_AUTOMATION_SCHEDULE_CRON,
    scheduleTz: automation.scheduleTz,
    scheduleOnceAt: automation.scheduleOnceAt ?? undefined,
    maxConcurrentRuns: automation.maxConcurrentRuns,
    maxRetries: automation.maxRetries,
    instructions: automation.instructions,
    triggerType: automation.triggerType,
    eventType: automation.eventType ?? undefined,
    triggerConfig: automation.triggerConfig ?? undefined,
    providerSelections: automation.providerSelections,
  };
}

/**
 * Slack channel conditions are bound to the owning team (create rejects channels bound to another
 * owner), so an ownership change drops them, leaving required-channel validation to ask again.
 */
export function withoutOwnerBoundConditions(conditions: TriggerCondition[]): TriggerCondition[] {
  return conditions.filter((condition) => condition.type !== "slack_channel");
}

/** `values` moved to `teamId`: owner-bound targets and Slack channels don't carry over. */
export function changeAutomationFormOwner(
  values: InitialAutomationFormValues,
  teamId: string | null
): InitialAutomationFormValues {
  return {
    ...values,
    teamId,
    repositories: [],
    environmentIds: [],
    triggerConfig: values.triggerConfig && {
      ...values.triggerConfig,
      conditions: withoutOwnerBoundConditions(values.triggerConfig.conditions),
    },
  };
}

/**
 * Whether a new automation may be owned by `teamId` (null for the workspace), once the viewer's
 * team choices have loaded.
 */
export function automationOwnerSelectable(
  teamId: string | null,
  scope: { teams: { id: string }[]; loading: boolean; error: unknown; allowWorkspace: boolean },
  requireTeam: boolean
): boolean {
  if (scope.loading || scope.error) return false;
  return teamId
    ? scope.teams.some((team) => team.id === teamId)
    : scope.allowWorkspace && !requireTeam;
}

const COPY_NAME_SUFFIX = " (copy)";

/**
 * The source name plus a copy suffix, trimmed to fit MAX_AUTOMATION_NAME_LENGTH. A copy of a copy
 * keeps one suffix, and the trim cuts between graphemes so it can't split an emoji or accent.
 */
export function automationCopyName(name: string): string {
  const original = name.endsWith(COPY_NAME_SUFFIX) ? name.slice(0, -COPY_NAME_SUFFIX.length) : name;
  const limit = MAX_AUTOMATION_NAME_LENGTH - COPY_NAME_SUFFIX.length;
  let base = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    original
  )) {
    if (base.length + segment.length > limit) break;
    base += segment;
  }
  return `${base.trimEnd()}${COPY_NAME_SUFFIX}`;
}

export interface AutomationDuplicate {
  sourceName: string;
  initialValues: InitialAutomationFormValues;
  /** The viewer can't create in the source's team, so the copy changed owner. */
  teamReset: boolean;
  /** Repositories or environments the viewer can't use were left out of the copy. */
  targetsDropped: boolean;
}

/**
 * Create-form values for a copy of `source`. The copy keeps the source's team and targets when
 * the viewer can create there; otherwise it moves to `fallbackTeamId` as a team change in the
 * form would. Targets missing from the viewer's pickers would block or fail creation, so they are
 * left out. Per-automation credentials aren't part of an automation: the server issues new
 * webhook keys and the form asks for the Sentry client secret again.
 */
export function createAutomationDuplicate(
  source: Automation,
  {
    teamSelectable,
    fallbackTeamId,
    usableRepositoryKeys,
    usableEnvironmentIds,
  }: {
    teamSelectable: boolean;
    fallbackTeamId: string | null;
    /** Lowercase full names, as `repositoryKey` formats them. */
    usableRepositoryKeys: readonly string[];
    usableEnvironmentIds: readonly string[];
  }
): AutomationDuplicate {
  const values = { ...automationToFormValues(source), name: automationCopyName(source.name) };
  if (!teamSelectable) {
    return {
      sourceName: source.name,
      initialValues: changeAutomationFormOwner(values, fallbackTeamId),
      teamReset: true,
      targetsDropped: false,
    };
  }
  const repositories = source.repositories.filter((repository) =>
    usableRepositoryKeys.includes(repositoryKey(repository.repoOwner, repository.repoName))
  );
  const environmentIds = source.environmentIds.filter((id) => usableEnvironmentIds.includes(id));
  return {
    sourceName: source.name,
    initialValues: { ...values, repositories, environmentIds },
    teamReset: false,
    targetsDropped:
      repositories.length < source.repositories.length ||
      environmentIds.length < source.environmentIds.length,
  };
}

export function requiresRepositoryContext(triggerType: AutomationTriggerType): boolean {
  return triggerType === "github_event" || triggerType === "linear_event";
}

export function requiresEventType(triggerType: AutomationTriggerType): boolean {
  const source = triggerSources.find((candidate) => candidate.triggerType === triggerType);
  return Boolean(source?.supportsEventTypes && source.eventTypes.length > 0);
}

export function transitionAutomationTriggerType(
  trigger: AutomationTriggerDraft,
  nextType: AutomationTriggerType
): AutomationTriggerDraft {
  const nextSource = triggerSources.find((candidate) => candidate.triggerType === nextType);
  const eventTypeStillValid = nextSource?.eventTypes.some(
    (eventType) => eventType.eventType === trigger.eventType
  );
  return {
    ...trigger,
    type: nextType,
    eventType: eventTypeStillValid ? trigger.eventType : "",
    conditions: [],
    includeBotMessages: false,
  };
}

function isValidEventType(triggerType: AutomationTriggerType, eventType: string): boolean {
  const source = triggerSources.find((candidate) => candidate.triggerType === triggerType);
  return Boolean(
    source?.supportsEventTypes &&
    source.eventTypes.some((candidate) => candidate.eventType === eventType)
  );
}

function getConditionRequirementError(
  trigger: AutomationTriggerDraft
): "slack-channel-required" | "slack-bot-allow-list-required" | null {
  if (trigger.type !== "slack_event") return null;
  if (!hasValidSlackChannelCondition(trigger.conditions)) return "slack-channel-required";
  if (trigger.includeBotMessages && !hasSlackActorIncludeList(trigger.conditions)) {
    return "slack-bot-allow-list-required";
  }
  return null;
}

function findInvalidEvaluation({
  mode,
  draft,
  modelAvailability,
  repositoryCount,
  environmentCount,
  originalTrigger,
  scheduleOnceAt,
  originalScheduleOnceAt,
}: {
  mode: AutomationFormMode;
  draft: AutomationFormDraft;
  modelAvailability: HarnessModelAvailability;
  repositoryCount: number;
  environmentCount: number;
  originalTrigger?: AutomationTriggerDraft;
  scheduleOnceAt: number;
  originalScheduleOnceAt?: number;
}): Exclude<AutomationFormEvaluation, { valid: true }> | null {
  if (modelAvailability.status === "loading") return { valid: false, reason: "models-loading" };
  if (modelAvailability.status === "unavailable") {
    return { valid: false, reason: "no-compatible-model" };
  }
  if (!draft.name.trim() || !draft.instructions.trim()) {
    return { valid: false, reason: "required-fields" };
  }
  if (draft.trigger.type === "schedule") {
    const validSchedule =
      draft.trigger.scheduleMode === "once"
        ? Number.isFinite(scheduleOnceAt) &&
          (scheduleOnceAt > Date.now() ||
            (mode === "edit" && scheduleOnceAt === originalScheduleOnceAt))
        : !validateAutomationCron(draft.trigger.scheduleCron) &&
          isValidTimeZone(draft.trigger.scheduleTz);
    if (!validSchedule) return { valid: false, reason: "invalid-schedule" };
  }
  const targetError = validateAutomationTargetCounts(
    draft.trigger.type,
    repositoryCount,
    environmentCount
  );
  if (targetError) {
    return {
      valid: false,
      reason:
        requiresRepositoryContext(draft.trigger.type) && repositoryCount === 0
          ? "repository-required"
          : "invalid-target-selection",
    };
  }
  if (
    requiresEventType(draft.trigger.type) &&
    !isValidEventType(draft.trigger.type, draft.trigger.eventType)
  ) {
    return { valid: false, reason: "event-type-required" };
  }
  const conditionErrors = validateTriggerConditions(
    draft.trigger,
    conditionRegistry,
    mode === "edit" ? originalTrigger : undefined
  );
  if (conditionErrors.length > 0) {
    return { valid: false, reason: "invalid-conditions", conditionErrors };
  }
  const conditionRequirementError = getConditionRequirementError(draft.trigger);
  if (conditionRequirementError) {
    return { valid: false, reason: conditionRequirementError };
  }
  if (
    draft.trigger.type === "sentry" &&
    mode === "create" &&
    !draft.trigger.sentryClientSecret.trim()
  ) {
    return { valid: false, reason: "sentry-secret-required" };
  }
  return null;
}

/**
 * The effort the form shows and submits: the draft's choice when the harness can
 * run it on the model, else "" (use the model default). One rule for display,
 * harness/model changes and submission.
 */
export function effectiveReasoningEffort(
  harness: HarnessId,
  model: string,
  reasoningEffort: string
): string {
  return reasoningEffort && isValidHarnessReasoningEffort(harness, model, reasoningEffort)
    ? reasoningEffort
    : "";
}

function buildSubmissionValues({
  mode,
  draft,
  resolvedModel,
  targets,
  scheduleOnceAt,
}: {
  mode: AutomationFormMode;
  scheduleOnceAt: number;
  draft: AutomationFormDraft;
  resolvedModel: string;
  targets: {
    repositories: AutomationRepositoryInput[];
    environmentIds: string[];
  };
}): AutomationFormValues {
  const values: AutomationFormValues = {
    name: draft.name.trim(),
    repositories: targets.repositories,
    environmentIds: targets.environmentIds,
    harness: draft.agent.harness,
    model: resolvedModel,
    reasoningEffort:
      effectiveReasoningEffort(draft.agent.harness, resolvedModel, draft.agent.reasoningEffort) ||
      null,
    instructions: draft.instructions.trim(),
    triggerType: draft.trigger.type,
    providerSelections: draft.providerSelections,
  };

  if (draft.trigger.type === "schedule") {
    return {
      ...values,
      maxConcurrentRuns: clampConcurrentRuns(draft.trigger.maxConcurrentRuns),
      maxRetries: draft.trigger.maxRetries,
      ...(draft.trigger.scheduleMode === "once"
        ? { scheduleOnceAt }
        : { scheduleCron: draft.trigger.scheduleCron }),
      scheduleTz:
        mode === "create" && draft.trigger.scheduleMode === "once"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : draft.trigger.scheduleTz,
    };
  }

  values.triggerConfig = { conditions: draft.trigger.conditions };
  if (draft.trigger.type === "slack_event" && draft.trigger.includeBotMessages) {
    values.triggerConfig.slack = { includeBotMessages: true };
  }
  if (draft.trigger.eventType) values.eventType = draft.trigger.eventType;
  if (draft.trigger.type === "sentry" && mode === "create") {
    values.sentryClientSecret = draft.trigger.sentryClientSecret.trim();
  }
  return values;
}

export function evaluateAutomationForm({
  mode,
  draft,
  modelAvailability,
  resolvedModel,
  targets,
  originalTrigger,
  originalScheduleOnceAt,
}: {
  mode: AutomationFormMode;
  draft: AutomationFormDraft;
  modelAvailability: HarnessModelAvailability;
  resolvedModel: string;
  originalTrigger?: AutomationTriggerDraft;
  originalScheduleOnceAt?: number;
  targets: {
    repositories: AutomationRepositoryInput[];
    environmentIds: string[];
  };
}): AutomationFormEvaluation {
  const scheduleOnceAt =
    mode === "edit" &&
    originalScheduleOnceAt !== undefined &&
    draft.trigger.scheduleOnceAt === originalTrigger?.scheduleOnceAt
      ? originalScheduleOnceAt
      : new Date(draft.trigger.scheduleOnceAt).getTime();
  const invalidEvaluation = findInvalidEvaluation({
    mode,
    draft,
    modelAvailability,
    repositoryCount: targets.repositories.length,
    environmentCount: targets.environmentIds.length,
    originalTrigger,
    scheduleOnceAt,
    originalScheduleOnceAt,
  });
  if (invalidEvaluation) return invalidEvaluation;

  return {
    valid: true,
    values: buildSubmissionValues({ mode, draft, resolvedModel, targets, scheduleOnceAt }),
  };
}
