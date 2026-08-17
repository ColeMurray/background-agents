import { SessionIndexStore } from "../db/session-index";
import { SessionSkillStore } from "../db/session-skills";
import { hashSessionSkillManifest } from "../skills/content-addressing";
import type { Env } from "../types";
import {
  defineRoute,
  error,
  json,
  parsePattern,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type SandboxRouteContext,
  type Route,
  type UserRouteContext,
} from "./shared";

function sessionId(match: RegExpMatchArray): string | Response {
  return match.groups?.id ?? error("Session ID required", 400);
}

async function handleSessionSkillsView(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const id = sessionId(match);
  if (id instanceof Response) return id;
  if (!(await new SessionIndexStore(ctx.db).getVisibleForUser(id, ctx.principal.userId))) {
    return error("Session not found", 404);
  }
  const view = await new SessionSkillStore(ctx.db).getSessionSkillsView(id);
  if (!view) return error("Session skill manifest not found", 404);
  const response = json(view);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function handleSandboxInstallation(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SandboxRouteContext
): Promise<Response> {
  const id = sessionId(match);
  if (id instanceof Response) return id;
  const manifest = await new SessionSkillStore(ctx.db).getSandboxInstallation(id);
  // Sessions created before managed-skills shipped have no pinned row. Treat
  // them as an empty legacy manifest so snapshot restores remain bootable.
  const resolvedManifest =
    manifest ??
    ((await new SessionIndexStore(ctx.db).exists(id))
      ? {
          schemaVersion: 1 as const,
          manifestSha256: await hashSessionSkillManifest({ mode: "all" }, []),
          skills: [],
        }
      : null);
  if (!resolvedManifest) return error("Session skill manifest not found", 404);
  const response = json(resolvedManifest);
  response.headers.set("ETag", `"${resolvedManifest.manifestSha256}"`);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const sessionSkillRoutes: Route[] = [
  defineRoute(SCM_AGNOSTIC_HUMAN_USER_ROUTE, {
    method: "GET",
    pattern: parsePattern("/sessions/:id/skills"),
    handler: handleSessionSkillsView,
  }),
  defineRoute(SCM_AGNOSTIC_SANDBOX_ROUTE, {
    method: "GET",
    pattern: parsePattern("/sessions/:id/sandbox-skills"),
    handler: handleSandboxInstallation,
  }),
];
