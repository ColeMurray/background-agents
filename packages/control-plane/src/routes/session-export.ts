/**
 * GET /sessions/export - bulk session-trace export as newline-delimited JSON.
 *
 * Each line is a complete session, a session-scoped include error, a page
 * cursor, or a terminal stream error. `include` inlines a session's messages,
 * timeline events and per-step usage, which the session runtime reads in one
 * storage snapshot under one byte budget and page cap. A failed read never
 * turns a partial trace into a successful session record. Schema 1 session
 * lines gain additive fields; consumers must ignore fields they do not
 * recognize.
 * With `scope=runs`, root creation time defines the window. Families stay
 * consecutive across pages, but can cross page boundaries: limit still counts
 * sessions (at most five with include). Rows whose root no longer exists are
 * excluded by the root join.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  encodeRunsExportCursor,
  encodeSessionExportCursor,
  parseRunsExportCursor,
  parseSessionExportCursor,
} from "../db/session-export-cursor";
import {
  SessionExportStore,
  type ExportSelection,
  type SessionExportRow,
} from "../db/session-export-store";
import { createLogger, type Logger } from "../logger";
import { readBoundedBytes } from "../http/bounded-body";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  MAX_INCLUDED_BYTES_PER_SESSION,
  SessionInternalPaths,
  sessionTraceExportSchema,
  sessionTraceFormatSchema,
  sessionTraceIncludeSchema,
  type SessionTrace,
  type SessionTraceCollection,
  type SessionTraceFormat,
} from "../session/contracts";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { parseQuery } from "./query";
import { dispatchSession, type SessionRouteContext } from "./session-route";
import { error, SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, requirePermission } from "./shared";

export const EXPORT_SCHEMA_VERSION = 1;
const DEFAULT_EXPORT_LIMIT = 100;
const MAX_EXPORT_LIMIT = 500;
export const MAX_INCLUDED_EXPORT_LIMIT = 5;
const TRACE_READ_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();

function epochMsQuery(paramName: string) {
  return z
    .string()
    .regex(/^\d+$/, { error: `${paramName} must be a non-negative integer (epoch ms)` })
    .transform(Number)
    .refine(Number.isSafeInteger, { error: `${paramName} must be a safe integer` });
}

const exportQuerySchema = z.object({
  scope: z.enum(["sessions", "runs"]).default("sessions"),
  cursor: z.string().optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d*$/, { error: "Invalid limit" })
    .transform(Number)
    .refine((value) => Number.isSafeInteger(value) && value <= MAX_EXPORT_LIMIT, {
      error: `limit must be an integer between 1 and ${MAX_EXPORT_LIMIT}`,
    })
    .optional(),
  include: sessionTraceIncludeSchema.optional(),
  format: sessionTraceFormatSchema.optional(),
  createdAfter: epochMsQuery("createdAfter").optional(),
  createdBefore: epochMsQuery("createdBefore").optional(),
});

type TraceReadFailure =
  | { ok: false; reason: "http_error"; status: number }
  | {
      ok: false;
      reason: "runtime_failure" | "page_cap_reached" | "message_budget_exceeded";
    };
type TraceReadResult = { ok: true; trace: SessionTrace } | TraceReadFailure;

type SessionExportLine = {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  type: "session";
} & SessionExportRow &
  SessionTrace;
type SessionErrorLineBase = {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  type: "session_error";
  sessionId: string;
};
type SessionErrorLine = SessionErrorLineBase &
  (
    | { reason: "http_error"; status: number }
    | { reason: "runtime_failure" | "page_cap_reached" | "message_budget_exceeded" }
  );
type ExportLine =
  | SessionExportLine
  | SessionErrorLine
  | {
      schemaVersion: typeof EXPORT_SCHEMA_VERSION;
      type: "cursor";
      nextCursor: string;
    }
  | { schemaVersion: typeof EXPORT_SCHEMA_VERSION; type: "error" };

function encodeLine(line: ExportLine): Uint8Array {
  return encoder.encode(`${JSON.stringify(line)}\n`);
}

function sessionLine(row: SessionExportRow, trace?: SessionTrace): SessionExportLine {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    type: "session",
    ...row,
    ...trace,
  };
}

function sessionErrorLine(sessionId: string, failure: TraceReadFailure): SessionErrorLine {
  const line: SessionErrorLineBase = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    type: "session_error",
    sessionId,
  };
  return failure.reason === "http_error"
    ? { ...line, reason: failure.reason, status: failure.status }
    : { ...line, reason: failure.reason };
}

async function readBoundedJson(
  response: Response,
  maxBytes: number
): Promise<{ value: unknown } | null> {
  const result = await readBoundedBytes(
    response.body,
    maxBytes,
    response.headers.get("content-length")
  );
  return result.ok
    ? { value: JSON.parse(new TextDecoder().decode(result.bytes)) as unknown }
    : null;
}

/** Reads one session's included collections from its runtime in a single snapshot. */
async function readTrace(
  runtime: SessionRuntimeClient,
  sessionId: string,
  include: readonly SessionTraceCollection[],
  format: SessionTraceFormat | undefined,
  log: Pick<Logger, "warn">,
  signal: AbortSignal
): Promise<TraceReadResult> {
  try {
    const response = await runtime.fetch(
      sessionId,
      SessionInternalPaths.traceExport,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(TRACE_READ_TIMEOUT_MS)]) },
      `?${new URLSearchParams({ include: include.join(","), ...(format ? { format } : {}) })}`
    );
    if (!response.ok) {
      log.warn("session_export.trace_read_failed", {
        session_id: sessionId,
        status: response.status,
      });
      return { ok: false, reason: "http_error", status: response.status };
    }

    const body = await readBoundedJson(response, MAX_INCLUDED_BYTES_PER_SESSION);
    if (!body) {
      log.warn("session_export.trace_budget_exceeded", { session_id: sessionId });
      return { ok: false, reason: "message_budget_exceeded" };
    }

    const parsed = sessionTraceExportSchema.safeParse(body.value);
    if (!parsed.success) {
      log.warn("session_export.trace_invalid", {
        session_id: sessionId,
        error: parsed.error.issues[0]?.message,
      });
      return { ok: false, reason: "runtime_failure" };
    }
    if (!parsed.data.ok) {
      log.warn("session_export.trace_limit_reached", {
        session_id: sessionId,
        reason: parsed.data.reason,
      });
    }
    return parsed.data;
  } catch (caught) {
    if (signal.aborted) throw caught;
    log.warn("session_export.trace_runtime_failure", {
      session_id: sessionId,
      error: caught instanceof Error ? caught.message : String(caught),
    });
    return { ok: false, reason: "runtime_failure" };
  }
}

async function handleExport(
  request: Request,
  _env: Env,
  _params: object,
  ctx: SessionRouteContext
): Promise<Response> {
  const query = parseQuery(request, exportQuerySchema);
  if (query instanceof Response) return query;
  let selection: ExportSelection;
  if (query.scope === "runs") {
    const parsed = parseRunsExportCursor(query.cursor);
    if (!parsed.ok) return error(parsed.error, 400);
    selection = { scope: "runs", cursor: parsed.cursor };
  } else {
    const parsed = parseSessionExportCursor(query.cursor);
    if (!parsed.ok) return error(parsed.error, 400);
    selection = { scope: "sessions", cursor: parsed.cursor };
  }

  const include = query.include ?? [];
  const limit =
    query.limit ?? (include.length > 0 ? MAX_INCLUDED_EXPORT_LIMIT : DEFAULT_EXPORT_LIMIT);
  if (include.length > 0 && limit > MAX_INCLUDED_EXPORT_LIMIT) {
    return error(`limit must be at most ${MAX_INCLUDED_EXPORT_LIMIT} when include is set`, 400);
  }

  const log = createLogger("session-export");
  const store = new SessionExportStore(ctx.db);
  const streamAbort = new AbortController();
  const signal = AbortSignal.any([request.signal, streamAbort.signal]);
  let cancelled = false;
  let closed = false;
  let page: Awaited<ReturnType<SessionExportStore["list"]>> | undefined;
  let sessionIndex = 0;

  const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed || cancelled) return;
    closed = true;
    controller.close();
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed || cancelled) return;
      if (signal.aborted) {
        close(controller);
        return;
      }

      try {
        page ??= await store.list({
          ...selection,
          limit,
          ...(query.createdAfter === undefined ? {} : { createdAfter: query.createdAfter }),
          ...(query.createdBefore === undefined ? {} : { createdBefore: query.createdBefore }),
        });

        const row = page.sessions[sessionIndex++];
        if (row) {
          if (include.length === 0) {
            controller.enqueue(encodeLine(sessionLine(row)));
            return;
          }

          const result = await readTrace(
            ctx.sessionRuntime,
            row.id,
            include,
            query.format,
            log,
            signal
          );
          controller.enqueue(
            encodeLine(
              result.ok ? sessionLine(row, result.trace) : sessionErrorLine(row.id, result)
            )
          );
          return;
        }

        if (page.nextCursor) {
          controller.enqueue(
            encodeLine({
              schemaVersion: EXPORT_SCHEMA_VERSION,
              type: "cursor",
              nextCursor:
                page.scope === "runs"
                  ? encodeRunsExportCursor(page.nextCursor)
                  : encodeSessionExportCursor(page.nextCursor),
            })
          );
          close(controller);
          return;
        }

        close(controller);
      } catch (caught) {
        if (cancelled) return;
        if (signal.aborted) {
          close(controller);
          return;
        }
        log.error("session_export.stream_failed", {
          error: caught instanceof Error ? caught.message : String(caught),
        });
        controller.enqueue(encodeLine({ schemaVersion: EXPORT_SCHEMA_VERSION, type: "error" }));
        close(controller);
      }
    },
    cancel() {
      cancelled = true;
      streamAbort.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

const EXPORT_READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("sessions.export"),
  cacheControl: "private, no-store",
});

export const sessionExportRoutes = new Hono<ControlPlaneHonoEnv>();

sessionExportRoutes.get("/sessions/export", EXPORT_READ, (c) => dispatchSession(c, handleExport));
