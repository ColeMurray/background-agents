import { describe, it } from "vitest";
import { buildMockEvent, assertConditionMatch } from "../testing";

describe("sentry conditions", () => {
  describe("sentry_project", () => {
    it("matches when project slug is in the list", () => {
      const event = buildMockEvent("sentry", { sentryProject: "acme-backend" });
      assertConditionMatch(
        { type: "sentry_project", operator: "any_of", value: ["acme-backend", "acme-frontend"] },
        event,
        true
      );
    });

    it("does not match when project slug is not in the list", () => {
      const event = buildMockEvent("sentry", { sentryProject: "other-project" });
      assertConditionMatch(
        { type: "sentry_project", operator: "any_of", value: ["acme-backend"] },
        event,
        false
      );
    });

    it("passes through for non-sentry events", () => {
      const event = buildMockEvent("github");
      assertConditionMatch(
        { type: "sentry_project", operator: "any_of", value: ["acme-backend"] },
        event,
        true
      );
    });
  });

  describe("sentry_level", () => {
    it("matches when level is in the list", () => {
      const event = buildMockEvent("sentry", { sentryLevel: "error" });
      assertConditionMatch(
        { type: "sentry_level", operator: "any_of", value: ["error", "fatal"] },
        event,
        true
      );
    });

    it("does not match when level is not in the list", () => {
      const event = buildMockEvent("sentry", { sentryLevel: "warning" });
      assertConditionMatch(
        { type: "sentry_level", operator: "any_of", value: ["error", "fatal"] },
        event,
        false
      );
    });
  });
});
