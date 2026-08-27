import { z } from "zod";
import {
  automationRepositoriesInputSchema,
  createAutomationRequestSchema,
  updateAutomationRequestSchema,
} from "@open-inspect/shared/types/automations";
import { triggerConfigSchema } from "@open-inspect/shared/triggers";
import { modelProviderSelectionsSchema } from "@open-inspect/shared/types/provider-accounts";

const automationTriggerTypeSchema = createAutomationRequestSchema.shape.triggerType.unwrap();

const createAutomationMutationSchema = z
  .object({
    name: createAutomationRequestSchema.shape.name,
    instructions: createAutomationRequestSchema.shape.instructions,
    triggerType: automationTriggerTypeSchema.nullable().optional(),
    scheduleCron: createAutomationRequestSchema.shape.scheduleCron.nullable(),
    scheduleTz: createAutomationRequestSchema.shape.scheduleTz.nullable(),
    model: createAutomationRequestSchema.shape.model.nullable(),
    reasoningEffort: createAutomationRequestSchema.shape.reasoningEffort,
    eventType: createAutomationRequestSchema.shape.eventType.nullable(),
    triggerConfig: triggerConfigSchema.optional(),
    sentryClientSecret: createAutomationRequestSchema.shape.sentryClientSecret,
    repositories: automationRepositoriesInputSchema.optional(),
    environmentIds: z.array(z.string()).optional(),
    providerSelections: modelProviderSelectionsSchema.nullable().optional(),
    actorDisplayName: z.string().optional(),
    actorEmail: z.string().optional(),
    actorAvatarUrl: z.string().optional(),
  })
  .transform(({ triggerType, providerSelections, ...input }) => ({
    ...input,
    ...(triggerType ? { triggerType } : {}),
    ...(providerSelections ? { providerSelections } : {}),
  }));

const updateAutomationMutationSchema = z.object({
  name: updateAutomationRequestSchema.shape.name,
  instructions: updateAutomationRequestSchema.shape.instructions,
  scheduleCron: updateAutomationRequestSchema.shape.scheduleCron,
  scheduleTz: updateAutomationRequestSchema.shape.scheduleTz,
  model: updateAutomationRequestSchema.shape.model,
  reasoningEffort: updateAutomationRequestSchema.shape.reasoningEffort,
  eventType: z.string().nullable().optional(),
  triggerConfig: triggerConfigSchema.nullable().optional(),
  repositories: automationRepositoriesInputSchema.optional(),
  environmentIds: z.array(z.string()).optional(),
  providerSelections: modelProviderSelectionsSchema.optional(),
});

export type CreateAutomationMutation = z.output<typeof createAutomationMutationSchema>;
export type UpdateAutomationMutation = z.output<typeof updateAutomationMutationSchema>;

export class AutomationMutationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationMutationInputError";
  }
}

function formatTriggerConfigIssue(value: unknown, issue: z.core.$ZodIssue): string {
  if (issue.path.length === 1 && issue.path[0] === "conditions") {
    return "triggerConfig.conditions must be an array";
  }

  const path = ["triggerConfig", ...issue.path].map(String).join(".");
  const conditionIndex = issue.path[0] === "conditions" ? issue.path[1] : undefined;
  const rawConditions =
    typeof value === "object" && value !== null && "conditions" in value
      ? (value as { conditions?: unknown }).conditions
      : undefined;
  const rawCondition =
    typeof conditionIndex === "number" && Array.isArray(rawConditions)
      ? rawConditions[conditionIndex]
      : undefined;
  const conditionType =
    typeof rawCondition === "object" &&
    rawCondition !== null &&
    "type" in rawCondition &&
    typeof rawCondition.type === "string"
      ? `${rawCondition.type}: `
      : "";
  return `${path}: ${conditionType}${issue.message}`;
}

function formatMutationIssue(
  value: unknown,
  issue: z.core.$ZodIssue,
  operation: "create" | "update"
): string {
  const field = issue.path[0];
  if (field === "name") return operation === "create" ? "name is required" : "name cannot be empty";
  if (field === "instructions") {
    return operation === "create" ? "instructions is required" : "instructions cannot be empty";
  }
  if (field === "triggerType") {
    return `triggerType must be one of: ${automationTriggerTypeSchema.options.join(", ")}`;
  }
  if (field === "triggerConfig") {
    const triggerConfig =
      typeof value === "object" && value !== null && "triggerConfig" in value
        ? (value as { triggerConfig?: unknown }).triggerConfig
        : undefined;
    return formatTriggerConfigIssue(triggerConfig, { ...issue, path: issue.path.slice(1) });
  }
  if (field === "repositories") {
    const index = issue.path[1];
    return `repositories${typeof index === "number" ? `[${index}]` : ""}: ${issue.message}`;
  }
  if (field === "environmentIds") {
    return "environmentIds must be an array of environment ids (env_…)";
  }
  if (field === "providerSelections") {
    return ["providerSelections", ...issue.path.slice(1)].join(".") + `: ${issue.message}`;
  }
  return issue.message;
}

function parseMutation<T>(schema: z.ZodType<T>, value: unknown, operation: "create" | "update"): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new AutomationMutationInputError(
    issue ? formatMutationIssue(value, issue, operation) : "Invalid automation request"
  );
}

export function parseCreateAutomationMutation(value: unknown): CreateAutomationMutation {
  return parseMutation(createAutomationMutationSchema, value, "create");
}

export function parseUpdateAutomationMutation(
  value: unknown,
  currentTriggerType?: string
): UpdateAutomationMutation {
  if (
    currentTriggerType === "schedule" &&
    typeof value === "object" &&
    value !== null &&
    "triggerConfig" in value &&
    value.triggerConfig !== undefined
  ) {
    throw new AutomationMutationInputError("Cannot set triggerConfig on schedule automations");
  }
  return parseMutation(updateAutomationMutationSchema, value, "update");
}
