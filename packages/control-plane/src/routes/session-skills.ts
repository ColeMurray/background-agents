import { SessionIndexStore } from "../db/session-index";
import { SessionSkillStore } from "../db/session-skills";
import { hashSessionSkillManifest } from "../skills/content-addressing";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";

function sessionId(match: RegExpMatchArray): string | Response {
  return match.groups?.id ?? error("Session ID required", 400);
}

async function handleSessionSkillsView(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (ctx.principal?.kind !== "user") return error("User authentication required", 403);
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
  ctx: RequestContext
): Promise<Response> {
  const id = sessionId(match);
  if (id instanceof Response) return id;
  if (ctx.principal?.kind !== "sandbox" || ctx.principal.sessionId !== id) {
    return error("Sandbox authentication required", 403);
  }
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
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/skills"),
    handler: handleSessionSkillsView,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/sandbox-skills"),
    handler: handleSandboxInstallation,
  },
];
