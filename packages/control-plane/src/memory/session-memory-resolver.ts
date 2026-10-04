import type { SessionMemoryManifest } from "@open-inspect/shared/types/memories";
import type { AuthorizedMemoryTarget } from "../authorization/memory-access";
import type { MemoryPreferenceStore } from "../db/memory-preferences";
import type { MemoryRecordStore } from "../db/memory-records";
import { buildManifest } from "./selection";
import { targetPartitions } from "./target";
import type { MemoryTarget } from "./types";

/** Dependencies injected into SessionMemoryResolver. */
export interface SessionMemoryResolverDeps {
  /** Owner defaults for including personal memory. */
  preferences: Pick<MemoryPreferenceStore, "get">;
  /** Bounded selection candidates from the memory records. */
  records: Pick<MemoryRecordStore, "listCandidates">;
}

/**
 * Resolve the selection a new root session (or preview) pins. Children copy their parent's
 * manifest instead of resolving, so later preferences or grants cannot widen delegated context.
 */
export class SessionMemoryResolver {
  constructor(private readonly deps: SessionMemoryResolverDeps) {}

  /** Personal inclusion follows the explicit override, then the owner's saved default. */
  async resolve(
    target: AuthorizedMemoryTarget,
    includePersonalMemories?: boolean
  ): Promise<SessionMemoryManifest> {
    const include =
      includePersonalMemories ??
      (target.userId
        ? (await this.deps.preferences.get(target.userId)).includePersonalMemories
        : false);
    const memoryTarget: MemoryTarget = {
      personalOwnerUserId: include ? target.userId : null,
      repositories: target.repositories,
      environmentId: target.environmentId,
    };
    const { candidates, omittedCount } = await this.deps.records.listCandidates(
      targetPartitions(memoryTarget)
    );
    return buildManifest(candidates, memoryTarget, omittedCount);
  }
}
