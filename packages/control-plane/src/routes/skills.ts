import {
  createSkillInputSchema,
  createSkillProfileInputSchema,
  editSkillInputSchema,
  skillContentInputSchema,
  skillResolutionPreviewInputSchema,
  updateSkillInputSchema,
  updateSkillProfileInputSchema,
} from "@open-inspect/shared/types/skills";
import {
  SkillProfileConflictError,
  SkillProfileStore,
  SkillProfileValidationError,
} from "../db/skill-profiles";
import { SkillConflictError, SkillStore, SkillValidationError } from "../db/skills";
import { EnvironmentStore } from "../db/environments";
import { resolveManagedSkills, SkillResolutionError } from "../session/skill-resolution";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { managedSkillsEnabled } from "../skills/feature";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";

const log = createLogger("router:skills");
const SKILL_WRITES_PER_MINUTE = 30;

async function enforceWriteLimit(ctx: RequestContext, userId: string): Promise<Response | null> {
  const now = Date.now();
  const windowStart = now - (now % 60_000);
  await ctx.db
    .prepare(
      `INSERT INTO skill_write_throttle (user_id, window_start, write_count) VALUES (?, ?, 1)
       ON CONFLICT(user_id) DO UPDATE SET
         window_start = CASE WHEN window_start = excluded.window_start THEN window_start ELSE excluded.window_start END,
         write_count = CASE WHEN window_start = excluded.window_start THEN write_count + 1 ELSE 1 END`
    )
    .bind(userId, windowStart)
    .run();
  const row = await ctx.db
    .prepare("SELECT write_count FROM skill_write_throttle WHERE user_id = ?")
    .bind(userId)
    .first<{ write_count: number }>();
  return (row?.write_count ?? 0) > SKILL_WRITES_PER_MINUTE
    ? error("Managed skill write rate exceeded", 429)
    : null;
}

function audit(ctx: RequestContext, action: string, details: Record<string, unknown>): void {
  log.info("managed_skills.audit", {
    event: "managed_skills.audit",
    action,
    actor_user_id: canonicalUserId(ctx),
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    ...details,
  });
}

function canonicalUserId(ctx: RequestContext): string | null {
  if (ctx.principal?.kind === "user") return ctx.principal.userId;
  if (ctx.principal?.kind === "service") return ctx.principal.actor?.canonicalUserId ?? null;
  return null;
}

async function parsedBody(request: Request): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
}

function skillId(match: RegExpMatchArray): string | Response {
  return match.groups?.id ?? error("Skill ID required", 400);
}

async function handleListSkills(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  return json({ skills: await new SkillStore(ctx.db).list() });
}

async function handleGetSkill(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = skillId(match);
  if (id instanceof Response) return id;
  const skill = await new SkillStore(ctx.db).get(id);
  return skill ? json({ skill }) : error("Skill not found", 404);
}

async function handleCreateSkill(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const limited = await enforceWriteLimit(ctx, userId);
  if (limited) return limited;
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = createSkillInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill", 400);
  try {
    const skill = await new SkillStore(ctx.db).create(parsed.data, userId);
    audit(ctx, "skill.created", { skill_id: skill.id, revision_id: skill.currentRevisionId });
    return json({ skill }, 201);
  } catch (e) {
    return skillWriteError(e);
  }
}

async function handlePreviewSkill(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = createSkillInputSchema.pick({ name: true, content: true }).safeParse(body);
  if (!parsed.success) return error("Invalid skill", 400);
  try {
    const hashed = await new SkillStore(ctx.db).validateAndHash(
      parsed.data.name,
      parsed.data.content
    );
    return json({
      skillMarkdown: hashed.files.find((file) => file.path === "SKILL.md")?.content,
      contentSha256: hashed.contentSha256,
      totalBytes: hashed.totalBytes,
    });
  } catch (e) {
    return skillWriteError(e);
  }
}

async function handleUpdateSkill(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = skillId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const limited = await enforceWriteLimit(ctx, userId);
  if (limited) return limited;
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = updateSkillInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill update", 400);
  try {
    const skill = await new SkillStore(ctx.db).updateMetadata(id, parsed.data, userId);
    if (skill) audit(ctx, "skill.metadata_updated", { skill_id: id });
    return skill ? json({ skill }) : error("Skill not found", 404);
  } catch (e) {
    return skillWriteError(e);
  }
}

async function handleUpdateSkillContent(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = skillId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const limited = await enforceWriteLimit(ctx, userId);
  if (limited) return limited;
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = skillContentInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill content", 400);
  const ifMatch = request.headers.get("If-Match")?.replace(/^"|"$/g, "");
  if (!ifMatch) return error("If-Match revision is required", 428);
  try {
    const skill = await new SkillStore(ctx.db).updateContent(id, parsed.data, userId, ifMatch);
    if (skill)
      audit(ctx, "skill.content_updated", { skill_id: id, revision_id: skill.currentRevisionId });
    return skill ? json({ skill }) : error("Skill not found", 404);
  } catch (e) {
    return skillWriteError(e);
  }
}

async function handleEditSkill(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = skillId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const limited = await enforceWriteLimit(ctx, userId);
  if (limited) return limited;
  const ifMatch = request.headers.get("If-Match")?.replace(/^"|"$/g, "");
  if (!ifMatch) return error("If-Match revision is required", 428);
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = editSkillInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill edit", 400);
  try {
    const skill = await new SkillStore(ctx.db).edit(id, parsed.data, userId, ifMatch);
    if (!skill) return error("Skill not found", 404);
    audit(ctx, "skill.edited", { skill_id: id, revision_id: skill.currentRevisionId });
    return json({ skill });
  } catch (e) {
    return skillWriteError(e);
  }
}

async function handleDeleteSkill(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = skillId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const limited = await enforceWriteLimit(ctx, userId);
  if (limited) return limited;
  const deleted = await new SkillStore(ctx.db).delete(id, userId);
  if (deleted) audit(ctx, "skill.deleted", { skill_id: id });
  return deleted ? json({ ok: true }) : error("Skill not found", 404);
}

async function handleListProfiles(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  return json({ profiles: await new SkillProfileStore(ctx.db).list(userId) });
}

async function handleCreateProfile(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const limited = await enforceWriteLimit(ctx, userId);
  if (limited) return limited;
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = createSkillProfileInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill profile", 400);
  try {
    const profile = await new SkillProfileStore(ctx.db).create(
      userId,
      parsed.data.name,
      parsed.data.skillIds
    );
    const response = json({ profile }, 201);
    audit(ctx, "profile.created", { profile_id: profile.id });
    return response;
  } catch (e) {
    return profileWriteError(e);
  }
}

async function handleUpdateProfile(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = skillId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const limited = await enforceWriteLimit(ctx, userId);
  if (limited) return limited;
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = updateSkillProfileInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill profile", 400);
  try {
    const profile = await new SkillProfileStore(ctx.db).update(id, userId, parsed.data);
    if (profile) audit(ctx, "profile.updated", { profile_id: id });
    return profile ? json({ profile }) : error("Skill profile not found", 404);
  } catch (e) {
    return profileWriteError(e);
  }
}

async function handleDeleteProfile(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = skillId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const limited = await enforceWriteLimit(ctx, userId);
  if (limited) return limited;
  const deleted = await new SkillProfileStore(ctx.db).delete(id, userId);
  if (deleted) audit(ctx, "profile.deleted", { profile_id: id });
  return deleted ? json({ ok: true }) : error("Skill profile not found", 404);
}

async function handleResolvePreview(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = skillResolutionPreviewInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill resolution target", 400);
  let repositories =
    parsed.data.repositories ??
    (parsed.data.repoOwner && parsed.data.repoName
      ? [{ repoOwner: parsed.data.repoOwner, repoName: parsed.data.repoName }]
      : []);
  if (parsed.data.environmentId) {
    const environments = new EnvironmentStore(ctx.db);
    if (!(await environments.getById(parsed.data.environmentId))) {
      return error("Environment not found", 404);
    }
    repositories = (
      await environments.getRepositoriesForEnvironment(parsed.data.environmentId)
    ).map((repository) => ({
      repoOwner: repository.repo_owner,
      repoName: repository.repo_name,
    }));
  }
  try {
    const manifest = await resolveManagedSkills(
      ctx.db,
      { repositories, environmentId: parsed.data.environmentId ?? null },
      parsed.data.selection,
      canonicalUserId(ctx),
      managedSkillsEnabled(env)
    );
    return json({
      skills: manifest.skills,
      totalBytes: manifest.skills.reduce((total, skill) => total + skill.totalBytes, 0),
      ignoredProfileSkillIds: manifest.ignoredProfileSkillIds ?? [],
    });
  } catch (e) {
    if (e instanceof SkillResolutionError) return error(e.message, e.status);
    throw e;
  }
}

function skillWriteError(value: unknown): Response {
  if (value instanceof SkillConflictError) return error(value.message, 409);
  if (value instanceof SkillValidationError) return error(value.message, 400);
  throw value;
}

function profileWriteError(value: unknown): Response {
  if (value instanceof SkillProfileConflictError) return error(value.message, 409);
  if (value instanceof SkillProfileValidationError) return error(value.message, 400);
  throw value;
}

function enabled(handler: Route["handler"]): Route["handler"] {
  return (request, env, match, ctx) =>
    managedSkillsEnabled(env)
      ? handler(request, env, match, ctx)
      : Promise.resolve(error("Managed skills are disabled", 503));
}

export const skillRoutes: Route[] = [
  { method: "GET", pattern: parsePattern("/skills"), handler: enabled(handleListSkills) },
  { method: "POST", pattern: parsePattern("/skills"), handler: enabled(handleCreateSkill) },
  {
    method: "POST",
    pattern: parsePattern("/skills/preview"),
    handler: enabled(handlePreviewSkill),
  },
  {
    method: "POST",
    pattern: parsePattern("/skills/resolve-preview"),
    handler: enabled(handleResolvePreview),
  },
  { method: "GET", pattern: parsePattern("/skills/:id"), handler: enabled(handleGetSkill) },
  { method: "PATCH", pattern: parsePattern("/skills/:id"), handler: enabled(handleUpdateSkill) },
  { method: "PUT", pattern: parsePattern("/skills/:id"), handler: enabled(handleEditSkill) },
  {
    method: "PUT",
    pattern: parsePattern("/skills/:id/content"),
    handler: enabled(handleUpdateSkillContent),
  },
  { method: "DELETE", pattern: parsePattern("/skills/:id"), handler: enabled(handleDeleteSkill) },
  { method: "GET", pattern: parsePattern("/skill-profiles"), handler: enabled(handleListProfiles) },
  {
    method: "POST",
    pattern: parsePattern("/skill-profiles"),
    handler: enabled(handleCreateProfile),
  },
  {
    method: "PATCH",
    pattern: parsePattern("/skill-profiles/:id"),
    handler: enabled(handleUpdateProfile),
  },
  {
    method: "DELETE",
    pattern: parsePattern("/skill-profiles/:id"),
    handler: enabled(handleDeleteProfile),
  },
];
