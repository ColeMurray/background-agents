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

describe("normalizeSentryEvent", () => {
  it("normalizes an issue alert payload", () => {
    const event = normalizeSentryEvent(issueAlertPayload);
    expect(event).not.toBeNull();
    expect(event!.source).toBe("sentry");
    expect(event!.eventType).toBe("issue.created");
    expect(event!.triggerKey).toBe("sentry_issue:12345");
    expect(event!.concurrencyKey).toBe("sentry_issue:12345");
    expect(event!.sentryProject).toBe("acme-backend");
    expect(event!.sentryLevel).toBe("error");
    expect(event!.culpritFile).toBe("src/handlers/auth.ts");
    expect(event!.contextBlock).toContain("TypeError");
    expect(event!.contextBlock).toContain("acme-backend");
  });

  it("normalizes a regression payload", () => {
    const regressionPayload = {
      ...issueAlertPayload,
      action: "regression",
    };
    const event = normalizeSentryEvent(regressionPayload);
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe("issue.regression");
    expect(event!.triggerKey).toContain("sentry_regression:");
  });

  it("normalizes a metric alert payload", () => {
    const metricPayload = {
      action: "critical",
      data: {
        metric_alert: {
          id: 456,
          title: "Error rate > 5%",
          alert_rule: { id: 789, name: "High error rate" },
          date_started: "2026-03-23T14:30:00Z",
          current_trigger: { label: "critical" },
        },
        description_text: "Error rate exceeded 5%",
        description_title: "Metric Alert",
        web_url: "https://sentry.io/alerts/456/",
      },
    };
    const event = normalizeSentryEvent(metricPayload);
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe("metric_alert.critical");
    expect(event!.triggerKey).toBe("sentry_metric:789:2026-03-23T14:30:00Z");
    expect(event!.concurrencyKey).toBe("sentry_metric:789");
  });

  it("returns null for non-critical metric alerts", () => {
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
    expect(normalizeSentryEvent(warningPayload)).toBeNull();
  });

  it("returns null for resolved issue action", () => {
    const resolvedPayload = {
      ...issueAlertPayload,
      action: "resolved",
    };
    expect(normalizeSentryEvent(resolvedPayload)).toBeNull();
  });

  it("returns null for issue with resolved status", () => {
    const resolvedPayload = {
      ...issueAlertPayload,
      data: {
        ...issueAlertPayload.data,
        issue: { ...issueAlertPayload.data.issue, status: "resolved" },
      },
    };
    expect(normalizeSentryEvent(resolvedPayload)).toBeNull();
  });

  it("returns null for issue with ignored status", () => {
    const ignoredPayload = {
      ...issueAlertPayload,
      data: {
        ...issueAlertPayload.data,
        issue: { ...issueAlertPayload.data.issue, status: "ignored" },
      },
    };
    expect(normalizeSentryEvent(ignoredPayload)).toBeNull();
  });

  it("returns null for unrecognized payload shapes", () => {
    expect(normalizeSentryEvent({ action: "unknown" })).toBeNull();
    expect(normalizeSentryEvent({})).toBeNull();
  });
});
