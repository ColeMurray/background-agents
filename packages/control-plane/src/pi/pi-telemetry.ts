/**
 * Pi telemetry for Open-Inspect.
 *
 * The span vocabulary mirrors upstream `DURABLE_TELEMETRY_SCHEMA` from
 * `@earendil-works/pi-durable` so Open-Inspect spans compose with Pi's own
 * spans once the Durable harness exposes its telemetry option. Upstream ships
 * the schema on its unreleased `main` branch; the published
 * `@earendil-works/pi-telemetry` package provides the
 * `TelemetryContext` contract used here.
 *
 * Attributes are content-free by construction: they carry identifiers,
 * durations, names, and outcomes. Prompts, tool arguments, tool output, and
 * credentials never reach a span.
 */

import {
  defineTelemetrySchema,
  type SpanAttributes,
  type SpanOptions,
  type SpanStatus,
  type TelemetryContext,
  type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import type { Logger } from "../logger";

/** Upstream-compatible span, event, and metric vocabulary. */
export const OPEN_INSPECT_PI_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    "pi.durable.submit": {
      description: "Open-Inspect admits one Pi submission on behalf of a session and commits it.",
      parents: { kind: "any" },
      startAttributes: {
        "submission.type": {
          type: "string",
          required: true,
          values: ["input", "write"],
          description: "Submission type.",
        },
        "conversation.id": {
          type: "number",
          required: false,
          description: "Pi conversation ID when known.",
          cardinality: "high",
        },
      },
      endAttributes: {
        "submission.id": {
          type: "number",
          description: "Admitted submission ID.",
          cardinality: "high",
        },
        result: {
          type: "string",
          values: ["queued", "placed", "done"],
          description: "Admission result.",
        },
      },
      status: { default: "ok", errorWhen: "Submission admission failed." },
    },
    "pi.durable.phase": {
      description: "One Open-Inspect projection phase: capture, publish, or terminal settlement.",
      parents: { kind: "any" },
      startAttributes: {
        "task.id": {
          type: "number",
          required: false,
          description: "Durable task ID when known.",
          cardinality: "high",
        },
        "task.name": { type: "string", required: true, description: "Task name." },
        phase: { type: "string", required: true, description: "Invoked phase." },
        kind: { type: "string", required: true, values: ["run", "abort"], description: "Kind." },
        resumed: {
          type: "boolean",
          required: true,
          description: "First invocation after a reopen.",
        },
      },
      endAttributes: {
        outcome: { type: "string", description: "Phase outcome." },
        duration_ms: { type: "number", description: "Phase duration in milliseconds." },
      },
      status: { default: "ok", errorWhen: "The phase failed." },
    },
    "pi.open-inspect.latency": {
      description: "One Open-Inspect Pi latency milestone, from ingress to terminal settlement.",
      parents: { kind: "any" },
      startAttributes: {
        milestone: { type: "string", required: true, description: "Milestone name." },
        harness: { type: "string", required: true, description: "Harness." },
        execution_backend: { type: "string", required: true, description: "Execution backend." },
      },
      endAttributes: {
        duration_ms: { type: "number", description: "Milestone duration in milliseconds." },
        result: { type: "string", description: "Milestone result." },
      },
      status: { default: "ok", errorWhen: "The milestone failed." },
    },
  },
});

/** Attribute names that must never appear in a span. */
const FORBIDDEN_ATTRIBUTE_KEYS = new Set([
  "prompt",
  "content",
  "arguments",
  "args",
  "output",
  "result_text",
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
  "secret",
]);

/**
 * Reject content-bearing attributes before they reach a sink.
 *
 * The check is a guardrail, not a parser: an unknown key is allowed, but a
 * known content-shaped key is refused so a future caller cannot quietly leak
 * a prompt into telemetry.
 */
export function assertContentFreeAttributes(attributes: SpanAttributes): void {
  for (const key of Object.keys(attributes)) {
    const normalized = key.toLowerCase();
    if (FORBIDDEN_ATTRIBUTE_KEYS.has(normalized)) {
      throw new Error(`Telemetry attribute is not content-free: ${key}`);
    }
  }
}

export interface PiTelemetryOptions {
  readonly logger: Logger;
  /** Correlates spans that belong to one Open-Inspect request. */
  readonly traceId?: string;
  readonly component?: string;
}

/**
 * A `TelemetryContext` that publishes spans as structured log records.
 *
 * It implements the published contract, so it can be handed to Pi Durable
 * directly once the harness exposes its telemetry option, and it is used today
 * for Open-Inspect's own Pi spans.
 */
export class OpenInspectPiTelemetryContext implements TelemetryContext {
  private nextSpanId = 1;
  private readonly parentSpanIds: number[] = [];

  constructor(private readonly options: PiTelemetryOptions) {}

  async startSpan<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>
  ): Promise<T> {
    const spanId = this.nextSpanId++;
    const parentSpanId = this.parentSpanIds.at(-1) ?? null;
    const startAttributes = { ...options.attributes };
    assertContentFreeAttributes(startAttributes);
    const startedAt = Date.now();
    const attributes: SpanAttributes = { ...startAttributes };
    const events: Array<{ name: string; attributes: SpanAttributes }> = [];
    let status: SpanStatus = { status: "ok" };
    this.parentSpanIds.push(spanId);
    const span: TelemetrySpan = {
      startSpan: async (_nested, nestedCallback) => this.startSpan(_nested, nestedCallback),
      addLink: (link) => {
        // This log adapter has no portable span identity to serialize. It
        // still validates link attributes so telemetry cannot become a
        // content escape hatch, then deliberately drops the correlation.
        assertContentFreeAttributes(link.attributes ?? {});
      },
      addEvent: (name, eventAttributes) => {
        assertContentFreeAttributes(eventAttributes ?? {});
        events.push({ name, attributes: { ...eventAttributes } });
      },
      setAttributes: (next) => {
        assertContentFreeAttributes(next);
        Object.assign(attributes, next);
      },
      setStatus: (next) => {
        status = next;
      },
    };
    try {
      return await callback(span);
    } catch (error) {
      status = {
        status: "error",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
      throw error;
    } finally {
      this.parentSpanIds.pop();
      this.options.logger.info("pi.telemetry", {
        event: "pi.telemetry",
        span: options.name,
        span_id: spanId,
        ...(parentSpanId === null ? {} : { parent_span_id: parentSpanId }),
        ...(this.options.traceId === undefined ? {} : { trace_id: this.options.traceId }),
        duration_ms: Date.now() - startedAt,
        status: status.status,
        ...attributes,
        ...(events.length === 0 ? {} : { events: events.map((event) => event.name) }),
      });
    }
  }
}

/** A telemetry context that records nothing. */
export function createNoopPiTelemetryContext(): TelemetryContext {
  return {
    startSpan: async (_options, callback) =>
      callback({
        startSpan: async (_nested, nestedCallback) => nestedCallback(noopSpan()),
        addLink: () => {},
        addEvent: () => {},
        setAttributes: () => {},
        setStatus: () => {},
      }),
  };
}

function noopSpan(): TelemetrySpan {
  return {
    startSpan: async (_options, callback) => callback(noopSpan()),
    addLink: () => {},
    addEvent: () => {},
    setAttributes: () => {},
    setStatus: () => {},
  };
}

/**
 * Derive the trace identifier that correlates Open-Inspect Pi spans.
 *
 * The value is opaque and carries no user content, so it is safe to place in
 * a request header between the SessionDO and the PiSessionDO.
 */
export function createPiTraceId(): string {
  return crypto.randomUUID();
}
