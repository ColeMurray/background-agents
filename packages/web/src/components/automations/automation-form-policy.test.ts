import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTOMATION_SCHEDULE_CRON,
  createAutomationFormDraft,
  evaluateAutomationForm,
  transitionAutomationTriggerType,
  type AutomationFormDraft,
} from "./automation-form-policy";

describe("automation form policy", () => {
  it("builds a trimmed scheduled automation submission", () => {
    const draft = createAutomationFormDraft({
      name: "  Daily review  ",
      instructions: "  Review the repository  ",
      scheduleTz: "America/Los_Angeles",
    });

    expect(
      evaluateAutomationForm({
        mode: "create",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: {
          repositories: [{ repoOwner: "openai", repoName: "codex", baseBranch: "main" }],
          environmentIds: [],
        },
      })
    ).toEqual({
      valid: true,
      values: {
        name: "Daily review",
        repositories: [{ repoOwner: "openai", repoName: "codex", baseBranch: "main" }],
        environmentIds: [],
        model: draft.agent.model,
        reasoningEffort: null,
        scheduleCron: DEFAULT_AUTOMATION_SCHEDULE_CRON,
        scheduleTz: "America/Los_Angeles",
        instructions: "Review the repository",
        triggerType: "schedule",
      },
    });
  });

  it("omits schedule fields and persists cleared conditions for event automations", () => {
    const draft = createAutomationFormDraft({
      name: "Webhook review",
      instructions: "Handle the payload",
      triggerType: "webhook",
      scheduleCron: "not a valid cron",
      triggerConfig: { conditions: [] },
    });

    expect(
      evaluateAutomationForm({
        mode: "edit",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: {
          repositories: [],
          environmentIds: [],
        },
      })
    ).toEqual({
      valid: true,
      values: {
        name: "Webhook review",
        repositories: [],
        environmentIds: [],
        model: draft.agent.model,
        reasoningEffort: null,
        instructions: "Handle the payload",
        triggerType: "webhook",
        triggerConfig: { conditions: [] },
      },
    });
  });

  it("rejects repository-scoped triggers without a repository", () => {
    const draft = createAutomationFormDraft({
      name: "Review pull requests",
      instructions: "Review the pull request",
      triggerType: "github_event",
      eventType: "pull_request",
    });

    expect(
      evaluateAutomationForm({
        mode: "create",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: { repositories: [], environmentIds: [] },
      })
    ).toEqual({ valid: false, reason: "repository-required" });
  });

  it("rejects repository-scoped triggers that also target an environment", () => {
    const draft = createAutomationFormDraft({
      name: "Review pull requests",
      instructions: "Review the pull request",
      triggerType: "github_event",
      eventType: "pull_request.opened",
    });

    expect(
      evaluateAutomationForm({
        mode: "create",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: {
          repositories: [{ repoOwner: "openai", repoName: "codex" }],
          environmentIds: ["env_1"],
        },
      })
    ).toEqual({ valid: false, reason: "invalid-target-selection" });
  });

  it("rejects multi-target event automations", () => {
    const draft = createAutomationFormDraft({
      name: "Handle webhooks",
      instructions: "Handle the payload",
      triggerType: "webhook",
    });

    expect(
      evaluateAutomationForm({
        mode: "create",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: {
          repositories: [
            { repoOwner: "openai", repoName: "codex" },
            { repoOwner: "openai", repoName: "openai-node" },
          ],
          environmentIds: [],
        },
      })
    ).toEqual({ valid: false, reason: "invalid-target-selection" });
  });

  it("rejects trigger sources that require an event type when none is selected", () => {
    const draft = createAutomationFormDraft({
      name: "Review pull requests",
      instructions: "Review the pull request",
      triggerType: "github_event",
    });

    expect(
      evaluateAutomationForm({
        mode: "create",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: {
          repositories: [{ repoOwner: "openai", repoName: "codex" }],
          environmentIds: [],
        },
      })
    ).toEqual({ valid: false, reason: "event-type-required" });
  });

  it("rejects a stale event type that does not belong to the selected trigger source", () => {
    const draft = createAutomationFormDraft({
      name: "Review pull requests",
      instructions: "Review the pull request",
      triggerType: "github_event",
      eventType: "issue",
    });

    expect(
      evaluateAutomationForm({
        mode: "edit",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: {
          repositories: [{ repoOwner: "openai", repoName: "codex" }],
          environmentIds: [],
        },
      })
    ).toEqual({ valid: false, reason: "event-type-required" });
  });

  it("rejects Slack automations without a channel condition", () => {
    const draft = createAutomationFormDraft({
      name: "Triage Slack reports",
      instructions: "Triage the reported issue",
      triggerType: "slack_event",
      triggerConfig: {
        conditions: [
          {
            type: "text_match",
            operator: "contains",
            value: { pattern: "deploy" },
          },
        ],
      },
    });

    expect(
      evaluateAutomationForm({
        mode: "edit",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: { repositories: [], environmentIds: [] },
      })
    ).toEqual({ valid: false, reason: "slack-channel-required" });
  });

  it("rejects Slack automations whose channel condition has no channels", () => {
    const draft = createAutomationFormDraft({
      name: "Triage Slack reports",
      instructions: "Triage the reported issue",
      triggerType: "slack_event",
      triggerConfig: {
        conditions: [{ type: "slack_channel", operator: "any_of", value: [] }],
      },
    });

    expect(
      evaluateAutomationForm({
        mode: "edit",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: { repositories: [], environmentIds: [] },
      })
    ).toEqual({
      valid: false,
      reason: "invalid-conditions",
      conditionErrors: ["Slack Channel requires at least one nonblank channel ID"],
    });
  });

  it("drops conditions that do not belong to the next trigger source", () => {
    const draft = createAutomationFormDraft({
      triggerType: "github_event",
      eventType: "pull_request.opened",
      triggerConfig: {
        conditions: [
          { type: "branch", operator: "glob_match", value: ["feature/*"] },
          { type: "label", operator: "any_of", value: ["bug"] },
        ],
      },
    }).trigger;

    expect(transitionAutomationTriggerType(draft, "sentry")).toMatchObject({
      type: "sentry",
      eventType: "",
      conditions: [],
    });
  });

  it("preserves conditions that are supported by the next trigger source", () => {
    const draft = createAutomationFormDraft({
      triggerType: "github_event",
      eventType: "pull_request.opened",
      triggerConfig: {
        conditions: [
          { type: "label", operator: "any_of", value: ["bug"] },
          { type: "branch", operator: "glob_match", value: ["feature/*"] },
        ],
      },
    }).trigger;

    expect(transitionAutomationTriggerType(draft, "linear_event").conditions).toEqual([
      { type: "label", operator: "any_of", value: ["bug"] },
    ]);
  });

  it("drops unknown persisted conditions when changing trigger sources", () => {
    const draft = createAutomationFormDraft({
      triggerType: "github_event",
      triggerConfig: {
        conditions: [
          {
            type: "removed_condition",
            operator: "any_of",
            value: ["legacy"],
          } as unknown as AutomationFormDraft["trigger"]["conditions"][number],
        ],
      },
    }).trigger;

    expect(transitionAutomationTriggerType(draft, "linear_event").conditions).toEqual([]);
  });

  it("reports when enabled models are still loading", () => {
    const draft = createAutomationFormDraft({
      name: "Daily review",
      instructions: "Review the repository",
      scheduleTz: "UTC",
    });

    expect(
      evaluateAutomationForm({
        mode: "create",
        draft,
        loadingModels: true,
        resolvedModel: draft.agent.model,
        targets: { repositories: [], environmentIds: [] },
      })
    ).toEqual({ valid: false, reason: "models-loading" });
  });

  it("reports missing required fields after models finish loading", () => {
    const draft = createAutomationFormDraft({
      instructions: "Review the repository",
      scheduleTz: "UTC",
    });

    expect(
      evaluateAutomationForm({
        mode: "create",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: { repositories: [], environmentIds: [] },
      })
    ).toEqual({ valid: false, reason: "required-fields" });
  });

  it("rejects schedules that run more often than every fifteen minutes", () => {
    const draft = createAutomationFormDraft({
      name: "Frequent review",
      instructions: "Review the repository",
      scheduleCron: "* * * * *",
      scheduleTz: "UTC",
    });

    expect(
      evaluateAutomationForm({
        mode: "create",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: { repositories: [], environmentIds: [] },
      })
    ).toEqual({ valid: false, reason: "invalid-schedule" });
  });

  it("requires a Sentry client secret when creating a Sentry automation", () => {
    const draft = createAutomationFormDraft({
      name: "Investigate Sentry alerts",
      instructions: "Investigate the alert",
      triggerType: "sentry",
      eventType: "issue.created",
    });

    expect(
      evaluateAutomationForm({
        mode: "create",
        draft,
        loadingModels: false,
        resolvedModel: draft.agent.model,
        targets: { repositories: [], environmentIds: [] },
      })
    ).toEqual({ valid: false, reason: "sentry-secret-required" });
  });

  it("includes a trimmed Sentry client secret only in a valid create submission", () => {
    const draft = createAutomationFormDraft({
      name: "Investigate Sentry alerts",
      instructions: "Investigate the alert",
      triggerType: "sentry",
      eventType: "issue.created",
    });
    draft.trigger.sentryClientSecret = "  client-secret  ";

    const result = evaluateAutomationForm({
      mode: "create",
      draft,
      loadingModels: false,
      resolvedModel: draft.agent.model,
      targets: { repositories: [], environmentIds: [] },
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.values.sentryClientSecret).toBe("client-secret");
    }
  });
});
