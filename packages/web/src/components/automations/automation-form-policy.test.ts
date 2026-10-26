import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import {
  DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
  MAX_AUTOMATION_CONCURRENT_RUNS,
} from "@open-inspect/shared/types/automations";
import { createAutomationFormDraft, evaluateAutomationForm } from "./automation-form-policy";

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

describe("automation form policy", () => {
  it("carries an explicit concurrency through, and clamps an out-of-range one", () => {
    const build = (maxConcurrentRuns: number | undefined) =>
      evaluateAutomationForm({
        mode: "create",
        draft: createAutomationFormDraft({
          name: "Queue drain",
          instructions: "Drain the queue",
          maxConcurrentRuns,
        }),
        modelAvailability: { status: "available" as const },
        resolvedModel: DEFAULT_MODEL,
        targets: {
          repositories: [{ repoOwner: "openai", repoName: "codex", baseBranch: "main" }],
          environmentIds: [],
        },
      });

    expect(build(3)).toMatchObject({ valid: true, values: { maxConcurrentRuns: 3 } });
    // A stored value the API would refuse reads as the serialized default, or
    // floors at the minimum, rather than as an invalid form nobody can submit.
    expect(build(undefined)).toMatchObject({
      valid: true,
      values: { maxConcurrentRuns: DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS },
    });
    expect(build(0)).toMatchObject({ valid: true, values: { maxConcurrentRuns: 1 } });
    expect(build(999)).toMatchObject({
      valid: true,
      values: { maxConcurrentRuns: MAX_AUTOMATION_CONCURRENT_RUNS },
    });
  });
});
