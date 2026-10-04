import { env } from "cloudflare:test";
import type { SessionListRepository } from "@open-inspect/shared/types/repositories";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { SessionIndexStore } from "../../src/db/session-index";
import type { AuthorizedMemoryTarget } from "../../src/authorization/memory-access";
import { resolveSessionMemory } from "../../src/memory/resolve-session-memory";
import { inheritedPin, resolvedPin } from "../../src/session/pinned";

interface MemorySessionOptions {
  userId: string;
  repositories?: SessionListRepository[];
  environmentId?: string | null;
  ownerTeamId?: string | null;
  visibility?: SessionVisibility;
  status?: SessionStatus;
  includePersonalMemories?: boolean;
  parentSessionId?: string;
}

/**
 * A memory target that skips `SharedMemoryAccess.authorizeTarget`: tests seed users and grants explicitly and
 * assert access at the read/write boundary, which rechecks grants on every request.
 */
export function memoryTargetForTest(target: {
  userId: string | null;
  repositories?: readonly { repoOwner: string; repoName: string; repoId?: number | null }[];
  environmentId?: string | null;
}): AuthorizedMemoryTarget {
  return {
    userId: target.userId,
    repositories: (target.repositories ?? []).map((repo) => ({
      repoOwner: repo.repoOwner,
      repoName: repo.repoName,
      repoId: repo.repoId ?? null,
    })),
    environmentId: target.environmentId ?? null,
  } as unknown as AuthorizedMemoryTarget;
}

/**
 * Persist a real session and its memory selection in the same D1 batch.
 * Callers seed users/grants and bind sandbox credentials explicitly; this helper
 * neither authorizes scopes nor mocks the resolver or session-memory store.
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
      ? { parentSessionId: options.parentSessionId, memory: inheritedPin(options.parentSessionId) }
      : {
          memory: resolvedPin(
            await resolveSessionMemory(
              env.DB,
              memoryTargetForTest({ userId: options.userId, repositories, environmentId }),
              options.includePersonalMemories ?? true
            )
          ),
        }),
  });
}
