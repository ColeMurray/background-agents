import { skillActivationInputSchema } from "@open-inspect/shared/types/skills";
import { SessionIndexStore } from "../db/session-index";
import { SessionSkillStore } from "../db/session-skills";
import { hashManifest } from "../skills/canonical";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";

const log = createLogger("router:session-skills");

function sessionId(match: RegExpMatchArray): string | Response {
  return match.groups?.id ?? error("Session ID required", 400);
}

async function handleHumanSessionSkills(
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
  const manifest = await new SessionSkillStore(ctx.db).getHumanManifest(id);
  if (!manifest) return error("Session skill manifest not found", 404);
  const response = json(manifest);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function handleSandboxManifest(
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
  const manifest = await new SessionSkillStore(ctx.db).getSandboxManifest(id);
  // Sessions created before managed-skills shipped have no pinned row. Treat
  // them as an empty legacy manifest so snapshot restores remain bootable.
  const resolvedManifest =
    manifest ??
    ((await new SessionIndexStore(ctx.db).exists(id))
      ? {
          schemaVersion: 1 as const,
          resolverVersion: 1 as const,
          manifestSha256: await hashManifest({ mode: "all" }, []),
          selection: { mode: "all" as const },
          skills: [],
        }
      : null);
  if (!resolvedManifest) return error("Session skill manifest not found", 404);
  const response = json(resolvedManifest);
  response.headers.set("ETag", `"${resolvedManifest.manifestSha256}"`);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function handleActivation(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = sessionId(match);
  if (id instanceof Response) return id;
  if (ctx.principal?.kind !== "sandbox" || ctx.principal.sessionId !== id) {
    return error("Sandbox authentication required", 403);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  const parsed = skillActivationInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid activation report", 400);
  const outcome = await new SessionSkillStore(ctx.db).reportActivation(id, parsed.data);
  if (outcome === "not_found") return error("Session skill manifest not found", 404);
  if (outcome === "digest_mismatch") return error("Manifest digest does not match", 409);
  log.info("managed_skills.activation_reported", {
    event: "managed_skills.activation_reported",
    session_id: id,
    status: parsed.data.status,
    outcome,
    error_code: parsed.data.errorCode,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return json({ ok: true });
}

export const sessionSkillRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/skills"),
    handler: handleHumanSessionSkills,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/sandbox-skills"),
    handler: handleSandboxManifest,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/sandbox-skills/activation"),
    handler: handleActivation,
  },
];
