/**
 * GET /sessions/export — bulk session-trace export as newline-delimited JSON.
 *
 * Streams one JSON object per session (with its messages inlined when
 * `include=messages`), so deployers can pipe analytics extraction without
 * the control plane buffering the whole result set. Authorization matches
 * GET /sessions and GET /sessions/:id/messages exactly: the `sessions.read`
 * permission over the user-or-service authentication policy — no session is
 * exported that the caller could not already read through those surfaces.
 *
 * Line types: `session` (complete record), `session_error` (a session whose
 * messages could not be fetched — emitted instead of a partial record, and
 * the stream continues with the next session), `cursor` (pagination), and
 * `error` (stream-level failure after which the stream closes).
 */

import { Hono } from "hono";
import { z } from "zod";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { SessionExportStore, type SessionExportRow } from "../db/session-export-store";
import {
  encodeSessionExportCursor,
  parseSessionExportCursor,
} from "../db/session-export-cursor";
import { SessionInternalPaths } from "../session/contracts";
import type { SessionRuntimeClient } from "../session/runtime-client";
import { error, GITHUB_USER_OR_SERVICE_ROUTE, requirePermission } from "./shared";
import { parseQuery } from "./query";
import { dispatchSession, type SessionRouteContext } from "./session-route";
import { createLogger } from "../logger";

export const EXPORT_SCHEMA_VERSION = 1;
const DEFAULT_EXPORT_LIMIT = 100;
const MAX_EXPORT_LIMIT = 500;
/** Per-session message page size; the DO caps it at 100. */
const EXPORT_MESSAGE_PAGE_LIMIT = 100;
/** Hard cap on message pages per session, bounding a misbehaving runtime. */
export const MAX_MESSAGE_PAGES_PER_SESSION = 1000;

interface ExportedMessage {
  id: string;
  authorId: string;
  content: string;
  source: string;
  status: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

interface MessageListResponse {
  messages: ExportedMessage[];
  cursor?: string;
  hasMore: boolean;
}

/** Non-empty decimal string → safe non-negative integer (epoch ms). Empty strings must fail, not coerce to 0. */
function epochMsQuery(paramName: string) {
  return z
    .string()
    .refine((raw) => /^\d+$/.test(raw), {
      error: `${paramName} must be a non-negative integer (epoch ms)`,
    })
    .transform((raw) => Number(raw))
    .refine((value) => Number.isSafeInteger(value), {
      error: `${paramName} must be a safe integer`,
    });
}

const exportQuerySchema = z.object({
  cursor: z.string().min(1, { error: "Invalid cursor" }).optional(),
  limit: z
    .string()
    .optional()
    .transform((raw) => (raw === undefined ? DEFAULT_EXPORT_LIMIT : Number(raw)))
    .refine((value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_EXPORT_LIMIT, {
      error: `limit must be an integer between 1 and ${MAX_EXPORT_LIMIT}`,
    }),
  include: z.enum(["messages"], { error: "include must be messages" }).optional(),
  createdAfter: epochMsQuery("createdAfter").optional(),
  createdBefore: epochMsQuery("createdBefore").optional(),
});

function exportLine(row: SessionExportRow, messages?: ExportedMessage[]): string {
  return (
    JSON.stringify({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      type: "session",
      id: row.id,
      title: row.title,
      status: row.status,
      source: row.source,
      repoOwner: row.repoOwner,
      repoName: row.repoName,
      model: row.model,
      userId: row.userId,
      automationId: row.automationId,
      messageCount: row.messageCount,
      totalCost: row.totalCost,
      activeDurationMs: row.activeDurationMs,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(messages ? { messages } : {}),
    }) + "\n"
  );
}

function cursorLine(nextCursor: string): string {
  return (
    JSON.stringify({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      type: "cursor",
      nextCursor,
    }) + "\n"
  );
}

/** Typed, session-scoped error record — no partial session/message data. */
function sessionErrorLine(
  sessionId: string,
  reason: MessageFetchFailureReason,
  status?: number
): string {
  return (
    JSON.stringify({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      type: "session_error",
      sessionId,
      reason,
      ...(status !== undefined ? { status } : {}),
    }) + "\n"
  );
}

/**
 * Result of fetching one session's full message history. Failures are
 * discriminated so the stream can emit a session-scoped error record and
 * continue, instead of serializing a partial message list as complete data.
 */
type MessageFetchFailureReason = "http_error" | "page_cap_reached" | "runtime_failure";
type MessageFetchResult =
  | { ok: true; messages: ExportedMessage[] }
  | { ok: false; reason: MessageFetchFailureReason; status?: number };

/** Fetch every message of one session from its runtime, paging via the DO cursor. */
async function fetchAllMessages(
  runtime: SessionRuntimeClient,
  sessionId: string,
  log: { warn: (message: string, fields: Record<string, unknown>) => void }
): Promise<MessageFetchResult> {
  const messages: ExportedMessage[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_MESSAGE_PAGES_PER_SESSION; page++) {
      const search = new URLSearchParams({ limit: String(EXPORT_MESSAGE_PAGE_LIMIT) });
      if (cursor) search.set("cursor", cursor);
      const response = await runtime.fetch(sessionId, SessionInternalPaths.messages, undefined, `?${search}`);
      if (!response.ok) {
        log.warn("session_export.message_page_failed", {
          session_id: sessionId,
          status: response.status,
        });
        return { ok: false, reason: "http_error", status: response.status };
      }
      let body: MessageListResponse;
      try {
        body = (await response.json()) as MessageListResponse;
      } catch {
        log.warn("session_export.message_page_unreadable", { session_id: sessionId });
        return { ok: false, reason: "runtime_failure" };
      }
      if (!Array.isArray(body.messages)) {
        log.warn("session_export.message_page_invalid_shape", { session_id: sessionId });
        return { ok: false, reason: "runtime_failure" };
      }
      messages.push(...body.messages);
      if (!body.hasMore || !body.cursor) return { ok: true, messages };
      cursor = body.cursor;
    }
  } catch (e) {
    log.warn("session_export.message_runtime_failure", {
      session_id: sessionId,
      error: e instanceof Error ? e.message : String(e),
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

  const parsedCursor = parseSessionExportCursor(query.cursor);
  if (!parsedCursor.ok) return error(parsedCursor.error, 400);

  const log = createLogger("session-export");
  const store = new SessionExportStore(ctx.db);
  const includeMessages = query.include === "messages";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        const page = await store.list({
          cursor: parsedCursor.cursor,
          limit: query.limit,
          ...(query.createdAfter !== undefined ? { createdAfter: query.createdAfter } : {}),
          ...(query.createdBefore !== undefined ? { createdBefore: query.createdBefore } : {}),
        });
        for (const row of page.sessions) {
          if (!includeMessages) {
            controller.enqueue(encoder.encode(exportLine(row)));
            continue;
          }
          const result = await fetchAllMessages(ctx.sessionRuntime, row.id, log);
          if (result.ok) {
            controller.enqueue(encoder.encode(exportLine(row, result.messages)));
          } else {
            controller.enqueue(encoder.encode(sessionErrorLine(row.id, result.reason, result.status)));
          }
        }
        if (page.hasMore && page.sessions.length > 0) {
          const last = page.sessions[page.sessions.length - 1];
          controller.enqueue(
            encoder.encode(cursorLine(encodeSessionExportCursor({ createdAt: last.createdAt, id: last.id })))
          );
        }
      } catch (e) {
        log.error("session_export.stream_failed", {
          error: e instanceof Error ? e.message : String(e),
        });
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ schemaVersion: EXPORT_SCHEMA_VERSION, type: "error" }) + "\n"
          )
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "private, no-store",
    },
  });
}

const EXPORT_READ = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("sessions.read"),
});

export const sessionExportRoutes = new Hono<ControlPlaneHonoEnv>();

sessionExportRoutes.get("/sessions/export", EXPORT_READ, (c) =>
  dispatchSession(c, handleExport)
);
