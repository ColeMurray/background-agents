import { describe, expect, it } from "vitest";
import { piTraceHeader, piTraceId } from "./pi-trace";

describe("Pi trace correlation", () => {
  it("derives a stable trace id from an operation id", () => {
    expect(piTraceId("message-1")).toBe(piTraceId("message-1"));
    expect(piTraceId("message-1")).not.toBe(piTraceId("message-2"));
  });

  it("keeps the trace id free of characters that could carry content", () => {
    const traceId = piTraceId("message-1/../secret value");
    expect(traceId).toMatch(/^pi-[A-Za-z0-9_-]+$/);
    expect(traceId).not.toContain("/");
    expect(traceId).not.toContain(" ");
  });

  it("bounds the trace id length", () => {
    expect(piTraceId("m".repeat(500))).toHaveLength("pi-".length + 128);
  });

  it("omits the header when no operation is known", () => {
    expect(piTraceHeader(undefined)).toEqual({});
    expect(piTraceHeader("message-1")).toEqual({ "x-trace-id": piTraceId("message-1") });
  });
});
