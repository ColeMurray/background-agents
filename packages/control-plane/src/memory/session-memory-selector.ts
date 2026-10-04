import type { SessionMemorySelection } from "./types";
import type { SessionMemoryAccessPolicy } from "../authorization/memory-access";
import type { MemoryPreferenceStore } from "../db/memory-preferences";
import type { MemoryRecordStore } from "../db/memory-records";
import type { MemoryPartition } from "./partition";
import { selectWithinBudget } from "./selection";
import { repositoryPartition, sourcePartitions } from "./sources";
import type { MemorySources, SessionPrincipal } from "./types";

/** What a new root session (or a preview of one) targets. */
export interface SessionMemorySelectionRequest {
  principal: SessionPrincipal;
  repositories: readonly { repoOwner: string; repoName: string; repoId?: number | null }[];
  environmentId: string | null;
  /** Overrides the owner's saved default for this session. */
  includePersonalMemories?: boolean;
}

/** Dependencies injected into SessionMemorySelector. */
export interface SessionMemorySelectorDeps {
  /** Owner defaults for including personal memory. */
  preferences: Pick<MemoryPreferenceStore, "get">;
  /** Bounded selection candidates from the memory records. */
  records: Pick<MemoryRecordStore, "listCandidates">;
  /** Whether the session principal may read each shared partition. */
  access: Pick<SessionMemoryAccessPolicy, "check">;
}

/**
 * Chooses the memories a new root session pins. Shared partitions the principal cannot read are
 * omitted — memory never decides whether a session can exist; that is `authorizeSessionTarget`'s
 * job. Children copy their parent's selection instead, so later preferences or grants cannot
 * widen delegated context.
 */
export class SessionMemorySelector {
  constructor(private readonly deps: SessionMemorySelectorDeps) {}

  async select(request: SessionMemorySelectionRequest): Promise<SessionMemorySelection> {
    const owner = request.principal.userId;
    const include =
      request.includePersonalMemories ??
      (owner ? (await this.deps.preferences.get(owner)).includePersonalMemories : false);
    const target: MemorySources = {
      personalOwnerUserId: include ? owner : null,
      repositories: await this.readableRepositories(request),
      environmentId: await this.readableEnvironment(request),
    };
    const { candidates, omittedCount } = await this.deps.records.listCandidates(
      sourcePartitions(target)
    );
    return selectWithinBudget(candidates, target, omittedCount);
  }

  /** Repositories with a stable ID whose memories the principal may read. */
  private async readableRepositories(request: SessionMemorySelectionRequest) {
    const readable: { repoOwner: string; repoName: string; repoId: number }[] = [];
    for (const repo of request.repositories) {
      const partition = repositoryPartition({ ...repo, repoId: repo.repoId ?? null });
      if (partition && (await this.canRead(request, partition)))
        readable.push({
          repoOwner: repo.repoOwner,
          repoName: repo.repoName,
          repoId: partition.repoId,
        });
    }
    return readable;
  }

  private async readableEnvironment(request: SessionMemorySelectionRequest) {
    const { environmentId } = request;
    return environmentId && (await this.canRead(request, { type: "environment", environmentId }))
      ? environmentId
      : null;
  }

  private async canRead(
    request: SessionMemorySelectionRequest,
    partition: MemoryPartition
  ): Promise<boolean> {
    return (await this.deps.access.check(request.principal, [partition])).kind === "granted";
  }
}
