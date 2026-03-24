import { describe, it } from "vitest";
import { buildMockEvent, assertConditionMatch } from "../testing";

describe("webhook conditions", () => {
  describe("jsonpath", () => {
    it("matches when all filters pass", () => {
      const event = buildMockEvent("webhook", {
        body: { event: "deploy_failed", severity: "critical" },
      });
      assertConditionMatch(
        {
          type: "jsonpath",
          operator: "all_match",
          value: [
            { path: "$.event", comparison: "eq", value: "deploy_failed" },
            { path: "$.severity", comparison: "eq", value: "critical" },
          ],
        },
        event,
        true
      );
    });

    it("does not match when any filter fails", () => {
      const event = buildMockEvent("webhook", {
        body: { event: "deploy_failed", severity: "warning" },
      });
      assertConditionMatch(
        {
          type: "jsonpath",
          operator: "all_match",
          value: [
            { path: "$.event", comparison: "eq", value: "deploy_failed" },
            { path: "$.severity", comparison: "eq", value: "critical" },
          ],
        },
        event,
        false
      );
    });

    it("passes through for non-webhook events", () => {
      const event = buildMockEvent("sentry");
      assertConditionMatch(
        {
          type: "jsonpath",
          operator: "all_match",
          value: [{ path: "$.event", comparison: "eq", value: "test" }],
        },
        event,
        true
      );
    });
  });
});
