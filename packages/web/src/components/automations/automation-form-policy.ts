import { isValidTimeZone, validateAutomationCron } from "@open-inspect/shared/cron";
import {
  conditionRegistry,
  hasValidSlackChannelCondition,
  isGitHubConditionSupported,
  triggerSources,
  TRIGGER_TYPE_TO_SOURCE,
  validateConditions,
  type AutomationTriggerType,
  type TriggerCondition,
  type TriggerConfig,
} from "@open-inspect/shared/triggers";
import {
  validateAutomationTargetCounts,
  type AutomationRepositoryInput,
} from "@open-inspect/shared/types/automations";
import { DEFAULT_MODEL, isValidReasoningEffort } from "@open-inspect/shared/models";
import type { ModelProviderSelections } from "@open-inspect/shared/types/provider-accounts";

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
  return {
    name: initialValues.name ?? "",
    instructions: initialValues.instructions ?? "",
    providerSelections: initialValues.providerSelections ?? {},
    trigger: {
      type: initialValues.triggerType ?? "schedule",
      scheduleCron: initialValues.scheduleCron ?? DEFAULT_AUTOMATION_SCHEDULE_CRON,
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

function getConditionErrors(
  trigger: AutomationTriggerDraft,
  originalTrigger?: AutomationTriggerDraft
): string[] {
  if (trigger.type === "schedule") return [];
  const source = TRIGGER_TYPE_TO_SOURCE[trigger.type];
  if (!source) return [];
  const unchangedGitHubEvent =
    trigger.type === "github_event" &&
    originalTrigger?.type === trigger.type &&
    originalTrigger.eventType === trigger.eventType;
  const remainingOriginalConditions = unchangedGitHubEvent
    ? originalTrigger.conditions.map((condition) => JSON.stringify(condition))
    : [];
  return trigger.conditions.flatMap((condition) => {
    // The API permits unchanged legacy filters on unrelated edits, but never
    // grants that exception to a new filter or a different event type.
    if (unchangedGitHubEvent && !isGitHubConditionSupported(trigger.eventType, condition.type)) {
      const index = remainingOriginalConditions.indexOf(JSON.stringify(condition));
      if (index !== -1) {
        remainingOriginalConditions.splice(index, 1);
        return [];
      }
    }
    return validateConditions([condition], source, conditionRegistry, trigger.eventType);
  });
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
  loadingModels,
  repositoryCount,
  environmentCount,
  originalTrigger,
}: {
  mode: AutomationFormMode;
  draft: AutomationFormDraft;
  loadingModels: boolean;
  repositoryCount: number;
  environmentCount: number;
  originalTrigger?: AutomationTriggerDraft;
}): Exclude<AutomationFormEvaluation, { valid: true }> | null {
  if (loadingModels) return { valid: false, reason: "models-loading" };
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
  const conditionErrors = getConditionErrors(
    draft.trigger,
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
  loadingModels,
  resolvedModel,
  targets,
  originalTrigger,
}: {
  mode: AutomationFormMode;
  draft: AutomationFormDraft;
  loadingModels: boolean;
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
    loadingModels,
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
