import { describe, it, expect } from "vitest";
import { normalizeSentryEvent } from "./normalizer";

const issueAlertPayload = {
  action: "triggered",
  data: {
    event: {
      event_id: "evt-1",
      title: "TypeError: Cannot read properties of undefined",
      culprit: "src/handlers/auth.ts in validateSession",
      level: "error",
      metadata: {
        type: "TypeError",
        value: "Cannot read properties of undefined (reading 'userId')",
        filename: "src/handlers/auth.ts",
        function: "validateSession",
      },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined",
            stacktrace: {
              frames: [
                {
                  filename: "node_modules/hono/dist/hono.js",
                  function: "fetch",
                  lineno: 12,
                  colno: 0,
                  abs_path: "",
                  in_app: false,
                },
                {
                  filename: "src/handlers/auth.ts",
                  function: "validateSession",
                  lineno: 142,
                  colno: 0,
                  abs_path: "",
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
      tags: [{ key: "environment", value: "production" }],
    },
    issue: {
      id: "12345",
      shortId: "BACKEND-ABC",
      title: "TypeError: Cannot read properties of undefined",
      culprit: "src/handlers/auth.ts in validateSession",
      level: "error",
      project: { id: 1, slug: "acme-backend", name: "Acme Backend" },
      count: "47",
      firstSeen: "2026-03-23T08:23:17Z",
      lastSeen: "2026-03-23T10:00:00Z",
      status: "unresolved",
    },
    triggered_rule: "New issue alert",
  },
  actor: { type: "application", id: 1, name: "Sentry" },
};

const issueWebhookPayload = {
  action: "created",
  installation: { uuid: "installation-1" },
  data: {
    issue: {
      id: "67890",
      shortId: "FRONTEND-XYZ",
      title: "TypeError: Cannot read properties of undefined",
      culprit: "src/App.tsx in BrokenCheckout",
      level: "error",
      status: "unresolved",
      project: { id: "2", slug: "sentry-demo", name: "Sentry Demo" },
      count: "1",
      firstSeen: "2026-08-03T20:00:00Z",
      lastSeen: "2026-08-03T20:00:00Z",
      web_url: "https://sentry.io/issues/67890/",
    },
  },
  actor: { type: "application", id: "sentry", name: "Sentry" },
};

function expectNormalized(result: ReturnType<typeof normalizeSentryEvent>) {
  expect(result.status).toBe("normalized");
  if (result.status !== "normalized") {
    throw new Error(`Expected normalized event, received ${result.reason}`);
  }
  return result.event;
}

describe("normalizeSentryEvent", () => {
  it("normalizes a current Sentry issue.created webhook", () => {
    const event = expectNormalized(normalizeSentryEvent(issueWebhookPayload, undefined, "issue"));

    expect(event.eventType).toBe("issue.created");
    expect(event.triggerKey).toBe("sentry_issue:67890");
    expect(event.concurrencyKey).toBe("sentry_issue:67890");
    expect(event.sentryProject).toBe("sentry-demo");
    expect(event.sentryLevel).toBe("error");
    expect(event.culpritFile).toBeUndefined();
    expect(event.contextBlock).toContain("TypeError");
    expect(event.contextBlock).toContain("FRONTEND-XYZ");
  });

  it("uses the Sentry resource header to discriminate issue and alert payloads", () => {
    expect(normalizeSentryEvent(issueWebhookPayload, undefined, "event_alert")).toEqual({
      status: "skipped",
      reason: "invalid_shape",
    });
    expect(normalizeSentryEvent(issueAlertPayload, undefined, "issue")).toEqual({
      status: "skipped",
      reason: "unsupported_action",
    });
  });

  it("normalizes an issue alert payload", () => {
    const event = expectNormalized(
      normalizeSentryEvent(issueAlertPayload, undefined, "event_alert")
    );
    expect(event.source).toBe("sentry");
    expect(event.eventType).toBe("issue.created");
    expect(event.triggerKey).toBe("sentry_issue:12345");
    expect(event.concurrencyKey).toBe("sentry_issue:12345");
    expect(event.sentryProject).toBe("acme-backend");
    expect(event.sentryLevel).toBe("error");
    expect(event.culpritFile).toBe("src/handlers/auth.ts");
    expect(event.contextBlock).toContain("TypeError");
    expect(event.contextBlock).toContain("acme-backend");
  });

  it("normalizes a regression payload", () => {
    const regressionPayload = {
      ...issueAlertPayload,
      action: "regression",
    };
    const event = expectNormalized(normalizeSentryEvent(regressionPayload));
    expect(event.eventType).toBe("issue.regression");
    expect(event.triggerKey).toContain("sentry_regression:");
  });

  it.each([
    ["string", "456", "789"],
    ["numeric", 456, 789],
  ])("normalizes a metric alert payload with %s identifiers", (_type, metricId, alertRuleId) => {
    const metricPayload = {
      action: "critical",
      data: {
        metric_alert: {
          id: metricId,
          title: "Error rate > 5%",
          alert_rule: { id: alertRuleId, name: "High error rate" },
          date_started: "2026-03-23T14:30:00Z",
          current_trigger: { label: "critical" },
        },
        description_text: "Error rate exceeded 5%",
        description_title: "Metric Alert",
        web_url: "https://sentry.io/alerts/456/",
      },
    };
    const event = expectNormalized(normalizeSentryEvent(metricPayload, undefined, "metric_alert"));
    expect(event.eventType).toBe("metric_alert.critical");
    expect(event.triggerKey).toBe("sentry_metric:789:2026-03-23T14:30:00Z");
    expect(event.concurrencyKey).toBe("sentry_metric:789");
    expect(event.meta.alertRuleId).toBe("789");
  });

  it("returns unsupported_action for non-critical metric alerts", () => {
    const warningPayload = {
      action: "warning",
      data: {
        metric_alert: {
          id: 456,
          title: "Error rate > 3%",
          alert_rule: { id: 789, name: "Elevated error rate" },
          date_started: "2026-03-23T14:30:00Z",
          current_trigger: { label: "warning" },
        },
        description_text: "Error rate exceeded 3%",
        description_title: "Metric Alert",
        web_url: "https://sentry.io/alerts/456/",
      },
    };
    expect(normalizeSentryEvent(warningPayload)).toEqual({
      status: "skipped",
      reason: "unsupported_action",
    });
  });

  it("returns invalid_shape for unrecognized payload shapes", () => {
    expect(normalizeSentryEvent({ action: "unknown" })).toEqual({
      status: "skipped",
      reason: "invalid_shape",
    });
    expect(normalizeSentryEvent({})).toEqual({
      status: "skipped",
      reason: "invalid_shape",
    });
  });

  it("returns unknown_resource for unsupported resource headers", () => {
    expect(normalizeSentryEvent(issueWebhookPayload, undefined, "installation")).toEqual({
      status: "skipped",
      reason: "unknown_resource",
    });
  });

  it("returns invalid_shape for an issue alert missing consumed issue fields", () => {
    const malformed = {
      action: "triggered",
      data: {
        event: { metadata: { filename: "src/handlers/auth.ts" } },
        // issue is missing id/level/status/lastSeen/project — all consumed downstream
        issue: { shortId: "BACKEND-ABC" },
        triggered_rule: "New issue alert",
      },
      actor: { type: "application", id: 1, name: "Sentry" },
    };
    expect(normalizeSentryEvent(malformed)).toEqual({
      status: "skipped",
      reason: "invalid_shape",
    });
  });

  it("returns invalid_shape for a metric alert missing trigger-key fields", () => {
    const malformed = {
      action: "critical",
      data: {
        metric_alert: {
          id: 456,
          title: "Error rate > 5%",
          current_trigger: { label: "critical" },
          // alert_rule and date_started are missing — both feed the trigger key
        },
        description_text: "Error rate exceeded 5%",
        description_title: "Metric Alert",
        web_url: "https://sentry.io/alerts/456/",
      },
    };
    expect(normalizeSentryEvent(malformed)).toEqual({
      status: "skipped",
      reason: "invalid_shape",
    });
  });
});
