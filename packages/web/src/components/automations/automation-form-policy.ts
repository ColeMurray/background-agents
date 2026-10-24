import { isValidTimeZone, validateAutomationCron } from "@open-inspect/shared/cron";
import {
  conditionRegistry,
  hasValidSlackChannelCondition,
  triggerSources,
  validateTriggerConditions,
  type AutomationTriggerType,
  type TriggerCondition,
  type TriggerConfig,
} from "@open-inspect/shared/triggers";
import {
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
  scheduleTz?: string;
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
  scheduleTz: string;
  eventType: string;
  conditions: TriggerCondition[];
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
      scheduleTz: initialValues.scheduleTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      eventType: initialValues.eventType ?? "",
      conditions: initialValues.triggerConfig?.conditions ?? [],
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
    instructions: automation.instructions,
    triggerType: automation.triggerType,
    eventType: automation.eventType ?? undefined,
    triggerConfig: automation.triggerConfig ?? undefined,
    providerSelections: automation.providerSelections,
  };
}

const COPY_NAME_SUFFIX = " (copy)";

/** The source name plus a copy suffix, trimmed to fit MAX_AUTOMATION_NAME_LENGTH. */
export function automationCopyName(name: string): string {
  const base = name
    .slice(0, MAX_AUTOMATION_NAME_LENGTH - COPY_NAME_SUFFIX.length)
    // The cut counts UTF-16 units, so it can split a surrogate pair; drop the lone half.
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd();
  return `${base}${COPY_NAME_SUFFIX}`;
}

export interface AutomationDuplicate {
  sourceName: string;
  initialValues: InitialAutomationFormValues;
  /** The viewer can't create in the source's team, so the copy starts elsewhere without targets. */
  teamReset: boolean;
  /** Environments the viewer can't use were left out of the copy. */
  environmentsDropped: boolean;
}

/**
 * Create-form values for a copy of `source`. The copy keeps the source's team and targets when
 * the viewer can create there; otherwise it starts in `fallbackTeamId` with no targets, as a team
 * change in the form would. Create mode only submits usable environments, so unusable ones are
 * left out. Per-automation credentials aren't part of an automation: the server issues new
 * webhook keys and the form asks for the Sentry client secret again.
 */
export function createAutomationDuplicate(
  source: Automation,
  {
    teamSelectable,
    fallbackTeamId,
    usableEnvironmentIds,
  }: {
    teamSelectable: boolean;
    fallbackTeamId: string | null;
    usableEnvironmentIds: readonly string[];
  }
): AutomationDuplicate {
  const values = { ...automationToFormValues(source), name: automationCopyName(source.name) };
  if (!teamSelectable) {
    return {
      sourceName: source.name,
      initialValues: { ...values, teamId: fallbackTeamId, repositories: [], environmentIds: [] },
      teamReset: true,
      environmentsDropped: false,
    };
  }
  const environmentIds = source.environmentIds.filter((id) => usableEnvironmentIds.includes(id));
  return {
    sourceName: source.name,
    initialValues: { ...values, environmentIds },
    teamReset: false,
    environmentsDropped: environmentIds.length < source.environmentIds.length,
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
): "slack-channel-required" | null {
  if (trigger.type === "slack_event" && !hasValidSlackChannelCondition(trigger.conditions)) {
    return "slack-channel-required";
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
}: {
  mode: AutomationFormMode;
  draft: AutomationFormDraft;
  modelAvailability: HarnessModelAvailability;
  repositoryCount: number;
  environmentCount: number;
  originalTrigger?: AutomationTriggerDraft;
}): Exclude<AutomationFormEvaluation, { valid: true }> | null {
  if (modelAvailability.status === "loading") return { valid: false, reason: "models-loading" };
  if (modelAvailability.status === "unavailable") {
    return { valid: false, reason: "no-compatible-model" };
  }
  if (!draft.name.trim() || !draft.instructions.trim()) {
    return { valid: false, reason: "required-fields" };
  }
  if (draft.trigger.type === "schedule") {
    if (
      validateAutomationCron(draft.trigger.scheduleCron) ||
      !isValidTimeZone(draft.trigger.scheduleTz)
    ) {
      return { valid: false, reason: "invalid-schedule" };
    }
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
}: {
  mode: AutomationFormMode;
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
      scheduleCron: draft.trigger.scheduleCron,
      scheduleTz: draft.trigger.scheduleTz,
    };
  }

  values.triggerConfig = { conditions: draft.trigger.conditions };
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
}: {
  mode: AutomationFormMode;
  draft: AutomationFormDraft;
  modelAvailability: HarnessModelAvailability;
  resolvedModel: string;
  originalTrigger?: AutomationTriggerDraft;
  targets: {
    repositories: AutomationRepositoryInput[];
    environmentIds: string[];
  };
}): AutomationFormEvaluation {
  const invalidEvaluation = findInvalidEvaluation({
    mode,
    draft,
    modelAvailability,
    repositoryCount: targets.repositories.length,
    environmentCount: targets.environmentIds.length,
    originalTrigger,
  });
  if (invalidEvaluation) return invalidEvaluation;

  return {
    valid: true,
    values: buildSubmissionValues({ mode, draft, resolvedModel, targets }),
  };
}
