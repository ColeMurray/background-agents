import { Hono } from "hono";
import { z } from "zod";
import { projectBoardLane } from "@open-inspect/shared/project-context";
import { admittedProject } from "../authorization/project-admission";
import { SessionInboxStore } from "../db/session-inbox-store";
import { parseSessionInboxCursor, encodeSessionInboxCursor } from "../db/session-inbox-cursor";
import { visibleSessionsPredicate } from "../db/session-visibility";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import {
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  requireProject,
  json,
  error,
  type RequestContext,
} from "./shared";
import { parseQuery } from "./query";

async function pullRequests(ctx: RequestContext) {
  const { project, viewer } = admittedProject(ctx);
  const visible = visibleSessionsPredicate("s", viewer, { mode: "on" });
  return (
    await ctx.db
      .prepare(
        `SELECT pr.artifact_id AS id,pr.session_id AS sessionId,pr.url,pr.lifecycle_state AS state,pr.is_draft AS isDraft,
  pr.head_branch AS branch,pr.provider_updated_at AS providerUpdatedAt,s.title AS sessionTitle FROM session_pull_requests pr JOIN sessions s ON s.id = pr.session_id
  WHERE s.project_id = ? AND ${visible.sql} ORDER BY pr.provider_updated_at DESC,pr.artifact_id LIMIT 500`
      )
      .bind(project.id, ...visible.params)
      .all<{
        id: string;
        sessionId: string;
        url: string;
        state: string;
        isDraft: number;
        branch: string;
        providerUpdatedAt: number | null;
        sessionTitle: string | null;
      }>()
  ).results.map((row) => ({ ...row, isDraft: !!row.isDraft }));
}
async function handlePullRequests(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
) {
  if (!ctx.authorization?.permissions.includes("sessions.read"))
    return error("Session read permission required", 403);
  return json({ pullRequests: await pullRequests(ctx) });
}
async function handleSessions(request: Request, _env: Env, _params: object, ctx: RequestContext) {
  if (!ctx.authorization?.permissions.includes("sessions.read"))
    return error("Session read permission required", 403);
  const query = parseQuery(
    request,
    z.object({
      bucket: z
        .enum(["recent", "board", "needs_attention", "in_progress", "finished"])
        .default("recent"),
      cursor: z.string().optional(),
    })
  );
  if (query instanceof Response) return query;
  const cursor = parseSessionInboxCursor(query.cursor);
  if (!cursor.ok) return error(cursor.error, 400);
  const { project, viewer } = admittedProject(ctx);
  const store = new SessionInboxStore(ctx.db);
  const options = {
    projectId: project.id,
    viewerUserId: ctx.authorization!.userId,
    readScope: viewer,
    mode: "on" as const,
    limit: 50,
  };
  if (query.bucket !== "recent" && query.bucket !== "board") {
    const page = await store.list({ ...options, category: query.bucket, cursor: cursor.cursor });
    return json({
      ...page,
      nextCursor: page.nextCursor ? encodeSessionInboxCursor(page.nextCursor) : null,
    });
  }
  const [snapshot, prs] = await Promise.all([store.snapshot(options), pullRequests(ctx)]);
  const items = Object.values(snapshot)
    .flatMap((page) => page.items)
    .sort((a, b) => b.rootSession.updatedAt - a.rootSession.updatedAt)
    .map((item) => {
      const ids = new Set([
        item.rootSession.id,
        ...item.descendantSessions.map((session) => session.id),
      ]);
      const pullRequests = prs.filter((pr) => ids.has(pr.sessionId));
      // The display list is bounded; inbox metadata counts every visible PR, so
      // older PRs outside that list still determine the correct lineage lane.
      const states = [item.rootSession, ...item.descendantSessions].flatMap((session) => {
        const summary = session.pullRequestSummary;
        if (!summary) return [];
        return [
          ...(summary.open ? [{ state: "open", isDraft: false }] : []),
          ...(summary.draft ? [{ state: "open", isDraft: true }] : []),
          ...(summary.merged ? [{ state: "merged", isDraft: false }] : []),
          ...(summary.closed ? [{ state: "closed", isDraft: false }] : []),
        ];
      });
      return { ...item, lane: projectBoardLane(states), pullRequests };
    });
  return json({ items, hasMore: Object.values(snapshot).some((page) => page.hasMore) });
}
const read = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requireProject("read"),
  cacheControl: "private, no-store",
});
export const projectWorkRoutes = new Hono<ControlPlaneHonoEnv>();
projectWorkRoutes.get("/projects/:id/sessions", read, (c) => dispatch(c, handleSessions));
projectWorkRoutes.get("/projects/:id/pull-requests", read, (c) => dispatch(c, handlePullRequests));
