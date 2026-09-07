import { Hono } from "hono";
import { z } from "zod";
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
import { parseQuery } from "./query";

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
const PAGE_LIMIT_ERROR = `limit must be an integer between 1 and ${MAX_SANDBOX_SKILL_PAGE_SIZE}`;

/** The position before the first manifest entry: an omitted cursor pages from the start. */
const BEFORE_FIRST_POSITION = -1;

const installationPageQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^[1-9]\d*$/, { error: PAGE_LIMIT_ERROR })
    .optional()
    .transform((raw) => (raw === undefined ? undefined : Number(raw)))
    .refine((limit) => limit === undefined || limit <= MAX_SANDBOX_SKILL_PAGE_SIZE, {
      error: PAGE_LIMIT_ERROR,
    }),
  cursor: z
    .string()
    .regex(/^\d+$/, { error: "cursor is not a valid position" })
    .optional()
    .transform((raw) => (raw === undefined ? BEFORE_FIRST_POSITION : Number(raw)))
    // A digit run long enough to overflow Number is not a position either.
    .refine(Number.isSafeInteger, { error: "cursor is not a valid position" }),
});

function installationPage(request: Request): { after: number; limit: number } | Response | null {
  const query = parseQuery(request, installationPageQuerySchema);
  if (query instanceof Response) return query;
  if (query.limit === undefined) return null;
  return { after: query.cursor, limit: query.limit };
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
