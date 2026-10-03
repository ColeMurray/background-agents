import { env } from "cloudflare:test";
import type { SessionListRepository } from "@open-inspect/shared/types/repositories";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { SessionIndexStore } from "../../src/db/session-index";
import { resolveSessionMemory } from "../../src/session/memory-resolution";

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
      ? {
          parentSessionId: options.parentSessionId,
          memoryManifestSourceSessionId: options.parentSessionId,
        }
      : {
          memoryManifest: await resolveSessionMemory(
            env.DB,
            { canonicalUserId: options.userId, repositories, environmentId },
            options.includePersonalMemories ?? true
          ),
        }),
  });
}
