import { cronIntervalMinutes, isValidCron, nextCronOccurrence } from "@open-inspect/shared/cron";
import {
  conditionRegistry,
  TRIGGER_TYPE_TO_SOURCE,
  validateConditions,
  type AutomationTriggerType,
  type TriggerConfig,
} from "@open-inspect/shared/triggers";
import {
  MAX_AUTOMATION_REPOSITORIES,
  type AutomationRepositoryInput,
} from "@open-inspect/shared/types/automations";
import { isEnvironmentId } from "@open-inspect/shared/types/environments";
import {
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
} from "@open-inspect/shared/models";
import type { ModelProviderSelections } from "@open-inspect/shared/types/provider-accounts";
import type { AutomationRepositoryInsert, AutomationRow } from "../db/automation-store";
import type { CreateAutomationMutation, UpdateAutomationMutation } from "./automation-mutation";

const MIN_CRON_INTERVAL_MINUTES = 15;
const MAX_NAME_LENGTH = 200;
const MAX_INSTRUCTIONS_LENGTH = 15_000;

declare const resolvedAutomationCommand: unique symbol;
type ResolvedAutomationCommand = { readonly [resolvedAutomationCommand]: true };

export type UpdateAutomationCommand = Readonly<{
  id: string;
  triggerType: AutomationTriggerType;
  name?: string;
  instructions?: string;
  scheduleCron?: string;
  scheduleTz?: string;
  model?: string;
  reasoningEffort?: string | null;
  nextRunAt?: number | null;
  eventType?: string | null;
  triggerConfig?: TriggerConfig | null;
  repositories?: AutomationRepositoryInsert[];
  environmentIds?: string[];
  providerSelections?: ModelProviderSelections;
  now: number;
}> &
  ResolvedAutomationCommand;

export type CreateAutomationCommand = Readonly<{
  id: string;
  name: string;
  instructions: string;
  triggerType: AutomationTriggerType;
  scheduleCron: string | null;
  scheduleTz: string;
  model: string;
  reasoningEffort: string | null;
  nextRunAt: number | null;
  createdBy: string;
  userId: string;
  eventType: string | null;
  triggerConfig: TriggerConfig | null;
  triggerAuthData: string | null;
  repositories: AutomationRepositoryInsert[];
  environmentIds: string[];
  providerSelections: ModelProviderSelections;
  now: number;
}> &
  ResolvedAutomationCommand;

export interface AutomationCommandResolverDependencies {
  now(): number;
  generateId(): string;
  resolveRepository(repository: AutomationRepositoryInput): Promise<{
    repoId: number;
    defaultBranch: string;
  }>;
  environmentExists(id: string): Promise<boolean>;
  getRepositoryCount(automationId: string): Promise<number>;
  getEnvironmentCount(automationId: string): Promise<number>;
  resolveProviderSelections(value: unknown): Promise<ModelProviderSelections>;
  resolveCanonicalUserId(metadata: {
    displayName?: string;
    email?: string;
    avatarUrl?: string;
  }): Promise<string>;
  generateWebhookApiKey(): string;
  hashWebhookApiKey(apiKey: string): Promise<string>;
  encryptSentrySecret(secret: string): Promise<string>;
  hasSentryEncryptionKey: boolean;
}

export class AutomationMutationResolutionError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
    this.name = "AutomationMutationResolutionError";
  }
}

function fail(message: string, status = 400): never {
  throw new AutomationMutationResolutionError(message, status);
}

function resolveReasoningEffort(
  model: string,
  reasoningEffort: string | null | undefined
): string | null {
  if (reasoningEffort === undefined || reasoningEffort === null) return null;
  return isValidReasoningEffort(model, reasoningEffort) ? reasoningEffort : null;
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validateTargetCounts(
  triggerType: AutomationTriggerType,
  repositoryCount: number,
  environmentCount: number
): void {
  if (triggerType === "github_event" || triggerType === "linear_event") {
    if (repositoryCount === 0) fail("Repository-scoped triggers require exactly one repository");
    if (environmentCount > 0) fail("Repository-scoped triggers cannot target environments");
  }
  if (repositoryCount + environmentCount > 1 && triggerType !== "schedule") {
    fail("Multi-target selections require a schedule trigger");
  }
  if (repositoryCount + environmentCount > MAX_AUTOMATION_REPOSITORIES) {
    fail(`At most ${MAX_AUTOMATION_REPOSITORIES} repositories and environments combined`);
  }
}

function validateSlackTriggerConfig(triggerConfig: TriggerConfig | null | undefined): void {
  if (!(triggerConfig?.conditions ?? []).some((condition) => condition.type === "slack_channel")) {
    fail("slack_event triggers require a slack_channel condition");
  }
}

function validateConditionsForTrigger(
  triggerType: AutomationTriggerType,
  triggerConfig: TriggerConfig | null | undefined
): void {
  if (!triggerConfig?.conditions) return;
  const source = TRIGGER_TYPE_TO_SOURCE[triggerType];
  if (!source) return;
  const errors = validateConditions(triggerConfig.conditions, source, conditionRegistry);
  if (errors.length > 0) fail(errors.join("; "));
}

function validateEnvironmentIds(environmentIds: string[]): void {
  if (environmentIds.some((id) => !isEnvironmentId(id))) {
    fail("environmentIds must be an array of environment ids (env_…)");
  }
  if (new Set(environmentIds).size !== environmentIds.length) {
    fail("environmentIds must not contain duplicates");
  }
}

function validateCron(cron: string): void {
  if (!isValidCron(cron)) fail("scheduleCron must be a valid 5-field cron expression");
  const interval = cronIntervalMinutes(cron);
  if (interval !== null && interval < MIN_CRON_INTERVAL_MINUTES) {
    fail(`Schedule interval must be at least ${MIN_CRON_INTERVAL_MINUTES} minutes`);
  }
}

export class AutomationCommandResolver {
  constructor(private readonly dependencies: AutomationCommandResolverDependencies) {}

  async resolveCreate(
    input: CreateAutomationMutation,
    identity: { createdBy: string }
  ): Promise<{ command: CreateAutomationCommand; webhookApiKey?: string }> {
    if (input.name.trim().length === 0) fail("name is required");
    if (input.name.length > MAX_NAME_LENGTH) {
      fail(`name must be at most ${MAX_NAME_LENGTH} characters`);
    }
    if (input.instructions.trim().length === 0) fail("instructions is required");
    if (input.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      fail(`instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters`);
    }

    const triggerType = input.triggerType ?? "schedule";
    const repositories = input.repositories ?? [];
    const environmentIds = input.environmentIds ?? [];
    validateEnvironmentIds(environmentIds);
    validateTargetCounts(triggerType, repositories.length, environmentIds.length);
    await this.resolveEnvironments(environmentIds);

    const isSchedule = triggerType === "schedule";
    if (isSchedule) {
      if (!input.scheduleCron) fail("scheduleCron must be a valid 5-field cron expression");
      validateCron(input.scheduleCron);
      if (!input.scheduleTz || !isValidTimezone(input.scheduleTz)) {
        fail("scheduleTz must be a valid IANA timezone");
      }
    } else if (input.scheduleCron || input.scheduleTz) {
      fail("scheduleCron and scheduleTz are only valid for schedule triggers");
    }

    if (triggerType === "sentry" && !input.eventType) {
      fail("eventType is required for sentry triggers");
    }
    validateConditionsForTrigger(triggerType, input.triggerConfig);
    if (triggerType === "slack_event") validateSlackTriggerConfig(input.triggerConfig);

    const model = getValidModelOrDefault(input.model ?? undefined);
    const reasoningEffort = resolveReasoningEffort(model, input.reasoningEffort);
    if (input.reasoningEffort !== undefined && input.reasoningEffort !== null && !reasoningEffort) {
      fail("Invalid reasoning effort for selected model");
    }

    const resolvedRepositories = await this.resolveRepositories(repositories);
    const providerSelections = await this.dependencies.resolveProviderSelections(
      input.providerSelections ?? {}
    );
    const nextRunAt = isSchedule
      ? nextCronOccurrence(input.scheduleCron!, input.scheduleTz!).getTime()
      : null;
    const id = this.dependencies.generateId();
    const now = this.dependencies.now();

    let webhookApiKey: string | undefined;
    let triggerAuthData: string | null = null;
    if (triggerType === "webhook") {
      webhookApiKey = this.dependencies.generateWebhookApiKey();
      triggerAuthData = await this.dependencies.hashWebhookApiKey(webhookApiKey);
    } else if (triggerType === "sentry") {
      if (!input.sentryClientSecret?.trim()) {
        fail("sentryClientSecret is required for sentry triggers");
      }
      if (!this.dependencies.hasSentryEncryptionKey) fail("Encryption key not configured", 503);
      triggerAuthData = await this.dependencies.encryptSentrySecret(input.sentryClientSecret);
    }

    const userId = await this.dependencies.resolveCanonicalUserId({
      displayName: input.actorDisplayName,
      email: input.actorEmail,
      avatarUrl: input.actorAvatarUrl,
    });
    return {
      command: {
        id,
        name: input.name.trim(),
        instructions: input.instructions,
        triggerType,
        scheduleCron: input.scheduleCron ?? null,
        scheduleTz: input.scheduleTz ?? "UTC",
        model,
        reasoningEffort,
        nextRunAt,
        createdBy: identity.createdBy,
        userId,
        eventType: input.eventType ?? null,
        triggerConfig: input.triggerConfig ?? null,
        triggerAuthData,
        repositories: resolvedRepositories,
        environmentIds,
        providerSelections,
        now,
      } as CreateAutomationCommand,
      ...(webhookApiKey ? { webhookApiKey } : {}),
    };
  }

  async resolveUpdate(
    input: UpdateAutomationMutation,
    existing: AutomationRow
  ): Promise<UpdateAutomationCommand> {
    const providerSelections =
      input.providerSelections !== undefined
        ? await this.dependencies.resolveProviderSelections(input.providerSelections)
        : undefined;

    if (input.name !== undefined) {
      if (input.name.trim().length === 0) fail("name cannot be empty");
      if (input.name.length > MAX_NAME_LENGTH) {
        fail(`name must be at most ${MAX_NAME_LENGTH} characters`);
      }
    }
    if (input.instructions !== undefined) {
      if (input.instructions.trim().length === 0) fail("instructions cannot be empty");
      if (input.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
        fail(`instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters`);
      }
    }
    if (input.scheduleCron !== undefined) validateCron(input.scheduleCron);
    if (input.scheduleTz !== undefined && !isValidTimezone(input.scheduleTz)) {
      fail("scheduleTz must be a valid IANA timezone");
    }
    if (input.model !== undefined && !isValidModel(input.model)) fail("Invalid model");

    const nextModel =
      input.model !== undefined ? getValidModelOrDefault(input.model) : existing.model;
    const requestedReasoningEffort = input.reasoningEffort;
    const reasoningEffort =
      requestedReasoningEffort !== undefined
        ? resolveReasoningEffort(nextModel, requestedReasoningEffort)
        : input.model !== undefined && existing.reasoning_effort !== null
          ? resolveReasoningEffort(nextModel, existing.reasoning_effort)
          : existing.reasoning_effort;
    if (
      requestedReasoningEffort !== undefined &&
      requestedReasoningEffort !== null &&
      reasoningEffort === null
    ) {
      fail("Invalid reasoning effort for selected model");
    }

    const triggerType = existing.trigger_type as AutomationTriggerType;
    let repositories: AutomationRepositoryInsert[] | undefined;
    let environmentIds: string[] | undefined;
    if (input.environmentIds !== undefined) {
      validateEnvironmentIds(input.environmentIds);
      environmentIds = input.environmentIds;
    }
    if (input.repositories !== undefined || environmentIds !== undefined) {
      const repositoryCount =
        input.repositories?.length ?? (await this.dependencies.getRepositoryCount(existing.id));
      const environmentCount =
        environmentIds?.length ?? (await this.dependencies.getEnvironmentCount(existing.id));
      validateTargetCounts(triggerType, repositoryCount, environmentCount);
      if (environmentIds !== undefined) await this.resolveEnvironments(environmentIds);
      if (input.repositories !== undefined) {
        repositories = await this.resolveRepositories(input.repositories);
      }
    }

    if (input.eventType !== undefined && triggerType === "schedule") {
      fail("Cannot set eventType on schedule automations");
    }
    if (input.triggerConfig !== undefined) {
      if (triggerType === "schedule") {
        fail("Cannot set triggerConfig on schedule automations");
      }
      if (input.triggerConfig === null) {
        if (triggerType === "slack_event") {
          fail("Cannot clear triggerConfig on slack_event automations; pause or delete instead");
        }
      } else {
        if (triggerType === "slack_event") validateSlackTriggerConfig(input.triggerConfig);
        validateConditionsForTrigger(triggerType, input.triggerConfig);
      }
    }

    let nextRunAt: number | undefined;
    if (
      triggerType === "schedule" &&
      (input.scheduleCron !== undefined || input.scheduleTz !== undefined)
    ) {
      const cron = input.scheduleCron ?? existing.schedule_cron;
      const timezone = input.scheduleTz ?? existing.schedule_tz;
      if (!cron) fail("Cannot compute schedule: no cron expression");
      nextRunAt = nextCronOccurrence(cron, timezone).getTime();
    }

    return {
      id: existing.id,
      triggerType,
      now: this.dependencies.now(),
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.scheduleCron !== undefined ? { scheduleCron: input.scheduleCron } : {}),
      ...(input.scheduleTz !== undefined ? { scheduleTz: input.scheduleTz } : {}),
      ...(input.model !== undefined ? { model: nextModel } : {}),
      ...(input.reasoningEffort !== undefined || input.model !== undefined
        ? { reasoningEffort }
        : {}),
      ...(input.eventType !== undefined ? { eventType: input.eventType } : {}),
      ...(input.triggerConfig !== undefined ? { triggerConfig: input.triggerConfig } : {}),
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      ...(repositories !== undefined ? { repositories } : {}),
      ...(environmentIds !== undefined ? { environmentIds } : {}),
      ...(providerSelections !== undefined ? { providerSelections } : {}),
    } as UpdateAutomationCommand;
  }

  private async resolveEnvironments(environmentIds: string[]): Promise<void> {
    const found = await Promise.all(
      environmentIds.map((id) => this.dependencies.environmentExists(id))
    );
    const missing = environmentIds.filter((_, index) => !found[index]);
    if (missing.length > 0) fail(`Environment not found: ${missing.join(", ")}`);
  }

  private async resolveRepositories(
    repositories: AutomationRepositoryInput[]
  ): Promise<AutomationRepositoryInsert[]> {
    const settled = await Promise.allSettled(
      repositories.map((repository) => this.dependencies.resolveRepository(repository))
    );
    const resolved = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    return repositories.map((repository, index) => ({
      repo_owner: repository.repoOwner,
      repo_name: repository.repoName,
      repo_id: resolved[index].repoId,
      base_branch: repository.baseBranch ?? resolved[index].defaultBranch,
    }));
  }
}
