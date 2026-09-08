import { describe, it, expect } from "vitest";
import {
  dedupeConditionsBySemanticKey,
  isGitHubConditionCompatible,
  matchesConditions,
  validateConditions,
} from "./conditions";
import { conditionRegistry } from "./registry";
import { CHECK_SUITE_CONCLUSIONS, WORKFLOW_RUN_CONCLUSIONS } from "./github";
import { buildMockEvent } from "./testing";

describe("matchesConditions", () => {
  it("returns true when no conditions", () => {
    const event = buildMockEvent("sentry");
    expect(matchesConditions([], event, conditionRegistry)).toBe(true);
  });

  it("returns true when all conditions match", () => {
    const event = buildMockEvent("sentry", {
      sentryProject: "backend",
      sentryLevel: "error",
    });
    const conditions = [
      { type: "sentry_project" as const, operator: "any_of" as const, value: ["backend"] },
      { type: "sentry_level" as const, operator: "any_of" as const, value: ["error", "fatal"] },
    ];
    expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
  });

  it("returns false when any condition fails", () => {
    const event = buildMockEvent("sentry", {
      sentryProject: "frontend",
      sentryLevel: "error",
    });
    const conditions = [
      { type: "sentry_project" as const, operator: "any_of" as const, value: ["backend"] },
      { type: "sentry_level" as const, operator: "any_of" as const, value: ["error"] },
    ];
    expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
  });

  describe("actor condition (case-insensitive)", () => {
    it("matches actor with different casing (include)", () => {
      const event = buildMockEvent("github", { actor: "ColeMurray" });
      const conditions = [
        { type: "actor" as const, operator: "include" as const, value: ["colemurray"] },
      ];
      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("matches actor with different casing (exclude)", () => {
      const event = buildMockEvent("github", { actor: "ColeMurray" });
      const conditions = [
        { type: "actor" as const, operator: "exclude" as const, value: ["COLEMURRAY"] },
      ];
      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });

    it("matches actor with exact casing", () => {
      const event = buildMockEvent("github", { actor: "octocat" });
      const conditions = [
        { type: "actor" as const, operator: "include" as const, value: ["octocat"] },
      ];
      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });
  });

  describe("label condition (case-insensitive)", () => {
    it("matches labels with different casing (any_of)", () => {
      const event = buildMockEvent("github", { labels: ["Bug", "Enhancement"] });
      const conditions = [{ type: "label" as const, operator: "any_of" as const, value: ["bug"] }];
      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("rejects labels with different casing (none_of)", () => {
      const event = buildMockEvent("github", { labels: ["Bug"] });
      const conditions = [{ type: "label" as const, operator: "none_of" as const, value: ["BUG"] }];
      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });
  });

  describe("GitHub target_branch (merge base)", () => {
    it("matches when merge base ref matches a pattern", () => {
      const event = buildMockEvent("github", {
        branch: "feature/x",
        targetBranch: "stable",
      });
      const conditions = [
        { type: "target_branch" as const, operator: "glob_match" as const, value: ["stable"] },
      ];
      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("does not match when merge base differs", () => {
      const event = buildMockEvent("github", {
        branch: "feature/x",
        targetBranch: "main",
      });
      const conditions = [
        { type: "target_branch" as const, operator: "glob_match" as const, value: ["stable"] },
      ];
      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });

    it("does not match when the event has no merge base ref", () => {
      const event = buildMockEvent("github", { branch: "main" });
      const conditions = [
        { type: "target_branch" as const, operator: "glob_match" as const, value: ["main"] },
      ];
      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });

    it("matches with the exact operator", () => {
      const event = buildMockEvent("github", {
        branch: "feature/x",
        targetBranch: "release/v1",
      });
      const conditions = [
        {
          type: "target_branch" as const,
          operator: "exact" as const,
          value: ["release/v1", "main"],
        },
      ];
      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("does not match with the exact operator when no value equals the target", () => {
      const event = buildMockEvent("github", {
        branch: "feature/x",
        targetBranch: "release/v1",
      });
      const conditions = [
        { type: "target_branch" as const, operator: "exact" as const, value: ["release"] },
      ];
      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(false);
    });
  });

  describe("GitHub workflow_name", () => {
    it("matches only the configured workflow", () => {
      const event = buildMockEvent("github", { workflowName: "CI" });
      const conditions = [{ type: "workflow_name" as const, operator: "eq" as const, value: "CI" }];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
      expect(
        matchesConditions(
          conditions,
          buildMockEvent("github", { workflowName: "Deploy" }),
          conditionRegistry
        )
      ).toBe(false);
    });

    it("does not match events without a workflow name", () => {
      const conditions = [{ type: "workflow_name" as const, operator: "eq" as const, value: "CI" }];

      expect(matchesConditions(conditions, buildMockEvent("github"), conditionRegistry)).toBe(
        false
      );
    });
  });

  describe("GitHub conclusion", () => {
    it("matches the canonical conclusion field", () => {
      const event = buildMockEvent("github", { conclusion: "failure" });
      const conditions = [
        { type: "conclusion" as const, operator: "eq" as const, value: "failure" },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("keeps the legacy check conclusion condition compatible with the canonical field", () => {
      const event = buildMockEvent("github", { conclusion: "failure" });
      const conditions = [
        { type: "check_conclusion" as const, operator: "eq" as const, value: "failure" },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });

    it("accepts the legacy normalized field during rolling deployments", () => {
      const event = buildMockEvent("github", { checkConclusion: "failure" });
      const conditions = [
        { type: "check_conclusion" as const, operator: "eq" as const, value: "failure" },
      ];

      expect(matchesConditions(conditions, event, conditionRegistry)).toBe(true);
    });
  });
});

describe("validateConditions", () => {
  it("returns no errors for valid conditions", () => {
    const errors = validateConditions(
      [{ type: "sentry_project", operator: "any_of", value: ["backend"] }],
      "sentry",
      conditionRegistry
    );
    expect(errors).toHaveLength(0);
  });

  it("returns error for empty value", () => {
    const errors = validateConditions(
      [{ type: "sentry_project", operator: "any_of", value: [] }],
      "sentry",
      conditionRegistry
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("At least one project required");
  });

  it("returns error for condition that does not apply to the source", () => {
    const errors = validateConditions(
      [{ type: "sentry_project", operator: "any_of", value: ["backend"] }],
      "webhook",
      conditionRegistry
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("does not apply to webhook triggers");
  });

  it("returns error for empty target_branch patterns on github", () => {
    const errors = validateConditions(
      [{ type: "target_branch", operator: "glob_match", value: [] }],
      "github",
      conditionRegistry,
      "pull_request.opened"
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("target branch");
  });

  it("accepts target_branch for pull request triggers", () => {
    const errors = validateConditions(
      [{ type: "target_branch", operator: "glob_match", value: ["stable", "main"] }],
      "github",
      conditionRegistry,
      "pull_request.opened"
    );
    expect(errors).toHaveLength(0);
  });

  it("rejects GitHub conditions when no event type is known", () => {
    expect(
      validateConditions(
        [{ type: "branch", operator: "glob_match", value: ["main"] }],
        "github",
        conditionRegistry
      )
    ).toEqual(['Condition "branch" requires a GitHub event type']);
  });

  it.each([
    { type: "workflow_name" as const, value: "CI" },
    { type: "conclusion" as const, value: "success" },
    { type: "check_conclusion" as const, value: "success" },
  ])("rejects $type for an incompatible GitHub event type", ({ type, value }) => {
    const errors = validateConditions(
      [{ type, operator: "eq", value }],
      "github",
      conditionRegistry,
      "pull_request.opened"
    );

    expect(errors).toEqual([
      `Condition "${type}" does not apply to GitHub event pull_request.opened`,
    ]);
  });

  it("rejects fields absent from the event type's payload", () => {
    expect(
      validateConditions(
        [{ type: "label", operator: "any_of", value: ["bug"] }],
        "github",
        conditionRegistry,
        "workflow_run.completed"
      )
    ).toEqual(['Condition "label" does not apply to GitHub event workflow_run.completed']);
  });

  it("rejects path_glob outright — no source can supply a file list", () => {
    expect(
      validateConditions(
        [{ type: "path_glob", operator: "any_match", value: ["src/**"] }],
        "github",
        conditionRegistry,
        "pull_request.opened"
      )
    ).toEqual(['Condition "path_glob" does not apply to github triggers']);
  });

  it("accepts workflow_name only for workflow runs", () => {
    expect(
      validateConditions(
        [{ type: "workflow_name", operator: "eq", value: "CI" }],
        "github",
        conditionRegistry,
        "workflow_run.completed"
      )
    ).toHaveLength(0);
  });

  it.each(WORKFLOW_RUN_CONCLUSIONS)("accepts the %s workflow run conclusion", (conclusion) => {
    expect(
      validateConditions(
        [{ type: "conclusion", operator: "eq", value: conclusion }],
        "github",
        conditionRegistry,
        "workflow_run.completed"
      )
    ).toHaveLength(0);
  });

  it.each(CHECK_SUITE_CONCLUSIONS)("accepts the %s check suite conclusion", (conclusion) => {
    expect(
      validateConditions(
        [{ type: "check_conclusion", operator: "eq", value: conclusion }],
        "github",
        conditionRegistry,
        "check_suite.completed"
      )
    ).toHaveLength(0);
  });

  it("rejects conclusions unsupported by the selected event", () => {
    expect(
      validateConditions(
        [{ type: "conclusion", operator: "eq", value: "startup_failure" }],
        "github",
        conditionRegistry,
        "workflow_run.completed"
      )
    ).toEqual(["Invalid conclusion: startup_failure"]);
  });
});

describe("isGitHubConditionCompatible", () => {
  it("checks event-specific conclusion values", () => {
    const startupFailure = {
      type: "conclusion" as const,
      operator: "eq" as const,
      value: "startup_failure",
    };

    expect(isGitHubConditionCompatible("check_suite.completed", startupFailure)).toBe(true);
    expect(isGitHubConditionCompatible("workflow_run.completed", startupFailure)).toBe(false);
  });

  it("prefers the active condition over a parked semantic alias", () => {
    const active = { type: "conclusion" as const, operator: "eq" as const, value: "failure" };
    const parked = {
      type: "check_conclusion" as const,
      operator: "eq" as const,
      value: "startup_failure",
    };

    expect(dedupeConditionsBySemanticKey([active, parked])).toEqual([active]);
  });
});
