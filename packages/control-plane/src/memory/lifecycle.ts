import type { MemoryStatus, MemoryType } from "@open-inspect/shared/types/memories";
import type { MemoryPartition } from "./partition";
import type { MemoryActor } from "./types";

/**
 * Status of a newly created record. Human writes are active. Agent writes are proposals, except
 * personal facts from sessions eligible for auto-save (the store rechecks eligibility at commit);
 * replacing a directive always needs review.
 */
export function initialStatus(
  memoryType: MemoryType,
  partition: MemoryPartition,
  actor: MemoryActor,
  predecessor: { memoryType: MemoryType } | null,
  personalAutoSaveEligible: boolean
): MemoryStatus {
  if (actor.kind === "user") return "active";
  const autoSaves =
    personalAutoSaveEligible &&
    partition.type === "personal" &&
    memoryType === "fact" &&
    predecessor?.memoryType !== "directive";
  return autoSaves ? "active" : "proposed";
}
