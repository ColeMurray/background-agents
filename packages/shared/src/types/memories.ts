import { z } from "zod";
import { repositoryPairInputSchema } from "./repositories";

/** Content/catalog lengths use JavaScript string length; write quotas count records, not revisions. */
export const MEMORY_LIMITS = {
  title: 200,
  description: 420,
  directive: 2_000,
  fact: 20_000,
  directiveScope: 6_000,
  directiveRecords: 100,
  directives: 12_000,
  catalog: 24_000,
  catalogRecords: 200,
  rendered: 240_000,
  writesPerSession: 20,
  pendingPerSession: 5,
} as const;

export const memoryScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("personal") }).strict(),
  z.object({ type: z.literal("repository"), ...repositoryPairInputSchema.shape }).strict(),
  z.object({ type: z.literal("environment"), environmentId: z.string().min(1).max(200) }).strict(),
]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export const memoryTypeSchema = z.enum(["fact", "directive"]);
export const memoryStatusSchema = z.enum(["proposed", "active", "archived"]);
export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export const memoryContentSchema = z
  .object({
    memoryType: memoryTypeSchema,
    title: z.string().trim().min(1).max(MEMORY_LIMITS.title),
    description: z.string().trim().min(10).max(MEMORY_LIMITS.description),
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
/** Caller-editable fields only; identity, approval state, and provenance are server-derived. */
export const createMemorySchema = memoryContentSchema.safeExtend({
  scope: memoryScopeSchema,
  supersedesMemoryId: z.string().min(1).max(200).optional(),
});
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export const reviseMemorySchema = memoryContentSchema.safeExtend({
  expectedRevisionId: z.string().min(1),
});
export const memoryActionSchema = z
  .object({
    expectedRevisionId: z.string().min(1),
    reason: z.string().max(1_000).optional(),
  })
  .strict();
export const memoryPreferencesSchema = z.object({ includePersonalMemories: z.boolean() }).strict();
export type MemoryPreferences = z.infer<typeof memoryPreferencesSchema>;

/** Immutable content snapshot; its author is the creator/editor of this revision. */
export interface MemoryRevision extends MemoryContent {
  id: string;
  memoryId: string;
  revisionNumber: number;
  authorKind: "user" | "agent";
  authorUserId: string | null;
  authorSessionId: string | null;
  createdAt: number;
}
/** Live record/current content; author fields retain the original creator across later edits. */
export interface MemoryRecord extends MemoryContent {
  id: string;
  scope: MemoryScope;
  ownerUserId: string | null;
  repoId?: number | null;
  status: MemoryStatus;
  currentRevisionId: string;
  revisionNumber: number;
  authorKind: "user" | "agent";
  authorUserId: string | null;
  authorSessionId: string | null;
  supersedesMemoryId: string | null;
  replacementMemoryIds?: string[];
  approvedAt: number | null;
  archivedAt: number | null;
  archiveReason: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface MemoryCapabilities {
  canEdit: boolean;
  canArchive: boolean;
  canApprove: boolean;
}
export type MemoryView = MemoryRecord & { capabilities: MemoryCapabilities };
/** One selected revision; omitted records are counted, never persisted as items. */
export interface SessionMemoryItem {
  memoryId: string;
  revisionId: string;
  revisionNumber: number;
  scope: MemoryScope;
  memoryType: MemoryType;
  title: string;
  inclusion: "directive" | "catalog";
  estimatedTokens: number;
}
/**
 * Session-lifetime selection inherited by children and reused on sandbox restore.
 * Pinning preserves injected context, but does not authorize management or bypass current grants.
 * Token estimates include rendering overhead and are not provider-measured consumption.
 */
export interface SessionMemoryManifest {
  resolverVersion: number;
  manifestSha256: string;
  resolvedAt: number;
  includePersonalMemories: boolean;
  personalOwnerUserId: string | null;
  directiveChars: number;
  catalogChars: number;
  estimatedTokens: number;
  truncatedCount: number;
  items: SessionMemoryItem[];
}

/** Live diagnostics are required at the inspection boundary, not part of the immutable selection. */
export interface SessionMemoryDiagnostics extends Omit<SessionMemoryManifest, "items"> {
  items: (SessionMemoryItem & { changed: boolean; archived: boolean })[];
}
/** Renderable pinned data with no misleading live status, timestamps, or revision provenance. */
export interface PinnedMemoryRevision extends MemoryContent {
  memoryId: string;
  revisionId: string;
  scope: MemoryScope;
  repoId: number | null;
}

const authorFields = {
  authorKind: z.enum(["user", "agent"]),
  authorUserId: z.string().nullable(),
  authorSessionId: z.string().nullable(),
  createdAt: z.number(),
};
export const memoryRevisionSchema: z.ZodType<MemoryRevision> = memoryContentSchema.safeExtend({
  id: z.string(),
  memoryId: z.string(),
  revisionNumber: z.number().int(),
  ...authorFields,
});
export const memoryRecordSchema = memoryContentSchema.safeExtend({
  id: z.string(),
  scope: memoryScopeSchema,
  repoId: z.number().nullable().optional(),
  ownerUserId: z.string().nullable(),
  status: memoryStatusSchema,
  currentRevisionId: z.string(),
  revisionNumber: z.number().int(),
  ...authorFields,
  supersedesMemoryId: z.string().nullable(),
  replacementMemoryIds: z.array(z.string()).optional(),
  approvedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  archiveReason: z.string().nullable(),
  updatedAt: z.number(),
});
export const memoryViewSchema: z.ZodType<MemoryView> = memoryRecordSchema.safeExtend({
  capabilities: z.object({
    canEdit: z.boolean(),
    canArchive: z.boolean(),
    canApprove: z.boolean(),
  }),
});
const sessionMemoryItemSchema = z.object({
  memoryId: z.string(),
  revisionId: z.string(),
  revisionNumber: z.number().int(),
  scope: memoryScopeSchema,
  memoryType: memoryTypeSchema,
  title: z.string(),
  inclusion: z.enum(["directive", "catalog"]),
  estimatedTokens: z.number(),
});
export const sessionMemoryManifestSchema = z.object({
  resolverVersion: z.number().int(),
  manifestSha256: z.string(),
  resolvedAt: z.number(),
  includePersonalMemories: z.boolean(),
  personalOwnerUserId: z.string().nullable(),
  directiveChars: z.number(),
  catalogChars: z.number(),
  estimatedTokens: z.number(),
  truncatedCount: z.number(),
  items: z
    .array(sessionMemoryItemSchema)
    .max(MEMORY_LIMITS.directiveRecords + MEMORY_LIMITS.catalogRecords),
});
export const sessionMemoryDiagnosticsSchema: z.ZodType<SessionMemoryDiagnostics> =
  sessionMemoryManifestSchema.extend({
    items: z
      .array(sessionMemoryItemSchema.extend({ changed: z.boolean(), archived: z.boolean() }))
      .max(MEMORY_LIMITS.directiveRecords + MEMORY_LIMITS.catalogRecords),
  });
