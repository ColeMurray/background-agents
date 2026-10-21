import { describe, expect, it, vi } from "vitest";
import type { createLogger } from "../logger";
import {
  OpenInspectPiTelemetryContext,
  assertContentFreeAttributes,
  createNoopPiTelemetryContext,
  createPiTraceId,
} from "./pi-telemetry";

function logger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as ReturnType<typeof createLogger>;
}

describe("Pi telemetry", () => {
  it("records a content-free span with its duration and status", async () => {
    const log = logger();
    const telemetry = new OpenInspectPiTelemetryContext({ logger: log, traceId: "pi-op-1" });

    await telemetry.startSpan(
      { name: "pi.open-inspect.latency", attributes: { milestone: "pi_admitted" } },
      async (span) => {
        span.setAttributes({ duration_ms: 12 });
      }
    );

    expect(log.info).toHaveBeenCalledTimes(1);
    const record = (log.info as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      event: "pi.telemetry",
      span: "pi.open-inspect.latency",
      milestone: "pi_admitted",
      duration_ms: 12,
      status: "ok",
      trace_id: "pi-op-1",
    });
  });

  it("marks a failed span as an error and rethrows", async () => {
    const log = logger();
    const telemetry = new OpenInspectPiTelemetryContext({ logger: log });

    await expect(
      telemetry.startSpan({ name: "pi.durable.phase" }, async () => {
        throw new Error("phase failed");
      })
    ).rejects.toThrow("phase failed");

    const record = (log.info as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(record.status).toBe("error");
  });

  it("nests spans under their parent", async () => {
    const log = logger();
    const telemetry = new OpenInspectPiTelemetryContext({ logger: log });

    await telemetry.startSpan({ name: "pi.durable.submit" }, async (span) => {
      await span.startSpan({ name: "pi.durable.phase" }, async () => undefined);
    });

    const records = (log.info as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[1] as Record<string, unknown>
    );
    const child = records.find((record) => record.span === "pi.durable.phase");
    const parent = records.find((record) => record.span === "pi.durable.submit");
    expect(child?.parent_span_id).toBe(parent?.span_id);
  });

  it("refuses content-bearing attributes", () => {
    expect(() => assertContentFreeAttributes({ prompt: "hello" })).toThrow(/content-free/);
    expect(() => assertContentFreeAttributes({ access_token: "secret" })).toThrow(/content-free/);
    expect(() => assertContentFreeAttributes({ milestone: "pi_admitted" })).not.toThrow();
  });

  it("rejects a content-bearing attribute before it reaches the sink", async () => {
    const log = logger();
    const telemetry = new OpenInspectPiTelemetryContext({ logger: log });

    await expect(
      telemetry.startSpan(
        { name: "pi.durable.phase", attributes: { content: "secret" } },
        async () => undefined
      )
    ).rejects.toThrow(/content-free/);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("provides a no-op context", async () => {
    const telemetry = createNoopPiTelemetryContext();
    await expect(
      telemetry.startSpan({ name: "pi.durable.submit" }, async (span) => {
        span.setAttributes({ milestone: "x" });
        span.addEvent("pi.durable.entry", { "entry.id": 1 });
        span.setStatus({ status: "ok" });
      })
    ).resolves.toBeUndefined();
  });

  it("derives an opaque trace id", () => {
    expect(createPiTraceId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
