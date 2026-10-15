import { describe, expect, it } from "vitest";
import { createAutomationFormDraft, evaluateAutomationForm } from "./automation-form-policy";

describe("payload target form policy", () => {
  it.each([
    { repositories: [{ repoOwner: "acme", repoName: "api" }], environmentIds: [] },
    { repositories: [], environmentIds: ["env_one"] },
  ])("rejects fixed targets while payload mode is active", (targets) => {
    const draft = createAutomationFormDraft({
      name: "CI",
      instructions: "Investigate",
      triggerType: "webhook",
      triggerConfig: {
        conditions: [],
        repositoryFromPayload: { repoOwnerPath: "$.owner", repoNamePath: "$.name" },
      },
    });
    expect(
      evaluateAutomationForm({
        mode: "edit",
        draft,
        modelAvailability: { status: "available" },
        resolvedModel: draft.agent.model,
        targets,
      })
    ).toEqual({ valid: false, reason: "invalid-target-selection" });
  });
});
