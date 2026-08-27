import { z } from "zod";
import type { Logger } from "../../../logger";
import type { RepositoryRef } from "@open-inspect/shared/types/repositories";
import { getValidModelOrDefault, isValidModel } from "@open-inspect/shared/models";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";
import { normalizeSandboxSettings } from "../../../sandbox/settings";
import { DEFAULT_BASE_BRANCH } from "../../../repos/default-branch";
import { validateReasoningEffort } from "../../reasoning-effort";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SandboxRepository } from "../../sandbox-repository";
import type { ParticipantRepository } from "../../participant-repository";

const repositoryRefSchema = z.object({
  repoOwner: z.string(),
  repoName: z.string(),
  repoId: z.number(),
  baseBranch: z.string(),
}) satisfies z.ZodType<RepositoryRef>;

const spawnSourceSchema = z.enum([
  "user",
  "agent",
  "automation",
  "github-bot",
  "linear-bot",
  "slack-bot",
] satisfies [SpawnSource, ...SpawnSource[]]);

/**
 * Request body for the /internal/init endpoint.
 * The router constructs this from SessionInitInput — see session/initialize.ts.
 * Note: `userId` here is the participantUserId from SessionInitInput.
 */
const initRequestSchema = z.object({
  sessionName: z.string(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  repoId: z.number().nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  /**
   * Ordered member list ([0] = primary, matching the scalar fields).
   * initialize.ts always sends it for repository sessions (synthesizing a
   * one-entry list for scalar callers) and an empty list for repo-less ones.
   */
  repositories: z.array(repositoryRefSchema).optional(),
  /** Launch environment provenance; null for repo-launched/ad-hoc sessions. */
  environmentId: z.string().nullable().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
  userId: z.string(),
  /** Canonical platform user ID for analytics attribution; null when unresolved. */
  canonicalUserId: z.string().nullable().optional(),
  scmLogin: z.string().nullable().optional(),
  scmName: z.string().nullable().optional(),
  scmEmail: z.string().nullable().optional(),
  scmToken: z.string().nullable().optional(),
  scmTokenEncrypted: z.string().nullable().optional(),
  scmRefreshTokenEncrypted: z.string().nullable().optional(),
  scmTokenExpiresAt: z.number().nullable().optional(),
  scmUserId: z.string().nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  spawnSource: spawnSourceSchema.optional(),
  spawnDepth: z.number().optional(),
  codeServerEnabled: z.boolean().optional(),
  vncEnabled: z.boolean().optional(),
  /**
   * Opaque here on purpose: `normalizeSandboxSettings` is the single boundary
   * validator for this blob (port ranges, collisions, timeout shape). Restating
   * the field list as a Zod object would silently strip any setting added to
   * SandboxSettings later, so the shape is validated at the use site instead.
   */
  sandboxSettings: z.unknown().optional(),
});

type InitRequest = z.infer<typeof initRequestSchema>;

/**
 * HTTP boundary for `/internal/init` — the Durable Object side of session
 * bootstrap. Writes the entire initial aggregate (session row, repository
 * member set, pending sandbox row, owner participant) in one transaction,
 * then schedules the warm spawn. Single caller: `session/initialize.ts`,
 * after the D1 index insert succeeds.
 */
export class SessionInitHandler {
  constructor(
    private readonly sessionCoreRepository: SessionCoreRepository,
    private readonly sandboxRepository: SandboxRepository,
    private readonly participantRepository: ParticipantRepository,
    private readonly durableObjectId: string,
    private readonly scheduleWarmSandbox: () => void,
    private readonly encryptScmToken: (token: string) => Promise<string>,
    private readonly generateId: (bytes?: number) => string,
    private readonly now: () => number = Date.now
  ) {}

  async init(request: Request, log: Logger): Promise<Response> {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const parseResult = initRequestSchema.safeParse(raw);
    if (!parseResult.success) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const body: InitRequest = parseResult.data;

    const sessionId = this.durableObjectId;
    const sessionName = body.sessionName;
    const now = this.now();
    const repoOwner = body.repoOwner?.trim() || null;
    const repoName = body.repoName?.trim() || null;
    const hasRepoOwner = repoOwner !== null;
    const hasRepoName = repoName !== null;
    const hasRepoId = body.repoId != null;
    if (
      hasRepoOwner !== hasRepoName ||
      (!hasRepoOwner && hasRepoId) ||
      (hasRepoOwner && !hasRepoId)
    ) {
      return Response.json(
        { error: "Repository context must include repoOwner, repoName, and repoId together" },
        { status: 400 }
      );
    }

    let encryptedToken = body.scmTokenEncrypted ?? null;
    if (body.scmToken) {
      try {
        encryptedToken = await this.encryptScmToken(body.scmToken);
        log.debug("Encrypted SCM token for storage");
      } catch (error) {
        log.error("Failed to encrypt SCM token", {
          error: error instanceof Error ? error : String(error),
        });
      }
    }

    const model = getValidModelOrDefault(body.model);
    if (body.model && !isValidModel(body.model)) {
      log.warn("Invalid model name, using default", {
        requested_model: body.model,
        default_model: model,
      });
    }

    const reasoningEffort = validateReasoningEffort(model, body.reasoningEffort ?? undefined, log);
    const baseBranch = hasRepoOwner
      ? body.branch || body.defaultBranch || DEFAULT_BASE_BRANCH
      : null;

    const repositories = body.repositories ?? [];
    if (repositories.length > 0) {
      const primary = repositories[0];
      if (
        !hasRepoOwner ||
        primary.repoOwner !== repoOwner ||
        primary.repoName !== repoName ||
        primary.repoId !== body.repoId ||
        primary.baseBranch !== baseBranch
      ) {
        return Response.json(
          { error: "repositories[0] must match the scalar repository mirror" },
          { status: 400 }
        );
      }
    } else if (hasRepoOwner && body.repositories !== undefined) {
      // An explicit empty list alongside scalar context is a producer bug —
      // initialize.ts synthesizes a one-entry list for scalar callers.
      return Response.json(
        { error: "repositories must include the scalar repository" },
        { status: 400 }
      );
    }

    this.sessionCoreRepository.transaction(() => {
      this.sessionCoreRepository.upsertSession({
        id: sessionId,
        sessionName,
        title: body.title ?? null,
        repoOwner,
        repoName,
        repoId: hasRepoOwner ? body.repoId : null,
        baseBranch,
        model,
        reasoningEffort,
        status: "created",
        parentSessionId: body.parentSessionId ?? null,
        spawnSource: body.spawnSource ?? "user",
        spawnDepth: body.spawnDepth ?? 0,
        codeServerEnabled: body.codeServerEnabled ?? false,
        vncEnabled: body.vncEnabled ?? false,
        sandboxSettings: body.sandboxSettings
          ? JSON.stringify(normalizeSandboxSettings(body.sandboxSettings, { invalid: "omit" }))
          : null,
        environmentId: body.environmentId ?? null,
        createdAt: now,
        updatedAt: now,
      });

      // Legacy scalar producers (spawn paths not yet list-aware) still get a
      // member row so spawn/read paths have one source of truth.
      const memberRepositories: RepositoryRef[] =
        repositories.length > 0
          ? repositories
          : repoOwner !== null && repoName !== null && body.repoId != null && baseBranch !== null
            ? [{ repoOwner, repoName, repoId: body.repoId, baseBranch }]
            : [];
      this.sessionCoreRepository.replaceSessionRepositories(
        memberRepositories.map((repo, position) => ({
          position,
          repoOwner: repo.repoOwner,
          repoName: repo.repoName,
          repoId: repo.repoId,
          baseBranch: repo.baseBranch,
        }))
      );
      const sandboxId = this.generateId();
      this.sandboxRepository.createSandbox({
        id: sandboxId,
        status: "pending",
        gitSyncStatus: "pending",
        createdAt: 0,
      });

      const participantId = this.generateId();
      this.participantRepository.createParticipant({
        id: participantId,
        userId: body.userId,
        ...(body.canonicalUserId ? { canonicalUserId: body.canonicalUserId } : {}),
        scmUserId: body.scmUserId ?? null,
        scmLogin: body.scmLogin ?? null,
        scmName: body.scmName ?? null,
        scmEmail: body.scmEmail ?? null,
        scmAccessTokenEncrypted: encryptedToken,
        scmRefreshTokenEncrypted: body.scmRefreshTokenEncrypted ?? null,
        scmTokenExpiresAt: body.scmTokenExpiresAt ?? null,
        role: "owner",
        joinedAt: now,
      });
    });

    log.info("Triggering sandbox spawn for new session");
    this.scheduleWarmSandbox();

    return Response.json({ sessionId, status: "created" });
  }
}
