import { env } from "cloudflare:test";
import type { SessionListRepository } from "@open-inspect/shared/types/repositories";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { SessionIndexStore } from "../../src/db/session-index";
import { MemoryPreferenceStore } from "../../src/db/memory-preferences";
import { MemoryRecordStore } from "../../src/db/memory-records";
import { SessionMemorySelector } from "../../src/memory/session-memory-selector";
import { resolvedPin } from "../../src/session/pinned";
import { queryDO } from "./helpers";

interface MemorySessionOptions {
  userId: string;
  repositories?: SessionListRepository[];
  environmentId?: string | null;
  ownerTeamId?: string | null;
  visibility?: SessionVisibility;
  status?: SessionStatus;
  includePersonalMemories?: boolean;
  parentSessionId?: string;
  /** Whose prompt spawned a child; defaults to the child's owner, as the spawn route assigns. */
  spawnedByUserId?: string | null;
}

/**
 * A selector over the real stores whose access check grants every shared partition. Tests seed
 * users and grants explicitly and assert access at the read/write boundary, which rechecks grants
 * on every request; selection-time filtering is covered by the selector's unit tests.
 */
export function memorySelectorForTest(): SessionMemorySelector {
  return new SessionMemorySelector({
    preferences: new MemoryPreferenceStore(env.DB),
    records: new MemoryRecordStore(env.DB),
    access: { check: async () => ({ kind: "granted" }) },
  });
}

/**
 * Persist a real session and its memory selection in the same D1 batch.
 * Callers seed users/grants and bind sandbox credentials explicitly; this helper
 * neither authorizes scopes nor mocks the session-memory stores.
 */
export async function seedMemorySession(id: string, options: MemorySessionOptions) {
  const repositories = options.repositories ?? [];
  const environmentId = options.environmentId ?? null;
  await new SessionIndexStore(env.DB).create({
    id,
    title: null,
    userId: options.userId,
    ownerTeamId: options.ownerTeamId ?? null,
    visibility: options.visibility ?? "private",
    repoOwner: repositories[0]?.repoOwner ?? null,
    repoName: repositories[0]?.repoName ?? null,
    repositories,
    environmentId,
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: repositories[0]?.baseBranch ?? null,
    status: options.status ?? "active",
    createdAt: 1,
    updatedAt: 1,
    ...(options.parentSessionId
      ? {
          parentSessionId: options.parentSessionId,
          memory: {
            kind: "inherited" as const,
            parentSessionId: options.parentSessionId,
            promptAuthorUserId:
              options.spawnedByUserId === undefined ? options.userId : options.spawnedByUserId,
          },
        }
      : {
          memory: resolvedPin(
            await memorySelectorForTest().select({
              principal: { userId: options.userId, ownerTeamId: options.ownerTeamId ?? null },
              repositories,
              environmentId,
              includePersonalMemories: options.includePersonalMemories ?? true,
            })
          ),
        }),
  });
}

let seededPrompts = 0;

/**
 * Record a prompt in the session runtime, as sandbox memory calls see it. A `processing` prompt
 * makes `canonicalUserId` the author the agent is serving (finishing any earlier one); a
 * `completed` prompt is an earlier one that reached the agent. A null account models an
 * integration author such as Autofix.
 */
export async function seedPrompt(
  stub: DurableObjectStub,
  canonicalUserId: string | null,
  status: "processing" | "completed" = "processing"
): Promise<void> {
  const n = ++seededPrompts;
  const participantId = `memory-participant-${n}`;
  if (status === "processing")
    await queryDO(stub, "UPDATE messages SET status = 'completed' WHERE status = 'processing'");
  await queryDO(
    stub,
    "INSERT INTO participants (id, user_id, canonical_user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)",
    participantId,
    canonicalUserId ?? `github:${n}`,
    canonicalUserId,
    n
  );
  await queryDO(
    stub,
    `INSERT INTO messages (id, author_id, author_canonical_user_id, content, source, status, created_at, started_at)
     VALUES (?, ?, ?, 'Prompt', ?, ?, ?, ?)`,
    `memory-prompt-${n}`,
    participantId,
    canonicalUserId,
    canonicalUserId ? "web" : "github",
    status,
    n,
    n
  );
}
