import { describe, expect, it } from "vitest";
import { validateAutomationTargetCounts } from "./automations";

describe("validateAutomationTargetCounts", () => {
  it("keeps repository-scoped triggers bound to one repository", () => {
    expect(validateAutomationTargetCounts("github_event", 0, 0)).toBe(
      "Repository-scoped triggers require exactly one repository"
    );
    expect(validateAutomationTargetCounts("github_event", 1, 1)).toBe(
      "Repository-scoped triggers cannot target environments"
    );
    expect(validateAutomationTargetCounts("github_event", 1, 0)).toBeNull();
  });

  it("allows fan-out only for schedules", () => {
    expect(validateAutomationTargetCounts("webhook", 2, 0)).toBe(
      "Multi-target selections require a schedule trigger"
    );
    expect(validateAutomationTargetCounts("schedule", 2, 1)).toBeNull();
  });

  it("enforces the combined target cap", () => {
    expect(validateAutomationTargetCounts("schedule", 10, 1)).toBe(
      "At most 10 repositories and environments combined"
    );
  });
});
