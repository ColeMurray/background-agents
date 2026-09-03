import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { MAX_SANDBOX_SKILL_PAGE_SIZE } from "@open-inspect/shared/types/skills";
import { SessionSkillStore } from "../db/session-skills";
import type { Env } from "../types";
import {
  error,
  json,
  NO_AUTHORIZATION,
  requirePermission,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type SandboxRouteContext,
  type UserRouteContext,
} from "./shared";

export async function handleSessionSkillsView(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const id = params.id;
  const view = await new SessionSkillStore(ctx.db).getSessionSkillsView(id);
  if (!view) return error("Session skill manifest not found", 404);
  const response = json(view);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/**
 * Read the optional page window. Absent `limit` means the caller wants the whole
 * installation in one response, which is how sandbox runtimes predating paging
 * call this endpoint.
 */
function installationPage(request: Request): { after: number; limit: number } | Response | null {
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit");
  if (rawLimit === null) return null;
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SANDBOX_SKILL_PAGE_SIZE) {
    return error(`limit must be an integer between 1 and ${MAX_SANDBOX_SKILL_PAGE_SIZE}`, 400);
  }
  const rawCursor = params.get("cursor");
  if (rawCursor === null) return { after: -1, limit };
  const after = Number(rawCursor);
  if (!Number.isInteger(after) || after < 0) return error("cursor is not a valid position", 400);
  return { after, limit };
}

export async function handleSandboxInstallation(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const id = params.id;
  const page = installationPage(request);
  if (page instanceof Response) return page;
  const manifest = await new SessionSkillStore(ctx.db).getSandboxInstallation(
    id,
    page ?? undefined
  );
  if (!manifest) return error("Session skill manifest not found", 404);
  const response = json(manifest);
  // The digest covers the whole manifest, so it is stable across pages and
  // cannot identify one. Only tag a response that is the entire installation.
  if (page === null) response.headers.set("ETag", `"${manifest.manifestSha256}"`);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const sessionSkillRoutes = new Hono<ControlPlaneHonoEnv>();

sessionSkillRoutes.get(
  "/sessions/:id/skills",
  admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: requirePermission("sessions.read") }),
  (c) => dispatch(c, handleSessionSkillsView)
);

sessionSkillRoutes.get(
  "/sessions/:id/sandbox-skills",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, handleSandboxInstallation)
);
