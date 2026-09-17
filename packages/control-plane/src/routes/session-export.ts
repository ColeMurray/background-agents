/**
 * GET /sessions/export - bulk session-trace export as newline-delimited JSON.
 *
 * Each line is a complete session, a session-scoped message error, a page
 * cursor, or a terminal stream error. Message failures never turn partial
 * histories into successful session records.
 */

import type { SessionMessage } from "@open-inspect/shared/types/sessions";
import { Hono } from "hono";
import { z } from "zod";
import { encodeSessionExportCursor, parseSessionExportCursor } from "../db/session-export-cursor";
import { SessionExportStore, type SessionExportRow } from "../db/session-export-store";
import { createLogger, type Logger } from "../logger";
import { readBoundedBytes } from "../http/bounded-body";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths, sessionMessagePageSchema } from "../session/contracts";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { parseQuery } from "./query";
import { dispatchSession, type SessionRouteContext } from "./session-route";
import { error, GITHUB_USER_OR_SERVICE_ROUTE, requirePermission } from "./shared";

export const EXPORT_SCHEMA_VERSION = 1;
const DEFAULT_EXPORT_LIMIT = 100;
const MAX_EXPORT_LIMIT = 500;
export const MAX_MESSAGE_EXPORT_LIMIT = 5;
const EXPORT_MESSAGE_PAGE_LIMIT = 100;
export const MAX_MESSAGE_PAGES_PER_SESSION = 25;
export const MAX_MESSAGE_BYTES_PER_SESSION = 4 * 1024 * 1024;
const MESSAGE_PAGE_TIMEOUT_MS = 10_000;
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
  include: z.enum(["messages"], { error: "include must be messages" }).optional(),
  createdAfter: epochMsQuery("createdAfter").optional(),
  createdBefore: epochMsQuery("createdBefore").optional(),
});

type MessageFetchFailure =
  | { ok: false; reason: "http_error"; status: number }
  | {
      ok: false;
      reason: "runtime_failure" | "page_cap_reached" | "message_budget_exceeded";
    };
type MessageFetchResult = { ok: true; messages: SessionMessage[] } | MessageFetchFailure;
type BoundedJson = { value: unknown; byteLength: number } | null;

type SessionExportLine = {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  type: "session";
  messages?: SessionMessage[];
} & SessionExportRow;
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

function sessionLine(row: SessionExportRow, messages?: SessionMessage[]): SessionExportLine {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    type: "session",
    ...row,
    ...(messages === undefined ? {} : { messages }),
  };
}

function sessionErrorLine(sessionId: string, failure: MessageFetchFailure): SessionErrorLine {
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

async function fetchAllMessages(
  runtime: SessionRuntimeClient,
  sessionId: string,
  log: Pick<Logger, "warn">,
  signal: AbortSignal
): Promise<MessageFetchResult> {
  const messages: SessionMessage[] = [];
  const seenCursors = new Set<string>();
  let messageBytes = 0;
  let responseBytes = 0;
  let cursor: string | undefined;

  try {
    for (let page = 0; page < MAX_MESSAGE_PAGES_PER_SESSION; page++) {
      const search = new URLSearchParams({ limit: String(EXPORT_MESSAGE_PAGE_LIMIT) });
      if (cursor) search.set("cursor", cursor);
      const response = await runtime.fetch(
        sessionId,
        SessionInternalPaths.messages,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(MESSAGE_PAGE_TIMEOUT_MS)]) },
        `?${search}`
      );
      if (!response.ok) {
        log.warn("session_export.message_page_failed", {
          session_id: sessionId,
          status: response.status,
        });
        return { ok: false, reason: "http_error", status: response.status };
      }

      const pageBody = await readBoundedJson(
        response,
        MAX_MESSAGE_BYTES_PER_SESSION - responseBytes
      );
      if (!pageBody) {
        log.warn("session_export.message_budget_exceeded", { session_id: sessionId });
        return { ok: false, reason: "message_budget_exceeded" };
      }
      responseBytes += pageBody.byteLength;

      const parsed = sessionMessagePageSchema.safeParse(pageBody.value);
      if (!parsed.success) {
        log.warn("session_export.message_page_invalid", {
          session_id: sessionId,
          error: parsed.error.issues[0]?.message,
        });
        return { ok: false, reason: "runtime_failure" };
      }

      for (const message of parsed.data.messages) {
        messageBytes += encoder.encode(JSON.stringify(message)).byteLength + 1;
        if (messageBytes > MAX_MESSAGE_BYTES_PER_SESSION) {
          log.warn("session_export.message_budget_exceeded", { session_id: sessionId });
          return { ok: false, reason: "message_budget_exceeded" };
        }
        messages.push(message);
      }

      if (!parsed.data.hasMore) return { ok: true, messages };
      if (seenCursors.has(parsed.data.cursor)) {
        log.warn("session_export.message_cursor_repeated", { session_id: sessionId });
        return { ok: false, reason: "runtime_failure" };
      }
      seenCursors.add(parsed.data.cursor);
      cursor = parsed.data.cursor;
    }
  } catch (caught) {
    if (signal.aborted) throw caught;
    log.warn("session_export.message_runtime_failure", {
      session_id: sessionId,
      error: caught instanceof Error ? caught.message : String(caught),
    });
    return { ok: false, reason: "runtime_failure" };
  }

  log.warn("session_export.message_page_cap_reached", { session_id: sessionId });
  return { ok: false, reason: "page_cap_reached" };
}

async function handleExport(
  request: Request,
  _env: Env,
  _params: object,
  ctx: SessionRouteContext
): Promise<Response> {
  const query = parseQuery(request, exportQuerySchema);
  if (query instanceof Response) return query;

  const includeMessages = query.include === "messages";
  const limit = query.limit ?? (includeMessages ? MAX_MESSAGE_EXPORT_LIMIT : DEFAULT_EXPORT_LIMIT);
  if (includeMessages && limit > MAX_MESSAGE_EXPORT_LIMIT) {
    return error(`limit must be at most ${MAX_MESSAGE_EXPORT_LIMIT} when include=messages`, 400);
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
          if (!includeMessages) {
            controller.enqueue(encodeLine(sessionLine(row)));
            return;
          }

          const result = await fetchAllMessages(ctx.sessionRuntime, row.id, log, signal);
          controller.enqueue(
            encodeLine(
              result.ok ? sessionLine(row, result.messages) : sessionErrorLine(row.id, result)
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
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("sessions.read"),
  cacheControl: "private, no-store",
});

export const sessionExportRoutes = new Hono<ControlPlaneHonoEnv>();

sessionExportRoutes.get("/sessions/export", EXPORT_READ, (c) => dispatchSession(c, handleExport));
