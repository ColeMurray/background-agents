import type { SessionMemoryManifest } from "@open-inspect/shared/types/memories";
import type { AuthorizedMemoryTarget } from "../authorization/memory-access";
import { MemoryPreferenceStore } from "../db/memory-preferences";
import { MemoryStore } from "../db/memories";
import type { SqlDatabase } from "../db/sql-database";
import { buildManifest } from "./selection";
import { targetPartitions } from "./target";
import type { MemoryTarget } from "./types";

/**
 * Resolve the selection a new root session (or preview) pins. Personal inclusion follows the
 * explicit override, then the owner's saved default. Children copy their parent's manifest
 * instead of calling this, so later preferences or grants cannot widen delegated context.
 */
export async function resolveSessionMemory(
  db: SqlDatabase,
  target: AuthorizedMemoryTarget,
  includePersonalMemories?: boolean
): Promise<SessionMemoryManifest> {
  const include =
    includePersonalMemories ??
    (target.userId
      ? (await new MemoryPreferenceStore(db).get(target.userId)).includePersonalMemories
      : false);
  const memoryTarget: MemoryTarget = {
    personalOwnerUserId: include ? target.userId : null,
    repositories: target.repositories,
    environmentId: target.environmentId,
  };
  const { candidates, omittedCount } = await new MemoryStore(db).listCandidates(
    targetPartitions(memoryTarget)
  );
  return buildManifest(candidates, memoryTarget, omittedCount);
}
