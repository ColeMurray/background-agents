import { describe, expect, it } from "vitest";
import {
  AutomationMutationInputError,
  parseCreateAutomationMutation,
  parseUpdateAutomationMutation,
} from "./automation-mutation";

describe("automation mutation ingress", () => {
  it("parses and normalizes a create request with canonical nested schemas", () => {
    const input = parseCreateAutomationMutation({
      name: "Daily review",
      instructions: "Review open changes",
      triggerType: "slack_event",
      triggerConfig: {
        conditions: [{ type: "slack_channel", operator: "any_of", value: ["C123"] }],
      },
      repositories: [{ repoOwner: " Acme ", repoName: " API ", baseBranch: null }],
      providerSelections: { openai: { mode: "provider_account", accountId: "a".repeat(32) } },
      actorDisplayName: "Automation Bot",
    });

    expect(input).toMatchObject({
      triggerType: "slack_event",
      repositories: [{ repoOwner: "acme", repoName: "api", baseBranch: null }],
      triggerConfig: {
        conditions: [{ type: "slack_channel", operator: "any_of", value: ["C123"] }],
      },
      actorDisplayName: "Automation Bot",
    });
  });

  it("rejects invalid trigger-specific shapes at ingress", () => {
    expect(() =>
      parseCreateAutomationMutation({
        name: "Slack review",
        instructions: "Review",
        triggerType: "slack_event",
        triggerConfig: { conditions: "C123" },
      })
    ).toThrowError(new AutomationMutationInputError("triggerConfig.conditions must be an array"));
  });

  it("keeps create and update semantics distinct", () => {
    expect(() => parseCreateAutomationMutation({ name: "Incomplete" })).toThrowError(
      new AutomationMutationInputError("instructions is required")
    );

    expect(parseUpdateAutomationMutation({ name: "Renamed" })).toEqual({ name: "Renamed" });
  });

  it("preserves update-specific scalar error messages", () => {
    expect(() => parseUpdateAutomationMutation({ name: 42 })).toThrowError(
      new AutomationMutationInputError("name cannot be empty")
    );
    expect(() => parseUpdateAutomationMutation({ instructions: null })).toThrowError(
      new AutomationMutationInputError("instructions cannot be empty")
    );
  });

  it("preserves omitted, cleared, and replaced update fields", () => {
    const omitted = parseUpdateAutomationMutation({ name: "Renamed" });
    expect("triggerConfig" in omitted).toBe(false);
    expect("reasoningEffort" in omitted).toBe(false);
    expect("repositories" in omitted).toBe(false);
    expect("environmentIds" in omitted).toBe(false);
    expect("providerSelections" in omitted).toBe(false);

    const cleared = parseUpdateAutomationMutation({
      triggerConfig: null,
      eventType: null,
      reasoningEffort: null,
      repositories: [],
      environmentIds: [],
      providerSelections: {},
    });
    expect(cleared).toEqual({
      triggerConfig: null,
      eventType: null,
      reasoningEffort: null,
      repositories: [],
      environmentIds: [],
      providerSelections: {},
    });
  });
});
