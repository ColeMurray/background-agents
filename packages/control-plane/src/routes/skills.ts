import { parseBody } from "./body";
import { Hono } from "hono";
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
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { z } from "zod";
import { parseQuery } from "./query";
import {
  createRouteSourceControlProvider,
  error,
  json,
  type RequestContext,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  requirePermission,
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

const skillListQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^[1-9]\d*$/, { error: "Invalid limit" })
    .optional()
    .transform((raw) => (raw === undefined ? SKILL_LIST_PAGE_SIZE : Number(raw)))
    .refine((limit) => limit <= SKILL_LIST_PAGE_SIZE, { error: "Invalid limit" }),
  cursor: z
    .string()
    .optional()
    .transform((raw, context) => {
      if (raw === undefined) return null;
      const parsed = skillNameSchema.safeParse(raw);
      if (!parsed.success) {
        context.addIssue({ code: "custom", message: "Invalid cursor" });
        return z.NEVER;
      }
      return parsed.data;
    }),
});

async function handleListSkills(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, skillListQuerySchema);
  if (query instanceof Response) return query;
  return json(await new SkillStore(ctx.db).list(query));
}

async function handleGetSkill(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  const skill = await new SkillStore(ctx.db).get(id);
  return skill ? json({ skill }) : error("Skill not found", 404);
}

async function handleCreateSkill(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const parsed = await parseBody(request, createSkillInputSchema, "Invalid skill");
  if (parsed instanceof Response) return parsed;
  try {
    const skill = await new SkillStore(ctx.db).create(parsed, userId);
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
  _params: object,
  _ctx: RequestContext
): Promise<Response> {
  const parsed = await parseBody(
    request,
    createSkillInputSchema.pick({ name: true, content: true }),
    "Invalid skill"
  );
  if (parsed instanceof Response) return parsed;
  try {
    const revision = await buildValidatedSkillRevision(parsed.name, parsed.content);
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
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseBody(
    request,
    skillImportPreviewInputSchema,
    "Invalid skill import source"
  );
  if (parsed instanceof Response) return parsed;
  try {
    const result = await fetchSkillImport(
      createRouteSourceControlProvider(env),
      parsed.source,
      parsed.name
    );
    return json(await importPreviewResponse(ctx, result));
  } catch (e) {
    return skillImportWriteError(e);
  }
}

async function handleImportSkill(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const parsed = await parseBody(request, importSkillInputSchema, "Invalid skill import");
  if (parsed instanceof Response) return parsed;
  try {
    const result = await fetchSkillImport(
      createRouteSourceControlProvider(env),
      parsed.source,
      parsed.name
    );
    const stale = confirmedImport(result, parsed);
    if (stale) return stale;
    const skill = await new SkillStore(ctx.db).create(
      { name: result.name, content: result.content, assignments: parsed.assignments },
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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  const parsed = await parseBody(
    request,
    reimportSkillPreviewInputSchema,
    "Invalid skill re-import"
  );
  if (parsed instanceof Response) return parsed;
  const skill = await new SkillStore(ctx.db).get(id);
  if (!skill) return error("Skill not found", 404);
  try {
    const provider = createRouteSourceControlProvider(env);
    const source = recordedImportSource(skill.source, parsed.ref, provider.name);
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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const ifMatch = request.headers.get("If-Match")?.replace(/^"|"$/g, "");
  if (!ifMatch) return error("If-Match revision is required", 428);
  const parsed = await parseBody(request, reimportSkillInputSchema, "Invalid skill re-import");
  if (parsed instanceof Response) return parsed;
  const store = new SkillStore(ctx.db);
  const skill = await store.get(id);
  if (!skill) return error("Skill not found", 404);
  if (skill.currentRevisionId !== ifMatch) {
    return error(`Current revision is ${skill.currentRevisionId}`, 409);
  }
  try {
    const provider = createRouteSourceControlProvider(env);
    const source = recordedImportSource(skill.source, parsed.ref, provider.name);
    if (source instanceof Response) return source;
    const result = await fetchSkillImport(provider, source, skill.name);
    const stale = confirmedImport(result, parsed);
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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const parsed = await parseBody(request, setSkillEnabledInputSchema, "Invalid skill update");
  if (parsed instanceof Response) return parsed;
  try {
    const skill = await new SkillStore(ctx.db).setEnabled(id, parsed, userId);
    if (skill) audit(ctx, { action: "skill.enabled_updated", skill_id: id });
    return skill ? json({ skill }) : error("Skill not found", 404);
  } catch (e) {
    return skillWriteError(e);
  }
}

async function handleReplaceSkillContentAndAssignments(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const ifMatch = request.headers.get("If-Match")?.replace(/^"|"$/g, "");
  if (!ifMatch) return error("If-Match revision is required", 428);
  const parsed = await parseBody(
    request,
    replaceSkillContentAndAssignmentsInputSchema,
    "Invalid skill edit"
  );
  if (parsed instanceof Response) return parsed;
  try {
    const skill = await new SkillStore(ctx.db).replaceContentAndAssignments(
      id,
      parsed,
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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const deleted = await new SkillStore(ctx.db).delete(id, userId);
  if (deleted) audit(ctx, { action: "skill.deleted", skill_id: id });
  return deleted ? json({ ok: true }) : error("Skill not found", 404);
}

async function handleListProfiles(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  return json({ profiles: await new SkillProfileStore(ctx.db).list(userId) });
}

async function handleCreateProfile(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const parsed = await parseBody(request, createSkillProfileInputSchema, "Invalid skill profile");
  if (parsed instanceof Response) return parsed;
  try {
    const profile = await new SkillProfileStore(ctx.db).create(
      userId,
      parsed.name,
      parsed.skillIds
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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const parsed = await parseBody(request, updateSkillProfileInputSchema, "Invalid skill profile");
  if (parsed instanceof Response) return parsed;
  try {
    const profile = await new SkillProfileStore(ctx.db).update(id, userId, parsed);
    if (profile) audit(ctx, { action: "profile.updated", profile_id: id });
    return profile ? json({ profile }) : error("Skill profile not found", 404);
  } catch (e) {
    return profileWriteError(e);
  }
}

async function handleDeleteProfile(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  const userId = canonicalUserId(ctx);
  if (!userId) return error("Canonical user required", 403);
  const deleted = await new SkillProfileStore(ctx.db).delete(id, userId);
  if (deleted) audit(ctx, { action: "profile.deleted", profile_id: id });
  return deleted ? json({ ok: true }) : error("Skill profile not found", 404);
}

async function handleResolvePreview(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseBody(
    request,
    skillResolutionPreviewInputSchema,
    "Invalid skill resolution target"
  );
  if (parsed instanceof Response) return parsed;
  let repositories =
    parsed.repositories ??
    (parsed.repoOwner && parsed.repoName
      ? [{ repoOwner: parsed.repoOwner, repoName: parsed.repoName }]
      : []);
  if (parsed.environmentId) {
    const environments = new EnvironmentStore(ctx.db);
    if (!(await environments.getById(parsed.environmentId))) {
      return error("Environment not found", 404);
    }
    repositories = (await environments.getRepositoriesForEnvironment(parsed.environmentId)).map(
      (repository) => ({
        repoOwner: repository.repo_owner,
        repoName: repository.repo_name,
      })
    );
  }
  try {
    const manifest = await resolveManagedSkills(
      ctx.db,
      { repositories, environmentId: parsed.environmentId ?? null },
      parsed.selection,
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

const SKILLS_READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("skills.read"),
});
const SKILLS_MANAGE = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requirePermission("skills.manage"),
});
const PROFILES_MANAGE_OWN = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requirePermission("skill_profiles.manage_own"),
});
const PROFILES_READ_OWN = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requirePermission("skill_profiles.manage_own"),
  cacheControl: "private, no-store",
});

export const skillRoutes = new Hono<ControlPlaneHonoEnv>();

// Read routes register ahead of administration so `/skills/preview` and
// `/skills/resolve-preview` take precedence over the parameterized paths.
skillRoutes.get("/skills", SKILLS_READ, (c) => dispatch(c, handleListSkills));
skillRoutes.post("/skills/preview", SKILLS_READ, (c) => dispatch(c, handlePreviewSkill));
skillRoutes.post("/skills/resolve-preview", SKILLS_READ, (c) => dispatch(c, handleResolvePreview));
skillRoutes.get("/skills/:id", SKILLS_READ, (c) => dispatch(c, handleGetSkill));

skillRoutes.post("/skills", SKILLS_MANAGE, (c) => dispatch(c, handleCreateSkill));
skillRoutes.post("/skills/import/preview", SKILLS_MANAGE, (c) =>
  dispatch(c, handlePreviewSkillImport)
);
skillRoutes.post("/skills/import", SKILLS_MANAGE, (c) => dispatch(c, handleImportSkill));
skillRoutes.post("/skills/:id/reimport/preview", SKILLS_MANAGE, (c) =>
  dispatch(c, handlePreviewSkillReimport)
);
skillRoutes.post("/skills/:id/reimport", SKILLS_MANAGE, (c) => dispatch(c, handleReimportSkill));
skillRoutes.patch("/skills/:id", SKILLS_MANAGE, (c) => dispatch(c, handleSetSkillEnabled));
skillRoutes.put("/skills/:id", SKILLS_MANAGE, (c) =>
  dispatch(c, handleReplaceSkillContentAndAssignments)
);
skillRoutes.delete("/skills/:id", SKILLS_MANAGE, (c) => dispatch(c, handleDeleteSkill));
skillRoutes.get("/skill-profiles", PROFILES_READ_OWN, (c) => dispatch(c, handleListProfiles));
skillRoutes.post("/skill-profiles", PROFILES_MANAGE_OWN, (c) => dispatch(c, handleCreateProfile));
skillRoutes.patch("/skill-profiles/:id", PROFILES_MANAGE_OWN, (c) =>
  dispatch(c, handleUpdateProfile)
);
skillRoutes.delete("/skill-profiles/:id", PROFILES_MANAGE_OWN, (c) =>
  dispatch(c, handleDeleteProfile)
);
