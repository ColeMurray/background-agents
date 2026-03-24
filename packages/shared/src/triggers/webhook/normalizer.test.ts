import { describe, it, expect } from "vitest";
import { normalizeWebhookEvent, resolveJsonPath, evaluateJsonPathFilter } from "./normalizer";

describe("normalizeWebhookEvent", () => {
  it("creates a webhook event with a generated delivery ID", () => {
    const event = normalizeWebhookEvent("auto-1", { test: true });
    expect(event.source).toBe("webhook");
    expect(event.eventType).toBe("webhook.received");
    expect(event.automationId).toBe("auto-1");
    expect(event.triggerKey).toMatch(/^webhook:[a-f0-9]+$/);
    expect(event.body).toEqual({ test: true });
  });

  it("uses idempotencyKey for trigger key when provided", () => {
    const event = normalizeWebhookEvent("auto-1", { test: true }, "my-key");
    expect(event.triggerKey).toBe("webhook:idem:my-key");
    expect(event.concurrencyKey).toBe("webhook:idem:my-key");
  });

  it("strips idempotencyKey from body in context but keeps it in body", () => {
    const event = normalizeWebhookEvent(
      "auto-1",
      { idempotencyKey: "key-1", data: "value" },
      "key-1"
    );
    expect(event.body).toEqual({ idempotencyKey: "key-1", data: "value" });
    expect(event.contextBlock).not.toContain("idempotencyKey");
    expect(event.contextBlock).toContain("value");
  });
});

describe("resolveJsonPath", () => {
  it("resolves dot-notation paths", () => {
    const obj = { a: { b: { c: 42 } } };
    expect(resolveJsonPath("$.a.b.c", obj)).toBe(42);
  });

  it("returns undefined for missing paths", () => {
    expect(resolveJsonPath("$.a.b.missing", { a: { b: {} } })).toBeUndefined();
  });

  it("returns undefined for non-$. prefix", () => {
    expect(resolveJsonPath("a.b", { a: { b: 1 } })).toBeUndefined();
  });

  it("handles null in path", () => {
    expect(resolveJsonPath("$.a.b", { a: null })).toBeUndefined();
  });
});

describe("evaluateJsonPathFilter", () => {
  const body = { event: { severity: "critical", count: 10, name: "Deploy failed" } };

  it("evaluates eq comparison", () => {
    expect(
      evaluateJsonPathFilter(
        { path: "$.event.severity", comparison: "eq", value: "critical" },
        body
      )
    ).toBe(true);
    expect(
      evaluateJsonPathFilter({ path: "$.event.severity", comparison: "eq", value: "warning" }, body)
    ).toBe(false);
  });

  it("evaluates neq comparison", () => {
    expect(
      evaluateJsonPathFilter(
        { path: "$.event.severity", comparison: "neq", value: "warning" },
        body
      )
    ).toBe(true);
  });

  it("evaluates numeric comparisons", () => {
    expect(
      evaluateJsonPathFilter({ path: "$.event.count", comparison: "gt", value: 5 }, body)
    ).toBe(true);
    expect(
      evaluateJsonPathFilter({ path: "$.event.count", comparison: "lt", value: 5 }, body)
    ).toBe(false);
    expect(
      evaluateJsonPathFilter({ path: "$.event.count", comparison: "gte", value: 10 }, body)
    ).toBe(true);
    expect(
      evaluateJsonPathFilter({ path: "$.event.count", comparison: "lte", value: 10 }, body)
    ).toBe(true);
  });

  it("evaluates contains comparison", () => {
    expect(
      evaluateJsonPathFilter(
        { path: "$.event.name", comparison: "contains", value: "Deploy" },
        body
      )
    ).toBe(true);
    expect(
      evaluateJsonPathFilter({ path: "$.event.name", comparison: "contains", value: "xyz" }, body)
    ).toBe(false);
  });

  it("evaluates exists comparison", () => {
    expect(evaluateJsonPathFilter({ path: "$.event.severity", comparison: "exists" }, body)).toBe(
      true
    );
    expect(evaluateJsonPathFilter({ path: "$.event.missing", comparison: "exists" }, body)).toBe(
      false
    );
  });

  it("returns false for undefined values (non-exists comparisons)", () => {
    expect(evaluateJsonPathFilter({ path: "$.missing", comparison: "eq", value: "x" }, body)).toBe(
      false
    );
  });
});
