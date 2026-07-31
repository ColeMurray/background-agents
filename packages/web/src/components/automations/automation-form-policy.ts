import {
  conditionRegistry,
  hasValidSlackChannelCondition,
  isValidTimeZone,
  triggerSources,
  TRIGGER_TYPE_TO_SOURCE,
  validateAutomationCron,
  validateAutomationTargetCounts,
  validateConditions,
  type AutomationRepositoryInput,
  type AutomationTriggerType,
  type TriggerCondition,
  type TriggerConfig,
} from "@open-inspect/shared";
import { DEFAULT_MODEL, isValidReasoningEffort } from "@open-inspect/shared/models";

export interface AutomationFormValues {
  name: string;
  repositories: AutomationRepositoryInput[];
  environmentIds: string[];
  model: string;
  reasoningEffort: string | null;
  scheduleCron?: string;
  scheduleTz?: string;
  instructions: string;
  triggerType: AutomationTriggerType;
  eventType?: string;
  triggerConfig?: TriggerConfig;
  sentryClientSecret?: string;
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
  model: string;
  reasoningEffort: string;
}

export interface AutomationFormDraft {
  name: string;
  instructions: string;
  trigger: AutomationTriggerDraft;
  agent: AutomationAgentDraft;
}

export type AutomationFormMode = "create" | "edit";

type AutomationFormInvalidReason =
  | "models-loading"
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
      reason: AutomationFormInvalidReason;
    };

type InitialAutomationFormValues = Partial<AutomationFormValues>;

export function createAutomationFormDraft(
  initialValues: InitialAutomationFormValues = {}
): AutomationFormDraft {
  return {
    name: initialValues.name ?? "",
    instructions: initialValues.instructions ?? "",
    trigger: {
      type: initialValues.triggerType ?? "schedule",
      scheduleCron: initialValues.scheduleCron ?? "0 9 * * *",
      scheduleTz: initialValues.scheduleTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      eventType: initialValues.eventType ?? "",
      conditions: initialValues.triggerConfig?.conditions ?? [],
      sentryClientSecret: "",
    },
    agent: {
      model: initialValues.model ?? DEFAULT_MODEL,
      reasoningEffort: initialValues.reasoningEffort ?? "",
    },
  };
}

export function requiresRepositoryContext(triggerType: AutomationTriggerType): boolean {
  return triggerType === "github_event" || triggerType === "linear_event";
}

export function requiresEventType(triggerType: AutomationTriggerType): boolean {
  const source = triggerSources.find((candidate) => candidate.triggerType === triggerType);
  return Boolean(source?.supportsEventTypes && source.eventTypes.length > 0);
}

function isValidEventType(triggerType: AutomationTriggerType, eventType: string): boolean {
  const source = triggerSources.find((candidate) => candidate.triggerType === triggerType);
  return Boolean(
    source?.supportsEventTypes &&
    source.eventTypes.some((candidate) => candidate.eventType === eventType)
  );
}

function getConditionError(
  trigger: AutomationTriggerDraft
): "invalid-conditions" | "slack-channel-required" | null {
  if (trigger.type === "schedule") return null;
  const source = TRIGGER_TYPE_TO_SOURCE[trigger.type];
  if (source && validateConditions(trigger.conditions, source, conditionRegistry).length > 0) {
    return "invalid-conditions";
  }
  if (trigger.type === "slack_event" && !hasValidSlackChannelCondition(trigger.conditions)) {
    return "slack-channel-required";
  }
  return null;
}

function findInvalidReason({
  mode,
  draft,
  loadingModels,
  repositoryCount,
  environmentCount,
}: {
  mode: AutomationFormMode;
  draft: AutomationFormDraft;
  loadingModels: boolean;
  repositoryCount: number;
  environmentCount: number;
}): AutomationFormInvalidReason | null {
  if (loadingModels) return "models-loading";
  if (!draft.name.trim() || !draft.instructions.trim()) return "required-fields";
  if (draft.trigger.type === "schedule") {
    if (
      validateAutomationCron(draft.trigger.scheduleCron) ||
      !isValidTimeZone(draft.trigger.scheduleTz)
    ) {
      return "invalid-schedule";
    }
  }
  const targetError = validateAutomationTargetCounts(
    draft.trigger.type,
    repositoryCount,
    environmentCount
  );
  if (targetError) {
    return requiresRepositoryContext(draft.trigger.type) && repositoryCount === 0
      ? "repository-required"
      : "invalid-target-selection";
  }
  if (
    requiresEventType(draft.trigger.type) &&
    !isValidEventType(draft.trigger.type, draft.trigger.eventType)
  ) {
    return "event-type-required";
  }
  const conditionError = getConditionError(draft.trigger);
  if (conditionError) return conditionError;
  if (
    draft.trigger.type === "sentry" &&
    mode === "create" &&
    !draft.trigger.sentryClientSecret.trim()
  ) {
    return "sentry-secret-required";
  }
  return null;
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
    model: resolvedModel,
    reasoningEffort:
      draft.agent.reasoningEffort &&
      isValidReasoningEffort(resolvedModel, draft.agent.reasoningEffort)
        ? draft.agent.reasoningEffort
        : null,
    instructions: draft.instructions.trim(),
    triggerType: draft.trigger.type,
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
  loadingModels,
  resolvedModel,
  targets,
}: {
  mode: AutomationFormMode;
  draft: AutomationFormDraft;
  loadingModels: boolean;
  resolvedModel: string;
  targets: {
    repositories: AutomationRepositoryInput[];
    environmentIds: string[];
  };
}): AutomationFormEvaluation {
  const invalidReason = findInvalidReason({
    mode,
    draft,
    loadingModels,
    repositoryCount: targets.repositories.length,
    environmentCount: targets.environmentIds.length,
  });
  if (invalidReason) return { valid: false, reason: invalidReason };

  return {
    valid: true,
    values: buildSubmissionValues({ mode, draft, resolvedModel, targets }),
  };
}
