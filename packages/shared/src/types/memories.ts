import { z } from "zod";
import { repositoriesInputSchema, repositoryPairInputSchema } from "./repositories";

/** Content/catalog lengths use JavaScript string length; write quotas count records, not revisions. */
export const MEMORY_LIMITS = {
  title: 200,
  descriptionMin: 10,
  description: 420,
  directive: 2_000,
  fact: 20_000,
  directiveCharsPerPartition: 6_000,
  directiveRecords: 100,
  directives: 12_000,
  catalog: 24_000,
  catalogRecords: 200,
  rendered: 240_000,
  writesPerSession: 20,
  pendingPerSession: 5,
  archiveNote: 1_000,
} as const;
/** Management list paging; the control plane fetches one extra row to compute `nextOffset`. */
export const MEMORY_LIST_PAGE_SIZE = 50;
export const MEMORY_LIST_MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export const MEMORY_SCOPE_TYPES = ["personal", "repository", "environment"] as const;
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];
export const memoryScopeTypeSchema = z.enum(MEMORY_SCOPE_TYPES);

/**
 * How a request names a memory partition. Repository names are display identity only: the
 * control plane resolves every scope to a stable partition (personal owner, repository ID,
 * environment ID) before storage or authorization, so names never authorize on their own.
 */
export const memoryScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("personal") }).strict(),
  z.object({ type: z.literal("repository"), ...repositoryPairInputSchema.shape }).strict(),
  z.object({ type: z.literal("environment"), environmentId: z.string().min(1).max(200) }).strict(),
]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

/** Exhaustiveness guard for switches over memory unions. */
function unreachable(value: never): never {
  throw new Error(`Unhandled memory variant: ${JSON.stringify(value)}`);
}

/**
 * A stable key for grouping and displaying a scope (e.g. `repository:acme/api`). Not an identity
 * or authorization key: personal omits the owner, and repository names are display names.
 */
export function memoryScopeDisplayKey(scope: MemoryScope): string {
  switch (scope.type) {
    case "personal":
      return "personal";
    case "repository":
      return `repository:${scope.repoOwner.toLowerCase()}/${scope.repoName.toLowerCase()}`;
    case "environment":
      return `environment:${scope.environmentId}`;
    default:
      return unreachable(scope);
  }
}

/** Human-readable scope label for management and diagnostics UIs. */
export function memoryScopeLabel(scope: MemoryScope): string {
  switch (scope.type) {
    case "personal":
      return "Personal";
    case "repository":
      return `${scope.repoOwner}/${scope.repoName}`;
    case "environment":
      return `Environment ${scope.environmentId}`;
    default:
      return unreachable(scope);
  }
}

/** Encode a scope as management-list query parameters (the inverse of {@link memoryScopeFromSearchParams}). */
export function memoryScopeToSearchParams(scope: MemoryScope): URLSearchParams {
  switch (scope.type) {
    case "personal":
      return new URLSearchParams({ scope: "personal" });
    case "repository":
      return new URLSearchParams({
        scope: "repository",
        repoOwner: scope.repoOwner,
        repoName: scope.repoName,
      });
    case "environment":
      return new URLSearchParams({ scope: "environment", environmentId: scope.environmentId });
    default:
      return unreachable(scope);
  }
}

/** Decode management-list query parameters; a missing scope means personal. */
export function memoryScopeFromSearchParams(params: URLSearchParams): MemoryScope | null {
  const type = params.get("scope") ?? "personal";
  const candidate =
    type === "repository"
      ? { type, repoOwner: params.get("repoOwner"), repoName: params.get("repoName") }
      : type === "environment"
        ? { type, environmentId: params.get("environmentId") }
        : { type };
  const parsed = memoryScopeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Content and lifecycle
// ---------------------------------------------------------------------------

export const MEMORY_TYPES = ["fact", "directive"] as const;
export const memoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof memoryTypeSchema>;
export const MEMORY_STATUSES = ["proposed", "active", "archived"] as const;
export const memoryStatusSchema = z.enum(MEMORY_STATUSES);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
/**
 * Why an archived record left circulation: a person archived it (`manual`), a proposal was
 * rejected, or an approved replacement superseded it. Any free-text note is `archiveNote`.
 */
export const MEMORY_ARCHIVE_KINDS = ["manual", "rejected", "superseded"] as const;
export const memoryArchiveKindSchema = z.enum(MEMORY_ARCHIVE_KINDS);
export type MemoryArchiveKind = z.infer<typeof memoryArchiveKindSchema>;
export const MEMORY_AUTHOR_KINDS = ["user", "agent"] as const;
export type MemoryAuthorKind = (typeof MEMORY_AUTHOR_KINDS)[number];

export const MEMORY_ACTIONS = ["approve", "reject", "archive", "restore"] as const;
export const memoryActionNameSchema = z.enum(MEMORY_ACTIONS);
export type MemoryAction = z.infer<typeof memoryActionNameSchema>;

/** The lifecycle facts every transition decision depends on. */
export interface MemoryLifecycleState {
  status: MemoryStatus;
  approvedAt: number | null;
}
export interface MemoryTransitionRule {
  from: readonly MemoryStatus[];
  auditAction: `memory.${string}`;
  to(state: MemoryLifecycleState): { status: MemoryStatus; archiveKind: MemoryArchiveKind | null };
}
/**
 * The complete human lifecycle. Supersession is not an action: approving a replacement archives
 * its predecessor with kind `superseded`. Restore returns a record to its last decided state —
 * never-approved records go back to review, previously approved ones become active again.
 */
export const MEMORY_TRANSITIONS = {
  approve: {
    from: ["proposed"],
    auditAction: "memory.approved",
    to: () => ({ status: "active", archiveKind: null }),
  },
  reject: {
    from: ["proposed"],
    auditAction: "memory.rejected",
    to: () => ({ status: "archived", archiveKind: "rejected" }),
  },
  archive: {
    from: ["proposed", "active"],
    auditAction: "memory.archived",
    to: () => ({ status: "archived", archiveKind: "manual" }),
  },
  restore: {
    from: ["archived"],
    auditAction: "memory.restored",
    to: (state) => ({
      status: state.approvedAt === null ? "proposed" : "active",
      archiveKind: null,
    }),
  },
} as const satisfies Record<MemoryAction, MemoryTransitionRule>;

export function allowedMemoryActions(state: MemoryLifecycleState): MemoryAction[] {
  return MEMORY_ACTIONS.filter((action) =>
    (MEMORY_TRANSITIONS[action].from as readonly MemoryStatus[]).includes(state.status)
  );
}
/** Archived records are immutable until restored. */
export function canReviseMemory(state: MemoryLifecycleState): boolean {
  return state.status !== "archived";
}

export const memoryContentSchema = z
  .object({
    memoryType: memoryTypeSchema,
    title: z.string().trim().min(1).max(MEMORY_LIMITS.title),
    description: z.string().trim().min(MEMORY_LIMITS.descriptionMin).max(MEMORY_LIMITS.description),
    content: z.string().min(1).max(MEMORY_LIMITS.fact),
  })
  .strict()
  .superRefine((value, ctx) => {
    const limit = MEMORY_LIMITS[value.memoryType];
    if (
      value.content.length > limit ||
      new TextEncoder().encode(value.content).length > limit * 4
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: `Content exceeds ${limit} characters`,
      });
    }
  });
export type MemoryContent = z.infer<typeof memoryContentSchema>;
export const MEMORY_CONTENT_KEYS = ["memoryType", "title", "description", "content"] as const;

const memoryIdSchema = z.string().min(1).max(200);

// ---------------------------------------------------------------------------
// Human management API
// ---------------------------------------------------------------------------

/** Caller-editable fields only; identity, approval state, and provenance are server-derived. */
export const createMemorySchema = memoryContentSchema.safeExtend({
  scope: memoryScopeSchema,
  supersedesMemoryId: memoryIdSchema.optional(),
});
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
/** Revisions and lifecycle actions are fenced by the reviewed revision in `If-Match`. */
export const reviseMemorySchema = memoryContentSchema;
const archiveNoteBodySchema = z
  .object({ archiveNote: z.string().trim().max(MEMORY_LIMITS.archiveNote).optional() })
  .strict();
const emptyBodySchema = z.object({}).strict();
/**
 * Request body for each lifecycle action. Only actions that archive accept an `archiveNote`;
 * the others take no fields, so a note can never be silently dropped.
 */
export const memoryActionBodySchemas = {
  approve: emptyBodySchema,
  reject: archiveNoteBodySchema,
  archive: archiveNoteBodySchema,
  restore: emptyBodySchema,
} as const satisfies Record<MemoryAction, z.ZodType>;
export type MemoryActionBody<A extends MemoryAction = MemoryAction> = z.infer<
  (typeof memoryActionBodySchemas)[A]
>;
/** Whether an action's body accepts an `archiveNote` (the actions that archive a record). */
export function memoryActionAcceptsNote(action: MemoryAction): boolean {
  return "archiveNote" in memoryActionBodySchemas[action].shape;
}
export const memoryPreferencesSchema = z.object({ includePersonalMemories: z.boolean() }).strict();
export type MemoryPreferences = z.infer<typeof memoryPreferencesSchema>;
/** Preview the selection a new session would pin, without persisting it. */
export const memoryPreviewSchema = z
  .object({
    repositories: repositoriesInputSchema.optional(),
    environmentId: z.string().min(1).optional(),
    includePersonalMemories: z.boolean().optional(),
  })
  .strict();
export type MemoryPreviewInput = z.input<typeof memoryPreviewSchema>;

const authorFields = {
  authorKind: z.enum(MEMORY_AUTHOR_KINDS),
  authorUserId: z.string().nullable(),
  authorSessionId: z.string().nullable(),
  createdAt: z.number(),
};

/** Immutable content snapshot; its author is the creator/editor of this revision. */
export const memoryRevisionSchema = memoryContentSchema.safeExtend({
  id: z.string(),
  memoryId: z.string(),
  revisionNumber: z.number().int(),
  ...authorFields,
});
export type MemoryRevision = z.infer<typeof memoryRevisionSchema>;

/**
 * Management view of a live record. Server partition identity (owner user, repository ID) is
 * deliberately absent; `capabilities` combines lifecycle rules with the caller's authority.
 */
export const memoryDtoSchema = memoryContentSchema.safeExtend({
  id: z.string(),
  scope: memoryScopeSchema,
  status: memoryStatusSchema,
  archiveKind: memoryArchiveKindSchema.nullable(),
  archiveNote: z.string().nullable(),
  currentRevisionId: z.string(),
  revisionNumber: z.number().int(),
  ...authorFields,
  supersedesMemoryId: z.string().nullable(),
  /** Records that supersede this one (the reverse of `supersedesMemoryId`). */
  supersededByMemoryIds: z.array(z.string()),
  approvedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  updatedAt: z.number(),
  capabilities: z.object({
    canEdit: z.boolean(),
    actions: z.array(memoryActionNameSchema),
  }),
});
export type MemoryDto = z.infer<typeof memoryDtoSchema>;
export const memoryResponseSchema = z.object({ memory: memoryDtoSchema });
export const memoryListResponseSchema = z.object({
  memories: z.array(memoryDtoSchema),
  nextOffset: z.number().int().nullable(),
  canCreate: z.boolean(),
});
export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;
export const memoryRevisionsResponseSchema = z.object({ revisions: z.array(memoryRevisionSchema) });

// ---------------------------------------------------------------------------
// Pinned session selection
// ---------------------------------------------------------------------------

/** Bump when selection semantics change. Provenance only: loaders never branch on it. */
export const MEMORY_SELECTION_VERSION = 1;
/** How a selected record is rendered: directives in full, facts as a catalog summary. */
export const MEMORY_INCLUSIONS = ["full", "summary"] as const;
export const memoryInclusionSchema = z.enum(MEMORY_INCLUSIONS);
export type MemoryInclusion = z.infer<typeof memoryInclusionSchema>;
const MAX_SELECTION_ITEMS = MEMORY_LIMITS.directiveRecords + MEMORY_LIMITS.catalogRecords;

const selectionItemSummarySchema = z.object({
  memoryId: z.string(),
  revisionNumber: z.number().int(),
  scope: memoryScopeSchema,
  memoryType: memoryTypeSchema,
  title: z.string(),
  inclusion: memoryInclusionSchema,
  estimatedTokens: z.number(),
});
/**
 * What a session's memory selection contains, for people: the selected items, their size, and
 * how many records were omitted for budget. Server identity (personal owner, selection hash,
 * versions, timestamps) is deliberately absent. Token counts estimate rendered text.
 */
export const memorySelectionSummarySchema = z.object({
  includePersonalMemories: z.boolean(),
  directiveChars: z.number(),
  catalogChars: z.number(),
  estimatedTokens: z.number(),
  omittedCount: z.number(),
  items: z.array(selectionItemSummarySchema).max(MAX_SELECTION_ITEMS),
});
export type MemorySelectionSummary = z.infer<typeof memorySelectionSummarySchema>;
/** A live session's pinned selection, with whether each item has since been revised or archived. */
export const sessionMemorySelectionStatusSchema = memorySelectionSummarySchema.extend({
  items: z
    .array(
      selectionItemSummarySchema.extend({
        revisedSinceSelection: z.boolean(),
        archivedSinceSelection: z.boolean(),
      })
    )
    .max(MAX_SELECTION_ITEMS),
});
export type SessionMemorySelectionStatus = z.infer<typeof sessionMemorySelectionStatusSchema>;

// ---------------------------------------------------------------------------
// Fact search
// ---------------------------------------------------------------------------

/** Lexical search bounds, independent of the injected catalog's selection budget. */
export const MEMORY_SEARCH_LIMITS = {
  queryMin: 2,
  query: 256,
  terms: 8,
  results: 20,
  defaultResults: 10,
  response: 24_000,
} as const;
/** Literal whitespace-separated terms; there is no wildcard or query-language interpretation. */
export function memorySearchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

/** Optional `repoOwner`/`repoName` selector shared by agent search and write inputs. */
const repositorySelectorShape = {
  repoOwner: repositoryPairInputSchema.shape.repoOwner
    .optional()
    .describe("Repository owner; supply with repoName to pick one of several session repositories"),
  repoName: repositoryPairInputSchema.shape.repoName
    .optional()
    .describe("Repository name; supply with repoOwner to pick one of several session repositories"),
};
function checkRepositorySelector(
  input: { scopeType?: MemoryScopeType; repoOwner?: string; repoName?: string },
  ctx: z.RefinementCtx
): void {
  if ((input.repoOwner === undefined) !== (input.repoName === undefined))
    ctx.addIssue({ code: "custom", message: "repoOwner and repoName must be provided together" });
  if (input.repoOwner !== undefined && input.scopeType !== "repository")
    ctx.addIssue({ code: "custom", message: "Repository selectors require repository scope" });
}

/** Repository filters select session members; environment and personal identity are server-derived. */
export const memorySearchSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(MEMORY_SEARCH_LIMITS.queryMin)
      .max(MEMORY_SEARCH_LIMITS.query)
      .refine(
        (query) => memorySearchTerms(query).length <= MEMORY_SEARCH_LIMITS.terms,
        "Too many search terms"
      )
      .describe("Short literal keywords; every term must match"),
    scopeType: memoryScopeTypeSchema
      .optional()
      .describe("Restrict to one scope type; omit to search every permitted session scope"),
    ...repositorySelectorShape,
    limit: z
      .number()
      .int()
      .min(1)
      .max(MEMORY_SEARCH_LIMITS.results)
      .default(MEMORY_SEARCH_LIMITS.defaultResults),
  })
  .strict()
  .superRefine(checkRepositorySelector);
export type MemorySearchInput = z.infer<typeof memorySearchSchema>;
export const memorySearchResultSchema = z
  .object({
    id: z.string(),
    revisionId: z.string(),
    scope: memoryScopeSchema,
    title: z.string().max(MEMORY_LIMITS.title),
    description: z.string().max(MEMORY_LIMITS.description),
  })
  .strict();
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;
export const memorySearchResponseSchema = z
  .object({
    results: z.array(memorySearchResultSchema).max(MEMORY_SEARCH_LIMITS.results),
    hasMore: z.boolean(),
  })
  .strict();
export type MemorySearchResponse = z.infer<typeof memorySearchResponseSchema>;

// ---------------------------------------------------------------------------
// Sandbox (agent) API — request schemas double as the agent tool input schemas
// ---------------------------------------------------------------------------

export const SANDBOX_MEMORY_SCHEMA_VERSION = 1;
/** A session's pinned selection rendered for its harness, installed as boot-time context. */
export const renderedSessionMemorySchema = z
  .object({
    schemaVersion: z.literal(SANDBOX_MEMORY_SCHEMA_VERSION),
    manifestSha256: z.string(),
    rendered: z.string().max(MEMORY_LIMITS.rendered),
  })
  .strict();
export type RenderedSessionMemory = z.infer<typeof renderedSessionMemorySchema>;

export const sandboxMemoryReadSchema = z
  .object({ memoryId: memoryIdSchema.describe("Memory ID from the catalog or memory_search") })
  .strict();
/** A live active fact, or a body-free notice for a pinned record that has since been archived. */
export const sandboxMemoryReadResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      id: z.string(),
      status: z.literal("active"),
      memoryType: z.literal("fact"),
      scope: memoryScopeSchema,
      title: z.string(),
      description: z.string(),
      content: z.string(),
      revisionId: z.string(),
      revisionNumber: z.number().int(),
      authorKind: z.enum(MEMORY_AUTHOR_KINDS),
      authorUserId: z.string().nullable(),
      authorSessionId: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      status: z.literal("archived"),
      archiveKind: memoryArchiveKindSchema,
      archivedAt: z.number().nullable(),
      archiveNote: z.string().nullable(),
    })
    .strict(),
]);
export type SandboxMemoryReadResult = z.infer<typeof sandboxMemoryReadResultSchema>;

/**
 * Agent writes name a scope relative to the authenticated session. The server infers the
 * session environment or sole repository; `repoOwner`/`repoName` only disambiguate
 * multi-repository sessions. Personal owner and environment identity are never caller-supplied.
 */
export const sandboxMemoryWriteSchema = memoryContentSchema
  .safeExtend({
    scopeType: memoryScopeTypeSchema.describe(
      "Where to store the memory, relative to this session"
    ),
    ...repositorySelectorShape,
    supersedesMemoryId: memoryIdSchema
      .optional()
      .describe("Active memory in the same scope that this one replaces"),
  })
  .superRefine(checkRepositorySelector);
export type SandboxMemoryWriteInput = z.infer<typeof sandboxMemoryWriteSchema>;
export const sandboxMemoryWriteResultSchema = z
  .object({ id: z.string(), status: memoryStatusSchema, revisionId: z.string() })
  .strict();
export type SandboxMemoryWriteResult = z.infer<typeof sandboxMemoryWriteResultSchema>;
