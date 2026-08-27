/**
 * The read-only tool surface.
 *
 * Every tool is one GET against a route whose policy already accepts service
 * auth. Nothing here mutates, and nothing here needs an actor.
 */

import { z } from "zod";
import type { ControlPlaneClient } from "./client";

/** Cap on how much of a session's timeline one call returns. */
const MAX_EVENT_LIMIT = 500;
const DEFAULT_EVENT_LIMIT = 100;

const MAX_SESSION_LIMIT = 100;
const DEFAULT_SESSION_LIMIT = 20;

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
      "events or diff. Filter by status to narrow to running or failed work.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("Only sessions in this status (e.g. running, completed, failed)"),
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
      "primary tool for working out what a session actually did and where it went wrong.",
    inputSchema: {
      session_id: sessionId,
      limit: z.number().int().min(1).max(MAX_EVENT_LIMIT).optional(),
    },
    run: (client, args) =>
      client.get(`/sessions/${encodeURIComponent(args.session_id as string)}/events`, {
        limit: (args.limit as number | undefined) ?? DEFAULT_EVENT_LIMIT,
      }),
  },
  {
    name: "get_session_messages",
    title: "Read session messages",
    description:
      "Read the prompt/response messages exchanged in one session, without the tool-call " +
      "detail that get_session_events includes.",
    inputSchema: { session_id: sessionId },
    run: (client, args) =>
      client.get(`/sessions/${encodeURIComponent(args.session_id as string)}/messages`),
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
