import { z } from "zod";
import { recordSchema, type AgentResponse } from "./artifacts";
import { sessionRepositoriesInputSchema } from "./repositories";
import type { EventResponse } from "./sandbox-events";
import type { Session } from "./sessions";
import {
  sessionStatusSchema,
  spawnSourceSchema,
  type SandboxStatus,
  type SessionStatus,
} from "./statuses";

export interface UserPreferences {
  userId: string;
  model?: string;
  reasoningEffort?: string;
  branch?: string;
  updatedAt: number;
}

export const userPreferencesRequestSchema = z.object({
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
});

export type UserPreferencesRequest = z.infer<typeof userPreferencesRequestSchema>;

export interface SlackCallbackContext {
  source: "slack";
  channel: string;
  threadTs: string;
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  reactionMessageTs?: string;
}

export interface LinearCallbackContext {
  source: "linear";
  issueId: string;
  issueIdentifier: string;
  issueUrl: string;
  repoFullName: string;
  model: string;
  agentSessionId?: string;
  organizationId?: string;
  /** Installed Linear app-user identity used to verify runtime credentials. */
  appUserId?: string;
  emitToolProgressActivities?: boolean;
}

export interface AutomationCallbackContext {
  source: "automation";
  automationId: string;
  runId: string;
  automationName: string;
}

export type CallbackContext =
  | SlackCallbackContext
  | LinearCallbackContext
  | AutomationCallbackContext;

function hasRepositoryIdentifier(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

interface CreateSessionRepositoryFields {
  repoOwner?: string | null;
  repoName?: string | null;
  branch?: string;
}

function hasMatchingRepositoryIdentifiers(data: CreateSessionRepositoryFields): boolean {
  return hasRepositoryIdentifier(data.repoOwner) === hasRepositoryIdentifier(data.repoName);
}

function hasRepositoryForBranch(data: CreateSessionRepositoryFields): boolean {
  return hasRepositoryIdentifier(data.repoOwner) || !data.branch?.trim();
}

function hasScalarRepositoryTarget(data: CreateSessionRepositoryFields): boolean {
  return (
    hasRepositoryIdentifier(data.repoOwner) ||
    hasRepositoryIdentifier(data.repoName) ||
    Boolean(data.branch?.trim())
  );
}

function hasExclusiveSessionTarget(
  data: CreateSessionRepositoryFields & {
    repositories?: unknown[] | null;
    environmentId?: string | null;
  }
): boolean {
  // At most one target mode may be selected: a named environment
  // (environmentId), an ad-hoc repository list (repositories), or the scalar
  // repoOwner/repoName/branch form. Presence-based, not length-based: any
  // provided array selects the list mode (sessionRepositoriesInputSchema
  // separately rejects empty lists, so [] can never smuggle another mode
  // through).
  const activeModes = [
    Boolean(data.repositories),
    hasRepositoryIdentifier(data.environmentId),
    hasScalarRepositoryTarget(data),
  ].filter(Boolean).length;
  return activeModes <= 1;
}

const createSessionRequestBaseSchema = z.object({
  repoOwner: z.string().trim().min(1).nullish(),
  repoName: z.string().trim().min(1).nullish(),
  title: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  branch: z.string().optional(),
  /**
   * Ordered repository list ([0] = primary). Mutually exclusive with the
   * scalar repoOwner/repoName/branch fields and environmentId.
   */
  repositories: sessionRepositoriesInputSchema.optional(),
  /**
   * Launch from a named environment: its snapshotted repositories become the
   * session's repository list and sessions.environment_id records provenance
   * (design §5.5/§7.6). Mutually exclusive with repositories and the scalar
   * fields.
   */
  environmentId: z.string().trim().min(1).nullish(),
});

export const createSessionRequestSchema = createSessionRequestBaseSchema
  .refine(hasMatchingRepositoryIdentifiers, {
    message: "repoOwner and repoName must be provided together",
    path: ["repoName"],
  })
  .refine(hasRepositoryForBranch, {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  })
  .refine(hasExclusiveSessionTarget, {
    message: "environmentId, repositories, and repoOwner/repoName/branch are mutually exclusive",
    path: ["repositories"],
  });

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionInputSchema = createSessionRequestBaseSchema
  .extend({
    userId: z.string().optional(),
    spawnSource: spawnSourceSchema.optional(),
    authProvider: z.enum(["github", "google"]).optional(),
    authUserId: z.string().optional(),
    authEmail: z.string().optional(),
    authName: z.string().optional(),
    authAvatarUrl: z.string().optional(),
    scmUserId: z.string().optional(),
    scmLogin: z.string().optional(),
    scmName: z.string().optional(),
    scmEmail: z.string().optional(),
    scmAvatarUrl: z.string().optional(),
    actorUserId: z.string().optional(),
    actorDisplayName: z.string().optional(),
    actorEmail: z.string().optional(),
    actorAvatarUrl: z.string().optional(),
    scmToken: z.string().optional(),
    scmRefreshToken: z.string().optional(),
    scmTokenExpiresAt: z.number().optional(),
  })
  .refine(hasMatchingRepositoryIdentifiers, {
    message: "repoOwner and repoName must be provided together",
    path: ["repoName"],
  })
  .refine(hasRepositoryForBranch, {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  })
  .refine(hasExclusiveSessionTarget, {
    message: "environmentId, repositories, and repoOwner/repoName/branch are mutually exclusive",
    path: ["repositories"],
  });

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export const createMediaArtifactRequestSchema = z.object({
  artifactId: z.string(),
  artifactType: z.string(),
  objectKey: z.string(),
  metadata: recordSchema.optional(),
});

export type CreateMediaArtifactRequest = z.infer<typeof createMediaArtifactRequestSchema>;

export const createSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  status: sessionStatusSchema,
});

export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

export const sendPromptResponseSchema = z.object({
  messageId: z.string().min(1),
  status: z.literal("queued").optional(),
});

export type SendPromptResponse = z.infer<typeof sendPromptResponseSchema>;

export interface ListSessionsResponse {
  sessions: Session[];
  cursor?: string;
  hasMore: boolean;
}

/** Request body for POST /sessions/:parentId/children. */
export const spawnChildSessionRequestSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
});

export type SpawnChildSessionRequest = z.infer<typeof spawnChildSessionRequestSchema>;

/**
 * Returned by the parent Durable Object's GET /internal/spawn-context.
 *
 * Deliberately scalar in v1: child sessions inherit — and are restricted to —
 * the parent's PRIMARY repository, even for multi-repo parents. The spawn
 * route validates against the scalar mirror. Letting children target another
 * repository requires spawnContext.repositories, a named fast-follow (design
 * §13.13), not a v1 promise.
 */
export const spawnContextSchema = z.object({
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  repoId: z.number().nullable(),
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  baseBranch: z.string().nullable(),
  owner: z.object({
    userId: z.string(),
    scmUserId: z.string().nullable(),
    scmLogin: z.string().nullable(),
    scmName: z.string().nullable(),
    scmEmail: z.string().nullable(),
    scmAccessTokenEncrypted: z.string().nullable(),
    scmRefreshTokenEncrypted: z.string().nullable(),
    scmTokenExpiresAt: z.number().nullable(),
  }),
});

export type SpawnContext = z.infer<typeof spawnContextSchema>;

/** Returned by the child Durable Object's GET /internal/child-summary. */
export interface ChildSessionFinalResponse extends AgentResponse {
  messageId: string;
  completedAt: number | null;
  eventCount: number;
  eventLimitReached: boolean;
}

export interface ChildSessionTrajectory {
  events: EventResponse[];
  hasMore: boolean;
  cursor?: string;
  limit: number;
}

export interface ChildSessionDetail {
  session: {
    id: string;
    title: string;
    status: SessionStatus;
    repoOwner: string | null;
    repoName: string | null;
    branchName: string | null;
    model: string;
    createdAt: number;
    updatedAt: number;
  };
  sandbox: { status: SandboxStatus } | null;
  artifacts: Array<{ type: string; url: string; metadata: unknown }>;
  recentEvents: Array<{ type: string; data: unknown; createdAt: number }>;
  finalResponse?: ChildSessionFinalResponse | null;
  trajectory?: ChildSessionTrajectory;
}
