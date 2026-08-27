import type { AutomationTriggerType, TriggerConfig } from "@open-inspect/shared/triggers";
import type { ModelProviderSelections } from "@open-inspect/shared/types/provider-accounts";
import {
  AutomationStore,
  type AutomationRepositoryInsert,
  type AutomationRow,
} from "./automation-store";
import { AutomationModelProviderAuthStore } from "./automation-model-provider-auth";
import { SlackChannelStore } from "./slack-channel-store";
import type { SqlDatabase, SqlStatement } from "./sql-database";

export interface UpdateAutomationCommand {
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
}

export interface CreateAutomationCommand {
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
}

function extractSlackChannels(triggerConfig: TriggerConfig | null): string[] {
  for (const condition of triggerConfig?.conditions ?? []) {
    if (condition.type === "slack_channel") return condition.value;
  }
  return [];
}

function toAutomationRow(command: CreateAutomationCommand): AutomationRow {
  return {
    id: command.id,
    name: command.name,
    instructions: command.instructions,
    trigger_type: command.triggerType,
    schedule_cron: command.scheduleCron,
    schedule_tz: command.scheduleTz,
    model: command.model,
    reasoning_effort: command.reasoningEffort,
    enabled: 1,
    next_run_at: command.nextRunAt,
    consecutive_failures: 0,
    created_by: command.createdBy,
    user_id: command.userId,
    created_at: command.now,
    updated_at: command.now,
    deleted_at: null,
    event_type: command.eventType,
    trigger_config: command.triggerConfig ? JSON.stringify(command.triggerConfig) : null,
    trigger_auth_data: command.triggerAuthData,
  };
}

function toAutomationUpdate(command: UpdateAutomationCommand): Partial<AutomationRow> {
  return {
    ...(command.name !== undefined ? { name: command.name } : {}),
    ...(command.instructions !== undefined ? { instructions: command.instructions } : {}),
    ...(command.scheduleCron !== undefined ? { schedule_cron: command.scheduleCron } : {}),
    ...(command.scheduleTz !== undefined ? { schedule_tz: command.scheduleTz } : {}),
    ...(command.model !== undefined ? { model: command.model } : {}),
    ...(command.reasoningEffort !== undefined ? { reasoning_effort: command.reasoningEffort } : {}),
    ...(command.nextRunAt !== undefined ? { next_run_at: command.nextRunAt } : {}),
    ...(command.eventType !== undefined ? { event_type: command.eventType } : {}),
    ...(command.triggerConfig !== undefined
      ? {
          trigger_config: command.triggerConfig ? JSON.stringify(command.triggerConfig) : null,
        }
      : {}),
  };
}

export class D1AutomationAggregateWriter {
  private readonly automations: AutomationStore;
  private readonly providerAuth: AutomationModelProviderAuthStore;
  private readonly slackChannels: SlackChannelStore;

  constructor(private readonly db: SqlDatabase) {
    this.automations = new AutomationStore(db);
    this.providerAuth = new AutomationModelProviderAuthStore(db);
    this.slackChannels = new SlackChannelStore(db);
  }

  async create(command: CreateAutomationCommand): Promise<void> {
    const statements = [
      this.automations.bindAutomationInsert(toAutomationRow(command)),
      ...this.automations.bindRepositoryInserts(command.id, command.repositories, command.now),
      ...this.automations.bindEnvironmentInserts(command.id, command.environmentIds, command.now),
      ...this.providerAuth.bindInserts(command.id, command.providerSelections, command.now),
    ];
    if (command.triggerType === "slack_event") {
      statements.push(
        ...this.slackChannels.bindChannelStatements(
          command.id,
          extractSlackChannels(command.triggerConfig)
        )
      );
    }
    await this.db.batch(statements);
  }

  async update(command: UpdateAutomationCommand): Promise<void> {
    const statements: SqlStatement[] = [];
    const updateStatement = this.automations.bindAutomationUpdate(
      command.id,
      toAutomationUpdate(command),
      command.now
    );
    if (updateStatement) statements.push(updateStatement);
    if (command.repositories !== undefined) {
      statements.push(
        ...this.automations.bindReplaceRepositories(command.id, command.repositories, command.now)
      );
    }
    if (command.environmentIds !== undefined) {
      statements.push(
        ...this.automations.bindReplaceEnvironments(command.id, command.environmentIds, command.now)
      );
    }
    if (command.providerSelections !== undefined) {
      statements.push(
        ...this.providerAuth.bindReplace(command.id, command.providerSelections, command.now)
      );
    }
    if (command.triggerType === "slack_event" && command.triggerConfig !== undefined) {
      statements.push(
        ...this.slackChannels.bindChannelStatements(
          command.id,
          extractSlackChannels(command.triggerConfig)
        )
      );
    }
    if (statements.length > 0) await this.db.batch(statements);
  }
}
