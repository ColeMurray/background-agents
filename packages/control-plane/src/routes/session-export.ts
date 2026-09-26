/**
 * GET /sessions/export - bulk session-trace export as newline-delimited JSON.
 *
 * Each line is a complete session, a session-scoped include error, a page
 * cursor, or a terminal stream error. `include` inlines a session's messages,
 * timeline events and per-step usage, each oldest first; together they share
 * one byte budget and one page cap per session. A failed collection never
 * turns a partial trace into a successful session record. Schema 1 session
 * lines gain additive fields; consumers must ignore fields they do not
 * recognize.
 */

import type { StepUsage } from "@open-inspect/shared";
import type { EventResponse } from "@open-inspect/shared/types/sandbox-events";
import type { SessionMessage } from "@open-inspect/shared/types/sessions";
import { Hono } from "hono";
import { z } from "zod";
import { encodeSessionExportCursor, parseSessionExportCursor } from "../db/session-export-cursor";
import { SessionExportStore, type SessionExportRow } from "../db/session-export-store";
import { createLogger, type Logger } from "../logger";
import { readBoundedBytes } from "../http/bounded-body";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  SessionInternalPaths,
  sessionEventPageSchema,
  sessionMessagePageSchema,
  stepUsagePageSchema,
  type SessionInternalPath,
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
const INCLUDED_PAGE_LIMIT = 100;
export const MAX_INCLUDED_PAGES_PER_SESSION = 25;
export const MAX_INCLUDED_BYTES_PER_SESSION = 4 * 1024 * 1024;
const INCLUDED_PAGE_TIMEOUT_MS = 10_000;
const INCLUDED_COLLECTIONS = ["messages", "events", "usage"] as const;
const encoder = new TextEncoder();

function epochMsQuery(paramName: string) {
  return z
    .string()
    .regex(/^\d+$/, { error: `${paramName} must be a non-negative integer (epoch ms)` })
    .transform(Number)
    .refine(Number.isSafeInteger, { error: `${paramName} must be a safe integer` });
}

const exportQuerySchema = z.object({
  cursor: z
    .string()
    .optional()
    .transform((raw, context) => {
      const parsed = parseSessionExportCursor(raw);
      if (!parsed.ok) {
        context.addIssue({ code: "custom", message: parsed.error });
        return z.NEVER;
      }
      return parsed.cursor;
    }),
  limit: z
    .string()
    .regex(/^[1-9]\d*$/, { error: "Invalid limit" })
    .transform(Number)
    .refine((value) => Number.isSafeInteger(value) && value <= MAX_EXPORT_LIMIT, {
      error: `limit must be an integer between 1 and ${MAX_EXPORT_LIMIT}`,
    })
    .optional(),
  include: z
    .string()
    .transform((raw) => raw.split(","))
    .pipe(
      z.array(
        z.enum(INCLUDED_COLLECTIONS, {
          error: `include must be a comma-separated list of ${INCLUDED_COLLECTIONS.join(", ")}`,
        })
      )
    )
    .transform((requested) =>
      INCLUDED_COLLECTIONS.filter((collection) => requested.includes(collection))
    )
    .optional(),
  createdAfter: epochMsQuery("createdAfter").optional(),
  createdBefore: epochMsQuery("createdBefore").optional(),
});

type IncludedCollection = (typeof INCLUDED_COLLECTIONS)[number];
type IncludedCollections = {
  messages?: SessionMessage[];
  events?: EventResponse[];
  usage?: StepUsage[];
};
/** One runtime page reduced to its items and the cursor of the page after it. */
type IncludedPage<T> = { items: T[]; nextCursor: string | null };
/** What one session's included collections have consumed, together. */
type IncludedBudget = { pages: number; responseBytes: number; itemBytes: number };
type IncludedFetchFailure =
  | { ok: false; reason: "http_error"; status: number }
  | {
      ok: false;
      reason: "runtime_failure" | "page_cap_reached" | "message_budget_exceeded";
    };
type PagesFetchResult<T> = { ok: true; items: T[] } | IncludedFetchFailure;
type IncludedFetchResult = { ok: true; included: IncludedCollections } | IncludedFetchFailure;
type BoundedJson = { value: unknown; byteLength: number } | null;

const messagePageSchema = sessionMessagePageSchema.transform(
  (page): IncludedPage<SessionMessage> => ({
    items: page.messages,
    nextCursor: page.hasMore ? page.cursor : null,
  })
);
const eventPageSchema = sessionEventPageSchema.transform(
  (page): IncludedPage<EventResponse> => ({
    items: page.events,
    nextCursor: page.hasMore ? page.cursor : null,
  })
);
const usagePageSchema = stepUsagePageSchema.transform(
  (page): IncludedPage<StepUsage> => ({
    items: page.usage,
    nextCursor: page.hasMore ? page.cursor : null,
  })
);

type SessionExportLine = {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  type: "session";
} & SessionExportRow &
  IncludedCollections;
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

function sessionLine(row: SessionExportRow, included?: IncludedCollections): SessionExportLine {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    type: "session",
    ...row,
    ...included,
  };
}

function sessionErrorLine(sessionId: string, failure: IncludedFetchFailure): SessionErrorLine {
  const line: SessionErrorLineBase = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    type: "session_error",
    sessionId,
  };
  return failure.reason === "http_error"
    ? { ...line, reason: failure.reason, status: failure.status }
    : { ...line, reason: failure.reason };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<BoundedJson> {
  const result = await readBoundedBytes(
    response.body,
    maxBytes,
    response.headers.get("content-length")
  );
  return result.ok
    ? {
        value: JSON.parse(new TextDecoder().decode(result.bytes)) as unknown,
        byteLength: result.bytes.byteLength,
      }
    : null;
}

/**
 * Reads every page of one runtime collection, charging the session's shared
 * `budget`. Runtime pages run newest first; the items come back oldest first.
 */
async function fetchAllPages<T>(
  runtime: SessionRuntimeClient,
  sessionId: string,
  path: SessionInternalPath,
  pageSchema: z.ZodType<IncludedPage<T>>,
  budget: IncludedBudget,
  log: Pick<Logger, "warn">,
  signal: AbortSignal
): Promise<PagesFetchResult<T>> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  const logFields = { session_id: sessionId, path };
  let cursor: string | undefined;

  try {
    while (budget.pages < MAX_INCLUDED_PAGES_PER_SESSION) {
      budget.pages++;
      const search = new URLSearchParams({ limit: String(INCLUDED_PAGE_LIMIT) });
      if (cursor) search.set("cursor", cursor);
      const response = await runtime.fetch(
        sessionId,
        path,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(INCLUDED_PAGE_TIMEOUT_MS)]) },
        `?${search}`
      );
      if (!response.ok) {
        log.warn("session_export.page_failed", { ...logFields, status: response.status });
        return { ok: false, reason: "http_error", status: response.status };
      }

      const pageBody = await readBoundedJson(
        response,
        MAX_INCLUDED_BYTES_PER_SESSION - budget.responseBytes
      );
      if (!pageBody) {
        log.warn("session_export.budget_exceeded", logFields);
        return { ok: false, reason: "message_budget_exceeded" };
      }
      budget.responseBytes += pageBody.byteLength;

      const parsed = pageSchema.safeParse(pageBody.value);
      if (!parsed.success) {
        log.warn("session_export.page_invalid", {
          ...logFields,
          error: parsed.error.issues[0]?.message,
        });
        return { ok: false, reason: "runtime_failure" };
      }

      for (const item of parsed.data.items) {
        budget.itemBytes += encoder.encode(JSON.stringify(item)).byteLength + 1;
        if (budget.itemBytes > MAX_INCLUDED_BYTES_PER_SESSION) {
          log.warn("session_export.budget_exceeded", logFields);
          return { ok: false, reason: "message_budget_exceeded" };
        }
        items.push(item);
      }

      const { nextCursor } = parsed.data;
      if (nextCursor === null) return { ok: true, items: items.reverse() };
      if (seenCursors.has(nextCursor)) {
        log.warn("session_export.cursor_repeated", logFields);
        return { ok: false, reason: "runtime_failure" };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } catch (caught) {
    if (signal.aborted) throw caught;
    log.warn("session_export.runtime_failure", {
      ...logFields,
      error: caught instanceof Error ? caught.message : String(caught),
    });
    return { ok: false, reason: "runtime_failure" };
  }

  log.warn("session_export.page_cap_reached", logFields);
  return { ok: false, reason: "page_cap_reached" };
}

/** Fetches each included collection in turn against one budget for the session. */
async function fetchIncluded(
  runtime: SessionRuntimeClient,
  sessionId: string,
  include: readonly IncludedCollection[],
  log: Pick<Logger, "warn">,
  signal: AbortSignal
): Promise<IncludedFetchResult> {
  const budget: IncludedBudget = { pages: 0, responseBytes: 0, itemBytes: 0 };
  const fetchPages = <T>(path: SessionInternalPath, pageSchema: z.ZodType<IncludedPage<T>>) =>
    fetchAllPages(runtime, sessionId, path, pageSchema, budget, log, signal);
  const included: IncludedCollections = {};

  if (include.includes("messages")) {
    const result = await fetchPages(SessionInternalPaths.messages, messagePageSchema);
    if (!result.ok) return result;
    included.messages = result.items;
  }
  if (include.includes("events")) {
    const result = await fetchPages(SessionInternalPaths.events, eventPageSchema);
    if (!result.ok) return result;
    included.events = result.items;
  }
  if (include.includes("usage")) {
    const result = await fetchPages(SessionInternalPaths.usage, usagePageSchema);
    if (!result.ok) return result;
    included.usage = result.items;
  }
  return { ok: true, included };
}

async function handleExport(
  request: Request,
  _env: Env,
  _params: object,
  ctx: SessionRouteContext
): Promise<Response> {
  const query = parseQuery(request, exportQuerySchema);
  if (query instanceof Response) return query;

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
          cursor: query.cursor,
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

          const result = await fetchIncluded(ctx.sessionRuntime, row.id, include, log, signal);
          controller.enqueue(
            encodeLine(
              result.ok ? sessionLine(row, result.included) : sessionErrorLine(row.id, result)
            )
          );
          return;
        }

        if (page.nextCursor) {
          controller.enqueue(
            encodeLine({
              schemaVersion: EXPORT_SCHEMA_VERSION,
              type: "cursor",
              nextCursor: encodeSessionExportCursor(page.nextCursor),
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
