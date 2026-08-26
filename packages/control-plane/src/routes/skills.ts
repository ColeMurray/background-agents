import {
  createSkillInputSchema,
  createSkillProfileInputSchema,
  importSkillInputSchema,
  reimportSkillInputSchema,
  reimportSkillPreviewInputSchema,
  replaceSkillContentAndAssignmentsInputSchema,
  setSkillEnabledInputSchema,
  SKILL_LIST_PAGE_SIZE,
  skillImportPreviewInputSchema,
  skillNameSchema,
  skillResolutionPreviewInputSchema,
  updateSkillProfileInputSchema,
  type SkillImportProvenance,
  type SkillImportPreviewResponse,
  type SkillImportSourceInput,
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
import {
  buildValidatedSkillRevision,
  SkillRevisionValidationError,
} from "../skills/content-addressing";
import { fetchSkillImport, SkillImportError, type SkillImportResult } from "../skills/git-import";
import {
  createRouteSourceControlProvider,
  error,
  json,
  parsePattern,
  type RequestContext,
  type Route,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  defineRoutes,
} from "./shared";

const log = createLogger("router:skills");

type SkillAuditEvent =
  | {
      action: "skill.created" | "skill.edited";
      skill_id: string;
      revision_id: string;
    }
  | {
      action: "skill.imported" | "skill.reimported";
      skill_id: string;
      revision_id: string;
      source_provider: string;
      source_repository: string;
      source_ref: string;
      source_commit_sha: string;
      source_subdirectory: string | null;
      source_sha256: string;
      revision_created: boolean;
    }
  | { action: "skill.enabled_updated" | "skill.deleted"; skill_id: string }
  | {
      action: "profile.created" | "profile.updated" | "profile.deleted";
      profile_id: string;
    };

function audit(ctx: RequestContext, event: SkillAuditEvent): void {
  log.info("managed_skills.audit", {
    event: "managed_skills.audit",
    actor_user_id: canonicalUserId(ctx),
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    ...event,
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

function resourceId(match: RegExpMatchArray): string | Response {
  return match.groups?.id ?? error("Resource ID required", 400);
}

async function handleListSkills(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const limitValue = url.searchParams.get("limit");
  const cursorValue = url.searchParams.get("cursor");
  if (url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("cursor").length > 1) {
    return error("Invalid skill list query", 400);
  }
  const limit = limitValue === null ? SKILL_LIST_PAGE_SIZE : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > SKILL_LIST_PAGE_SIZE) {
    return error("Invalid limit", 400);
  }
  const parsedCursor = cursorValue === null ? null : skillNameSchema.safeParse(cursorValue);
  if (parsedCursor !== null && !parsedCursor.success) return error("Invalid cursor", 400);
  return json(
    await new SkillStore(ctx.db).list({
      limit,
      cursor: parsedCursor === null ? null : parsedCursor.data,
    })
  );
}

async function handleGetSkill(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = resourceId(match);
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
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = createSkillInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill", 400);
  try {
    const skill = await new SkillStore(ctx.db).create(parsed.data, userId);
    audit(ctx, {
      action: "skill.created",
      skill_id: skill.id,
      revision_id: skill.currentRevisionId,
    });
    return json({ skill }, 201);
  } catch (e) {
    return skillWriteError(e);
  }
}

async function handlePreviewSkill(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = createSkillInputSchema.pick({ name: true, content: true }).safeParse(body);
  if (!parsed.success) return error("Invalid skill", 400);
  try {
    const revision = await buildValidatedSkillRevision(parsed.data.name, parsed.data.content);
    return json({
      skillMarkdown: revision.files.find((file) => file.path === "SKILL.md")?.content,
      revisionSha256: revision.revisionSha256,
      totalBytes: revision.totalBytes,
    });
  } catch (e) {
    return skillWriteError(e);
  }
}

/**
 * Shape one fetched import as its preview, including whether the canonical
 * name is still free so the importer can override it before confirming.
 *
 * @param heldByName - Name the target skill already holds, on a re-import;
 *   that name is available to it even though the catalog has it taken.
 */
async function importPreviewResponse(
  ctx: RequestContext,
  result: SkillImportResult,
  heldByName?: string
): Promise<SkillImportPreviewResponse> {
  return {
    name: result.name,
    source: result.source,
    description: result.content.description,
    body: result.content.body,
    license: result.content.license ?? null,
    compatibility: result.content.compatibility ?? null,
    metadata: result.content.metadata,
    revisionSha256: result.revisionSha256,
    totalBytes: result.totalBytes,
    files: result.files,
    warnings: result.warnings,
    nameAvailable:
      result.name === heldByName || (await new SkillStore(ctx.db).nameAvailable(result.name)),
  };
}

/**
 * Re-read the source and refuse to store anything the importer has not seen.
 * The commit pins the bytes; the digest additionally catches a mapping change
 * between preview and confirmation.
 */
function confirmedImport(
  result: SkillImportResult,
  expected: {
    expectedCommitSha: string;
    expectedSourceSha256: string;
    expectedRevisionSha256: string;
  }
): Response | null {
  if (result.source.commitSha !== expected.expectedCommitSha) {
    return error(
      `The source moved to commit ${result.source.commitSha} since it was previewed. Preview the import again.`,
      409
    );
  }
  if (result.source.sourceSha256 !== expected.expectedSourceSha256) {
    return error("The source content changed since it was previewed. Preview again.", 409);
  }
  if (result.revisionSha256 !== expected.expectedRevisionSha256) {
    return error("The imported skill changed since it was previewed. Preview again.", 409);
  }
  return null;
}

async function handlePreviewSkillImport(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = skillImportPreviewInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill import source", 400);
  try {
    const result = await fetchSkillImport(
      createRouteSourceControlProvider(env),
      parsed.data.source,
      parsed.data.name
    );
    return json(await importPreviewResponse(ctx, result));
  } catch (e) {
    return skillImportWriteError(e);
  }
}

async function handleImportSkill(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = importSkillInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill import", 400);
  try {
    const result = await fetchSkillImport(
      createRouteSourceControlProvider(env),
      parsed.data.source,
      parsed.data.name
    );
    const stale = confirmedImport(result, parsed.data);
    if (stale) return stale;
    const skill = await new SkillStore(ctx.db).create(
      { name: result.name, content: result.content, assignments: parsed.data.assignments },
      userId,
      result.source
    );
    audit(ctx, {
      action: "skill.imported",
      skill_id: skill.id,
      revision_id: skill.currentRevisionId,
      revision_created: true,
      ...sourceAuditFields(result.source),
    });
    return json({ skill }, 201);
  } catch (e) {
    return skillImportWriteError(e);
  }
}

/**
 * Resolve the source a re-import reads: the recorded repository and
 * subdirectory, with only the ref allowed to move.
 *
 * An absent ref — omitted or null — means the recorded one, which is what the
 * editor's empty ref field offers. Returning to the default branch is done by
 * naming that branch, not by clearing the field, so a re-import never silently
 * jumps to a different branch than the one it was pinned to.
 */
function recordedImportSource(
  source: SkillImportProvenance | null,
  ref: string | null | undefined,
  providerName: string
): SkillImportSourceInput | Response {
  if (!source) return error("This skill was not imported from a repository", 409);
  if (source.provider !== providerName) {
    return error(
      `This skill was imported from ${source.provider}, but this deployment uses ${providerName}`,
      409
    );
  }
  return {
    repository: { repoOwner: source.repoOwner, repoName: source.repoName },
    ref: ref ?? source.requestedRef,
    subdirectory: source.subdirectory,
  };
}

async function handlePreviewSkillReimport(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = resourceId(match);
  if (id instanceof Response) return id;
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = reimportSkillPreviewInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill re-import", 400);
  const skill = await new SkillStore(ctx.db).get(id);
  if (!skill) return error("Skill not found", 404);
  try {
    const provider = createRouteSourceControlProvider(env);
    const source = recordedImportSource(skill.source, parsed.data.ref, provider.name);
    if (source instanceof Response) return source;
    const result = await fetchSkillImport(provider, source, skill.name);
    return json(await importPreviewResponse(ctx, result, skill.name));
  } catch (e) {
    return skillImportWriteError(e);
  }
}

async function handleReimportSkill(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = resourceId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const ifMatch = request.headers.get("If-Match")?.replace(/^"|"$/g, "");
  if (!ifMatch) return error("If-Match revision is required", 428);
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = reimportSkillInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill re-import", 400);
  const store = new SkillStore(ctx.db);
  const skill = await store.get(id);
  if (!skill) return error("Skill not found", 404);
  if (skill.currentRevisionId !== ifMatch) {
    return error(`Current revision is ${skill.currentRevisionId}`, 409);
  }
  try {
    const provider = createRouteSourceControlProvider(env);
    const source = recordedImportSource(skill.source, parsed.data.ref, provider.name);
    if (source instanceof Response) return source;
    const result = await fetchSkillImport(provider, source, skill.name);
    const stale = confirmedImport(result, parsed.data);
    if (stale) return stale;
    const applied = await store.applyImportedRevision(
      id,
      result.content,
      result.source,
      userId,
      ifMatch
    );
    if (!applied) return error("Skill not found", 404);
    audit(ctx, {
      action: "skill.reimported",
      skill_id: id,
      revision_id: applied.skill.currentRevisionId,
      revision_created: applied.revisionCreated,
      ...sourceAuditFields(result.source),
    });
    return json({ skill: applied.skill, revisionCreated: applied.revisionCreated });
  } catch (e) {
    return skillImportWriteError(e);
  }
}

function sourceAuditFields(source: SkillImportResult["source"]) {
  return {
    source_provider: source.provider,
    source_repository: `${source.repoOwner}/${source.repoName}`,
    source_ref: source.resolvedRef,
    source_commit_sha: source.commitSha,
    source_subdirectory: source.subdirectory,
    source_sha256: source.sourceSha256,
  };
}

async function handleSetSkillEnabled(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = resourceId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = setSkillEnabledInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill update", 400);
  try {
    const skill = await new SkillStore(ctx.db).setEnabled(id, parsed.data, userId);
    if (skill) audit(ctx, { action: "skill.enabled_updated", skill_id: id });
    return skill ? json({ skill }) : error("Skill not found", 404);
  } catch (e) {
    return skillWriteError(e);
  }
}

async function handleReplaceSkillContentAndAssignments(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = resourceId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const ifMatch = request.headers.get("If-Match")?.replace(/^"|"$/g, "");
  if (!ifMatch) return error("If-Match revision is required", 428);
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = replaceSkillContentAndAssignmentsInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill edit", 400);
  try {
    const skill = await new SkillStore(ctx.db).replaceContentAndAssignments(
      id,
      parsed.data,
      userId,
      ifMatch
    );
    if (!skill) return error("Skill not found", 404);
    audit(ctx, {
      action: "skill.edited",
      skill_id: id,
      revision_id: skill.currentRevisionId,
    });
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
  const id = resourceId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const deleted = await new SkillStore(ctx.db).delete(id, userId);
  if (deleted) audit(ctx, { action: "skill.deleted", skill_id: id });
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
    audit(ctx, { action: "profile.created", profile_id: profile.id });
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
  const id = resourceId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const parsed = updateSkillProfileInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid skill profile", 400);
  try {
    const profile = await new SkillProfileStore(ctx.db).update(id, userId, parsed.data);
    if (profile) audit(ctx, { action: "profile.updated", profile_id: id });
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
  const id = resourceId(match);
  if (id instanceof Response) return id;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const deleted = await new SkillProfileStore(ctx.db).delete(id, userId);
  if (deleted) audit(ctx, { action: "profile.deleted", profile_id: id });
  return deleted ? json({ ok: true }) : error("Skill profile not found", 404);
}

async function handleResolvePreview(
  request: Request,
  _env: Env,
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
      canonicalUserId(ctx)
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

function skillImportWriteError(value: unknown): Response {
  if (value instanceof SkillImportError) return error(value.message, value.status);
  return skillWriteError(value);
}

function skillWriteError(value: unknown): Response {
  if (value instanceof SkillConflictError) return error(value.message, 409);
  if (value instanceof SkillValidationError || value instanceof SkillRevisionValidationError) {
    return error(value.message, 400);
  }
  throw value;
}

function profileWriteError(value: unknown): Response {
  if (value instanceof SkillProfileConflictError) return error(value.message, 409);
  if (value instanceof SkillProfileValidationError) return error(value.message, 400);
  throw value;
}

const skillReadRoutes = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  { method: "GET", pattern: parsePattern("/skills"), handler: handleListSkills },
  {
    method: "POST",
    pattern: parsePattern("/skills/preview"),
    handler: handlePreviewSkill,
  },
  {
    method: "POST",
    pattern: parsePattern("/skills/resolve-preview"),
    handler: handleResolvePreview,
  },
  { method: "GET", pattern: parsePattern("/skills/:id"), handler: handleGetSkill },
]);

const skillAdministrationRoutes = defineRoutes(SCM_AGNOSTIC_HUMAN_USER_ROUTE, [
  { method: "POST", pattern: parsePattern("/skills"), handler: handleCreateSkill },
  {
    method: "POST",
    pattern: parsePattern("/skills/import/preview"),
    handler: handlePreviewSkillImport,
  },
  { method: "POST", pattern: parsePattern("/skills/import"), handler: handleImportSkill },
  {
    method: "POST",
    pattern: parsePattern("/skills/:id/reimport/preview"),
    handler: handlePreviewSkillReimport,
  },
  {
    method: "POST",
    pattern: parsePattern("/skills/:id/reimport"),
    handler: handleReimportSkill,
  },
  {
    method: "PATCH",
    pattern: parsePattern("/skills/:id"),
    handler: handleSetSkillEnabled,
  },
  {
    method: "PUT",
    pattern: parsePattern("/skills/:id"),
    handler: handleReplaceSkillContentAndAssignments,
  },
  { method: "DELETE", pattern: parsePattern("/skills/:id"), handler: handleDeleteSkill },
  { method: "GET", pattern: parsePattern("/skill-profiles"), handler: handleListProfiles },
  {
    method: "POST",
    pattern: parsePattern("/skill-profiles"),
    handler: handleCreateProfile,
  },
  {
    method: "PATCH",
    pattern: parsePattern("/skill-profiles/:id"),
    handler: handleUpdateProfile,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/skill-profiles/:id"),
    handler: handleDeleteProfile,
  },
]);

export const skillRoutes: Route[] = [...skillReadRoutes, ...skillAdministrationRoutes];
