import { describe, it, expect } from "vitest";
import { matchesConditions, validateConditions } from "./conditions";
import { conditionRegistry } from "./registry";
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
});
