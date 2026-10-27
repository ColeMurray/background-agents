import { afterEach, describe, expect, it, vi } from "vitest";
import type { Automation } from "@open-inspect/shared/types/automations";
import {
  createAutomationDuplicate,
  createAutomationFormDraft,
  evaluateAutomationForm,
} from "./automation-form-policy";

afterEach(() => vi.unstubAllEnvs());

describe("one-shot form policy", () => {
  it("preserves the configured timezone when editing from a different browser timezone", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const originalScheduleOnceAt = Date.parse("2099-01-01T09:00:00Z");
    const draft = createAutomationFormDraft({
      name: "Review",
      instructions: "Review code",
      scheduleOnceAt: originalScheduleOnceAt,
      scheduleTz: "UTC",
    });
    const result = evaluateAutomationForm({
      mode: "edit",
      draft,
      originalTrigger: draft.trigger,
      originalScheduleOnceAt,
      modelAvailability: { status: "available" },
      resolvedModel: draft.agent.model,
      targets: { repositories: [], environmentIds: [] },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.values.scheduleOnceAt).toBe(originalScheduleOnceAt);
      expect(result.values.scheduleTz).toBe("UTC");
    }
  });

  it("preserves the original absolute instant across a daylight-saving overlap", () => {
    vi.stubEnv("TZ", "America/New_York");
    const originalScheduleOnceAt = Date.parse("2020-11-01T06:30:42.123Z");
    const draft = createAutomationFormDraft({
      name: "Review",
      instructions: "Review code",
      scheduleOnceAt: originalScheduleOnceAt,
    });
    expect(draft.trigger.scheduleOnceAt).toBe("2020-11-01T01:30");
    const result = evaluateAutomationForm({
      mode: "edit",
      draft,
      originalTrigger: draft.trigger,
      originalScheduleOnceAt,
      modelAvailability: { status: "available" },
      resolvedModel: draft.agent.model,
      targets: { repositories: [], environmentIds: [] },
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.scheduleOnceAt).toBe(originalScheduleOnceAt);
  });
});

describe("duplicate form policy", () => {
  it("does not carry the source executor's personal-memory opt-in into a copy", () => {
    const source: Automation = {
      id: "auto-1",
      name: "Review",
      instructions: "Review code",
      triggerType: "schedule",
      scheduleCron: "0 9 * * *",
      scheduleOnceAt: null,
      scheduleTz: "UTC",
      harness: "opencode",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      enabled: true,
      nextRunAt: null,
      consecutiveFailures: 0,
      maxRetries: 0,
      includePersonalMemories: true,
      createdBy: "11111111111111111111111111111111",
      userId: "11111111111111111111111111111111",
      ownerTeamId: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      eventType: null,
      triggerConfig: null,
      repositories: [],
      environmentIds: [],
      providerSelections: {},
    };
    const duplicate = createAutomationDuplicate(source, {
      teamSelectable: true,
      fallbackTeamId: null,
      usableRepositoryKeys: [],
      usableEnvironmentIds: [],
    });
    expect(duplicate.initialValues.includePersonalMemories).toBe(false);
  });
});
