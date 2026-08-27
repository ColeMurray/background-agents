/**
 * The read-only tool surface.
 *
 * Every tool is one GET against a route whose policy already accepts service
 * auth. Nothing here mutates, and nothing here needs an actor — and the
 * control plane refuses this credential any mutating method regardless.
 */

import { z } from "zod";
import type { ControlPlaneClient } from "./client";

/**
 * Page caps, matching what the control-plane handlers themselves enforce.
 * Asking past a server cap is silently clamped, which reads as a short page
 * and invites the model to conclude there is nothing more.
 */
const MAX_EVENT_LIMIT = 200;
const DEFAULT_EVENT_LIMIT = 100;

const MAX_MESSAGE_LIMIT = 100;

const MAX_SESSION_LIMIT = 100;
const DEFAULT_SESSION_LIMIT = 20;

/** Every paged tool takes the same continuation argument. */
const cursor = z
  .string()
  .optional()
  .describe("Continuation cursor from a previous page of this same call");

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  run(client: ControlPlaneClient, args: Record<string, unknown>): Promise<unknown>;
}

const sessionId = z.string().min(1).describe("Session id, as returned by list_sessions");

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_sessions",
    title: "List sessions",
    description:
      "List Open-Inspect sessions, newest first. Use to find a session id before reading its " +
      "events or diff. Filter by status to narrow to active or failed work.",
    inputSchema: {
      status: z
        .enum(["created", "active", "completed", "failed", "archived", "cancelled"])
        .optional()
        .describe("Only sessions in this status. In-flight work is `active`, not `running`."),
      limit: z.number().int().min(1).max(MAX_SESSION_LIMIT).optional(),
      offset: z.number().int().min(0).optional(),
    },
    run: (client, args) =>
      client.get("/sessions", {
        status: args.status as string | undefined,
        limit: (args.limit as number | undefined) ?? DEFAULT_SESSION_LIMIT,
        offset: args.offset as number | undefined,
      }),
  },
  {
    name: "get_session_events",
    title: "Read a session timeline",
    description:
      "Read one session's event timeline — tool calls, agent output, errors. This is the " +
      "primary tool for working out what a session actually did and where it went wrong. Returns one page; pass the response's cursor back to continue.",
    inputSchema: {
      session_id: sessionId,
      limit: z.number().int().min(1).max(MAX_EVENT_LIMIT).optional(),
      cursor,
    },
    run: (client, args) =>
      client.get(`/sessions/${encodeURIComponent(args.session_id as string)}/events`, {
        limit: (args.limit as number | undefined) ?? DEFAULT_EVENT_LIMIT,
        cursor: args.cursor as string | undefined,
      }),
  },
  {
    name: "get_session_messages",
    title: "Read session messages",
    description:
      "Read the prompt/response messages exchanged in one session, without the tool-call " +
      "detail that get_session_events includes.",
    inputSchema: {
      session_id: sessionId,
      limit: z.number().int().min(1).max(MAX_MESSAGE_LIMIT).optional(),
      cursor,
    },
    run: (client, args) =>
      client.get(`/sessions/${encodeURIComponent(args.session_id as string)}/messages`, {
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      }),
  },
  {
    name: "get_session_diff",
    title: "Read a session's diff",
    description: "Read the working-tree diff a session produced, as a list of changed files.",
    inputSchema: { session_id: sessionId },
    run: (client, args) =>
      client.get(`/sessions/${encodeURIComponent(args.session_id as string)}/diff`),
  },
  {
    name: "list_automation_runs",
    title: "List automation invocations",
    description:
      "List one automation's recent invocations with their status. Use to check whether a " +
      "scheduled automation fired, skipped, or failed.",
    inputSchema: {
      automation_id: z.string().min(1),
      limit: z.number().int().min(1).max(MAX_SESSION_LIMIT).optional(),
    },
    run: (client, args) =>
      client.get(`/automations/${encodeURIComponent(args.automation_id as string)}/invocations`, {
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "get_automation_run",
    title: "Read one automation run",
    description:
      "Read a single automation invocation, including the child sessions it launched. Pair " +
      "with get_session_events on a child id to see what that run actually did.",
    inputSchema: {
      automation_id: z.string().min(1),
      run_id: z.string().min(1),
    },
    run: (client, args) =>
      client.get(
        `/automations/${encodeURIComponent(args.automation_id as string)}` +
          `/runs/${encodeURIComponent(args.run_id as string)}`
      ),
  },
];
