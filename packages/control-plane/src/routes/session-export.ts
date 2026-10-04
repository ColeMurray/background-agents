/**
 * GET /sessions/export and /sessions/:id/export - session-trace NDJSON.
 *
 * Each line is a complete session, a session-scoped include error, a page
 * cursor, or a terminal stream error. `include` inlines a session's messages,
 * timeline events and per-step usage, which the session runtime reads in one
 * storage snapshot under one byte budget and page cap. A failed read never
 * turns a partial trace into a successful session record.
 * With `scope=runs`, root creation time defines the window. Families stay
 * consecutive across pages, but can cross page boundaries: limit still counts
 * sessions (at most five with include). Rows whose root no longer exists are
 * excluded by the root join. This is a best-effort export, not a snapshot:
 * the first page's MAX(rowid) fences inserts unless deletion of the newest
 * session lets SQLite reuse its rowid. Deletions are not fenced; deleting a
 * root mid-export re-roots its children and may leave that run incomplete.
 * Re-exporting a window covering the new root reflects its current lineage.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  TRACE_EXPORT_SCHEMA_VERSION,
  type TraceExportLine,
} from "@open-inspect/shared/types/trace-export";
import {
  encodeRunsExportCursor,
  encodeSessionExportCursor,
  parseRunsExportCursor,
  parseSessionExportCursor,
} from "../db/session-export-cursor";
import {
  DEFAULT_EXPORT_LIMIT,
  SessionExportStore,
  type ExportSelection,
  type SessionExportRow,
} from "../db/session-export-store";
import { createLogger, type Logger } from "../logger";
import { teamsEnforcementMode } from "../authorization/session-admission";
import { resourceViewer } from "../authorization/resource-viewer";
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
import {
  error,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  requirePermission,
  requireAll,
  permissionRequirement,
  sessionRequirement,
} from "./shared";

export const EXPORT_SCHEMA_VERSION = TRACE_EXPORT_SCHEMA_VERSION;
const MAX_EXPORT_LIMIT = 500;
export const MAX_INCLUDED_EXPORT_LIMIT = 5;
const TRACE_READ_TIMEOUT_MS = 10_000;
const FULL_TRACE_INCLUDE: readonly SessionTraceCollection[] = ["messages", "events", "usage"];
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

const singleExportQuerySchema = exportQuerySchema.pick({
  include: true,
  format: true,
});

type TraceReadFailure =
  | { ok: false; reason: "http_error"; status: number }
  | {
      ok: false;
      reason: "runtime_failure" | "page_cap_reached" | "trace_budget_exceeded";
    };
type TraceReadResult = { ok: true; trace: SessionTrace } | TraceReadFailure;

type SessionExportLine = Extract<TraceExportLine, { type: "session" }>;
type SessionErrorLine = Extract<TraceExportLine, { type: "session_error" }>;
type ExportLine = TraceExportLine;

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
  const line = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    type: "session_error",
    sessionId,
  } satisfies Pick<SessionErrorLine, "schemaVersion" | "type" | "sessionId">;
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
      return { ok: false, reason: "trace_budget_exceeded" };
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

type ExportRecord = SessionExportRow | { nextCursor: string };

function streamExport(
  request: Request,
  ctx: SessionRouteContext,
  include: readonly SessionTraceCollection[],
  format: SessionTraceFormat | undefined,
  records: AsyncIterator<ExportRecord>
): Response {
  const log = createLogger("session-export");
  const streamAbort = new AbortController();
  const signal = AbortSignal.any([request.signal, streamAbort.signal]);
  let cancelled = false;
  let closed = false;

  const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed || cancelled) return;
    closed = true;
    controller.close();
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed || cancelled) return;
      if (signal.aborted) return close(controller);

      try {
        const { value, done } = await records.next();
        if (cancelled) return;
        if (signal.aborted) return close(controller);
        if (done) return close(controller);
        if ("nextCursor" in value) {
          controller.enqueue(
            encodeLine({
              schemaVersion: EXPORT_SCHEMA_VERSION,
              type: "cursor",
              nextCursor: value.nextCursor,
            })
          );
          close(controller);
          return;
        }

        if (include.length === 0) {
          controller.enqueue(encodeLine(sessionLine(value)));
          return;
        }

        const result = await readTrace(ctx.sessionRuntime, value.id, include, format, log, signal);
        controller.enqueue(
          encodeLine(
            result.ok ? sessionLine(value, result.trace) : sessionErrorLine(value.id, result)
          )
        );
      } catch (caught) {
        if (cancelled) return;
        if (signal.aborted) return close(controller);
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

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
}

async function handleExport(
  request: Request,
  env: Env,
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

  const store = new SessionExportStore(ctx.db);
  const mode = teamsEnforcementMode(ctx, env);
  const viewer = await resourceViewer(ctx);
  const { createdAfter, createdBefore } = query;
  async function* records(): AsyncGenerator<ExportRecord> {
    const page = await store.list({
      ...selection,
      readScope: viewer,
      mode,
      limit,
      ...(createdAfter === undefined ? {} : { createdAfter }),
      ...(createdBefore === undefined ? {} : { createdBefore }),
    });
    yield* page.sessions;
    if (page.nextCursor) {
      yield {
        nextCursor:
          page.scope === "runs"
            ? encodeRunsExportCursor(page.nextCursor)
            : encodeSessionExportCursor(page.nextCursor),
      };
    }
  }

  return streamExport(request, ctx, include, query.format, records());
}

async function handleSingleExport(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const query = parseQuery(request, singleExportQuerySchema);
  if (query instanceof Response) return query;
  if (new URL(request.url).searchParams.has("scope")) return error("scope is not supported", 400);

  const store = new SessionExportStore(ctx.db);
  const selected = await store.get(params.id);
  if (!selected) return error("Session not found", 404);

  const include = query.include ?? FULL_TRACE_INCLUDE;
  const session = selected;
  async function* records(): AsyncGenerator<ExportRecord> {
    yield session;
  }

  return streamExport(request, ctx, include, query.format, records());
}

const EXPORT_READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("sessions.export"),
  cacheControl: "private, no-store",
});

export const sessionExportRoutes = new Hono<ControlPlaneHonoEnv>();

sessionExportRoutes.get("/sessions/export", EXPORT_READ, (c) => dispatchSession(c, handleExport));
sessionExportRoutes.get(
  "/sessions/:id/export",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: requireAll(sessionRequirement("read"), permissionRequirement("sessions.export")),
    cacheControl: "private, no-store",
  }),
  (c) => dispatchSession(c, handleSingleExport)
);
