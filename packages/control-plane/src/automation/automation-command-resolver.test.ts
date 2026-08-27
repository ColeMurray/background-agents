import { describe, expect, it, vi } from "vitest";
import type { AutomationRow } from "../db/automation-store";
import {
  AutomationCommandResolver,
  AutomationMutationResolutionError,
  type AutomationCommandResolverDependencies,
} from "./automation-command-resolver";

const existing: AutomationRow = {
  id: "auto-1",
  name: "Daily review",
  instructions: "Review changes",
  trigger_type: "schedule",
  schedule_cron: "0 9 * * *",
  schedule_tz: "UTC",
  model: "openai/gpt-5.4",
  reasoning_effort: "high",
  enabled: 1,
  next_run_at: 1,
  consecutive_failures: 0,
  created_by: "user-1",
  user_id: "canonical-1",
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
  event_type: null,
  trigger_config: null,
  trigger_auth_data: null,
};

function dependencies(
  overrides: Partial<AutomationCommandResolverDependencies> = {}
): AutomationCommandResolverDependencies {
  return {
    now: () => 123,
    generateId: () => "auto-new",
    resolveRepository: vi.fn().mockResolvedValue({ repoId: 42, defaultBranch: "main" }),
    environmentExists: vi.fn().mockResolvedValue(true),
    getRepositoryCount: vi.fn().mockResolvedValue(0),
    getEnvironmentCount: vi.fn().mockResolvedValue(0),
    resolveProviderSelections: vi.fn().mockImplementation(async (value) => value),
    resolveCanonicalUserId: vi.fn().mockResolvedValue("canonical-1"),
    generateWebhookApiKey: () => "plain-key",
    hashWebhookApiKey: vi.fn().mockResolvedValue("hashed-key"),
    encryptSentrySecret: vi.fn().mockResolvedValue("encrypted-secret"),
    hasSentryEncryptionKey: true,
    ...overrides,
  };
}

describe("AutomationCommandResolver", () => {
  it("returns a complete schedule update command", async () => {
    const command = await new AutomationCommandResolver(dependencies()).resolveUpdate(
      { scheduleCron: "0 12 * * *", scheduleTz: "America/New_York" },
      existing
    );

    expect(command).toMatchObject({
      id: "auto-1",
      triggerType: "schedule",
      scheduleCron: "0 12 * * *",
      scheduleTz: "America/New_York",
      nextRunAt: expect.any(Number),
      now: 123,
    });
  });

  it("validates a one-sided target replacement against final aggregate state", async () => {
    const deps = dependencies({ getRepositoryCount: vi.fn().mockResolvedValue(1) });

    await expect(
      new AutomationCommandResolver(deps).resolveUpdate(
        { environmentIds: ["env_1"] },
        { ...existing, trigger_type: "webhook" }
      )
    ).rejects.toEqual(
      new AutomationMutationResolutionError(
        "Multi-target selections require a schedule trigger",
        400
      )
    );
  });

  it("rejects clearing required Slack trigger scoping", async () => {
    await expect(
      new AutomationCommandResolver(dependencies()).resolveUpdate(
        { triggerConfig: null },
        { ...existing, trigger_type: "slack_event" }
      )
    ).rejects.toEqual(
      new AutomationMutationResolutionError(
        "Cannot clear triggerConfig on slack_event automations; pause or delete instead",
        400
      )
    );
  });

  it("resolves a complete webhook create command and one-time response secret", async () => {
    const result = await new AutomationCommandResolver(dependencies()).resolveCreate(
      {
        name: "Webhook review",
        instructions: "Review changes",
        triggerType: "webhook",
      },
      { createdBy: "user-1" }
    );

    expect(result).toEqual({
      command: expect.objectContaining({
        id: "auto-new",
        triggerType: "webhook",
        triggerAuthData: "hashed-key",
        userId: "canonical-1",
        now: 123,
      }),
      webhookApiKey: "plain-key",
    });
  });
});
