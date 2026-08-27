import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import {
  D1AutomationAggregateWriter,
  type CreateAutomationCommand,
} from "./automation-aggregate-writer";

const mocks = vi.hoisted(() => ({
  automation: {
    bindAutomationInsert: vi.fn(),
    bindAutomationUpdate: vi.fn(),
    bindRepositoryInserts: vi.fn(),
    bindEnvironmentInserts: vi.fn(),
    bindReplaceRepositories: vi.fn(),
    bindReplaceEnvironments: vi.fn(),
  },
  providerAuth: {
    bindInserts: vi.fn(),
    bindReplace: vi.fn(),
  },
  slack: {
    bindChannelStatements: vi.fn(),
  },
}));

vi.mock("./automation-store", () => ({
  AutomationStore: vi.fn().mockImplementation(function () {
    return mocks.automation;
  }),
}));

vi.mock("./automation-model-provider-auth", () => ({
  AutomationModelProviderAuthStore: vi.fn().mockImplementation(function () {
    return mocks.providerAuth;
  }),
}));

vi.mock("./slack-channel-store", () => ({
  SlackChannelStore: vi.fn().mockImplementation(function () {
    return mocks.slack;
  }),
}));

function statement(name: string): SqlStatement {
  return { name } as unknown as SqlStatement;
}

const createCommand: CreateAutomationCommand = {
  id: "auto-1",
  name: "Daily review",
  instructions: "Review open changes",
  triggerType: "slack_event",
  scheduleCron: null,
  scheduleTz: "UTC",
  model: "openai/gpt-5.2-codex",
  reasoningEffort: "high",
  nextRunAt: null,
  createdBy: "user-1",
  userId: "canonical-user-1",
  eventType: null,
  triggerConfig: {
    conditions: [{ type: "slack_channel", operator: "any_of", value: ["C123"] }],
  },
  triggerAuthData: null,
  repositories: [{ repo_owner: "acme", repo_name: "api", repo_id: 42, base_branch: "main" }],
  environmentIds: ["env_1"],
  providerSelections: { openai: { mode: "api_key" } },
  now: 123,
};

describe("D1AutomationAggregateWriter", () => {
  const batch = vi.fn();
  const db = { batch } as unknown as SqlDatabase;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.automation.bindAutomationInsert.mockReturnValue(statement("automation-insert"));
    mocks.automation.bindAutomationUpdate.mockReturnValue(statement("automation-update"));
    mocks.automation.bindRepositoryInserts.mockReturnValue([statement("repository-insert")]);
    mocks.automation.bindEnvironmentInserts.mockReturnValue([statement("environment-insert")]);
    mocks.automation.bindReplaceRepositories.mockReturnValue([statement("repository-replace")]);
    mocks.automation.bindReplaceEnvironments.mockReturnValue([statement("environment-replace")]);
    mocks.providerAuth.bindInserts.mockReturnValue([statement("provider-insert")]);
    mocks.providerAuth.bindReplace.mockReturnValue([statement("provider-replace")]);
    mocks.slack.bindChannelStatements.mockReturnValue([statement("slack-replace")]);
    batch.mockResolvedValue([]);
  });

  it("creates the complete aggregate in one ordered atomic batch", async () => {
    await new D1AutomationAggregateWriter(db).create(createCommand);

    expect(mocks.automation.bindAutomationInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "auto-1",
        trigger_type: "slack_event",
        trigger_config: JSON.stringify(createCommand.triggerConfig),
        created_at: 123,
        updated_at: 123,
      })
    );
    expect(mocks.automation.bindRepositoryInserts).toHaveBeenCalledWith(
      "auto-1",
      createCommand.repositories,
      123
    );
    expect(mocks.automation.bindEnvironmentInserts).toHaveBeenCalledWith("auto-1", ["env_1"], 123);
    expect(mocks.providerAuth.bindInserts).toHaveBeenCalledWith(
      "auto-1",
      createCommand.providerSelections,
      123
    );
    expect(mocks.slack.bindChannelStatements).toHaveBeenCalledWith("auto-1", ["C123"]);
    expect(batch).toHaveBeenCalledWith([
      expect.objectContaining({ name: "automation-insert" }),
      expect.objectContaining({ name: "repository-insert" }),
      expect.objectContaining({ name: "environment-insert" }),
      expect.objectContaining({ name: "provider-insert" }),
      expect.objectContaining({ name: "slack-replace" }),
    ]);
  });

  it("replaces only explicitly supplied update selections and Slack indexes", async () => {
    await new D1AutomationAggregateWriter(db).update({
      id: "auto-1",
      triggerType: "slack_event",
      name: "Renamed",
      triggerConfig: {
        conditions: [{ type: "slack_channel", operator: "any_of", value: ["C999"] }],
      },
      repositories: [],
      providerSelections: {},
      now: 456,
    });

    expect(mocks.automation.bindAutomationUpdate).toHaveBeenCalledWith(
      "auto-1",
      {
        name: "Renamed",
        trigger_config: JSON.stringify({
          conditions: [{ type: "slack_channel", operator: "any_of", value: ["C999"] }],
        }),
      },
      456
    );
    expect(mocks.automation.bindReplaceRepositories).toHaveBeenCalledWith("auto-1", [], 456);
    expect(mocks.automation.bindReplaceEnvironments).not.toHaveBeenCalled();
    expect(mocks.providerAuth.bindReplace).toHaveBeenCalledWith("auto-1", {}, 456);
    expect(mocks.slack.bindChannelStatements).toHaveBeenCalledWith("auto-1", ["C999"]);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("does not write an update when every field is omitted", async () => {
    mocks.automation.bindAutomationUpdate.mockReturnValue(null);

    await new D1AutomationAggregateWriter(db).update({
      id: "auto-1",
      triggerType: "schedule",
      now: 456,
    });

    expect(mocks.automation.bindReplaceRepositories).not.toHaveBeenCalled();
    expect(mocks.automation.bindReplaceEnvironments).not.toHaveBeenCalled();
    expect(mocks.providerAuth.bindReplace).not.toHaveBeenCalled();
    expect(mocks.slack.bindChannelStatements).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it("distinguishes an omitted trigger config from an explicit clear", async () => {
    await new D1AutomationAggregateWriter(db).update({
      id: "auto-1",
      triggerType: "webhook",
      triggerConfig: null,
      now: 456,
    });

    expect(mocks.automation.bindAutomationUpdate).toHaveBeenCalledWith(
      "auto-1",
      { trigger_config: null },
      456
    );
    expect(mocks.slack.bindChannelStatements).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(1);
  });
});
