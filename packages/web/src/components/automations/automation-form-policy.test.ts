import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import {
  DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
  MAX_AUTOMATION_CONCURRENT_RUNS,
} from "@open-inspect/shared/types/automations";
import { createAutomationFormDraft, evaluateAutomationForm } from "./automation-form-policy";

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
