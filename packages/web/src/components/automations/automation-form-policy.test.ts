import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutomationFormDraft, evaluateAutomationForm } from "./automation-form-policy";

afterEach(() => vi.unstubAllEnvs());

describe("one-shot form policy", () => {
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
