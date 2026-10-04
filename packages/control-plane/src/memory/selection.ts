import { DEFAULT_HARNESS } from "@open-inspect/shared/harnesses";
import { MEMORY_LIMITS, MEMORY_SELECTION_VERSION } from "@open-inspect/shared/types/memories";
import type { SessionMemoryItem, SessionMemorySelection } from "./types";
import { hashToken } from "../auth/crypto";
import { partitionKey, partitionScope, type MemoryPartition } from "./partition";
import {
  MEMORY_SECTION_OVERHEAD_CHARS,
  renderMemoryEntry,
  renderMemorySection,
  type RenderableMemory,
} from "./render";
import { sourcePartitions } from "./sources";
import type { MemoryCandidate, MemorySources } from "./types";

const partitionId = (partition: MemoryPartition) => `${partition.type}:${partitionKey(partition)}`;

/**
 * Deterministic order: target partition priority (environment, repositories, personal), then
 * directives before facts; oldest directives and most recently updated facts first; ID tie-break.
 * Inactive records and records outside the target are dropped.
 */
export function orderCandidates(
  candidates: readonly MemoryCandidate[],
  target: MemorySources
): MemoryCandidate[] {
  const priority = sourcePartitions(target).map(partitionId);
  return candidates
    .filter(
      (candidate) =>
        candidate.status === "active" && priority.includes(partitionId(candidate.partition))
    )
    .sort((a, b) => {
      const byPartition =
        priority.indexOf(partitionId(a.partition)) - priority.indexOf(partitionId(b.partition));
      if (byPartition) return byPartition;
      if (a.memoryType !== b.memoryType) return a.memoryType === "directive" ? -1 : 1;
      return (
        (a.memoryType === "directive" ? a.createdAt - b.createdAt : b.updatedAt - a.updatedAt) ||
        a.id.localeCompare(b.id)
      );
    });
}

function renderable(candidate: MemoryCandidate): RenderableMemory {
  const base = {
    memoryId: candidate.id,
    scope: partitionScope(candidate.partition),
    title: candidate.title,
  };
  return candidate.memoryType === "directive"
    ? { ...base, inclusion: "full", content: candidate.content }
    : { ...base, inclusion: "summary", description: candidate.description };
}

/**
 * Admission budget for one selection.
 *
 * Every limit is sticky: once a category (all directives, one partition's directives, the fact
 * catalog, the rendered section) overflows, it stays closed even for smaller later candidates.
 * The selection is therefore always a prefix of each ordered category, so a new record can only
 * push out the tail and never reshuffles earlier choices. Do not "pack" small entries in.
 */
class MemoryBudget {
  directiveChars = 0;
  catalogChars = 0;
  private directiveCount = 0;
  private factCount = 0;
  private renderedChars = MEMORY_SECTION_OVERHEAD_CHARS;
  private readonly partitionChars = new Map<string, number>();
  private readonly closed = new Set<string>();

  private fits(category: string, overflows: boolean): boolean {
    if (overflows) this.closed.add(category);
    return !this.closed.has(category);
  }

  admit(candidate: MemoryCandidate, entryChars: number): boolean {
    const rendered = this.fits(
      "rendered",
      this.renderedChars + entryChars > MEMORY_LIMITS.rendered
    );
    let admitted: boolean;
    let chars: number;
    if (candidate.memoryType === "directive") {
      const partition = `directives:${partitionId(candidate.partition)}`;
      chars = candidate.content.length;
      const partitionTotal = (this.partitionChars.get(partition) ?? 0) + chars;
      admitted = [
        this.fits(partition, partitionTotal > MEMORY_LIMITS.directiveCharsPerPartition),
        this.fits("directives", this.directiveChars + chars > MEMORY_LIMITS.directives),
        this.fits("directiveRecords", this.directiveCount >= MEMORY_LIMITS.directiveRecords),
      ].every(Boolean);
      if (admitted && rendered) {
        this.partitionChars.set(partition, partitionTotal);
        this.directiveChars += chars;
        this.directiveCount++;
      }
    } else {
      chars = candidate.title.length + candidate.description.length;
      admitted = this.fits(
        "catalog",
        this.catalogChars + chars > MEMORY_LIMITS.catalog ||
          this.factCount >= MEMORY_LIMITS.catalogRecords
      );
      if (admitted && rendered) {
        this.catalogChars += chars;
        this.factCount++;
      }
    }
    if (!admitted || !rendered) return false;
    this.renderedChars += entryChars;
    return true;
  }
}

/** Hash the pinned selection only: never timestamps or mutable user aliases (merges keep it). */
async function hashSelection(
  includePersonalMemories: boolean,
  items: readonly SessionMemoryItem[]
): Promise<string> {
  return hashToken(
    `OPEN_INSPECT_MEMORY_MANIFEST_V1\0${JSON.stringify([includePersonalMemories, items.map((item) => [item.memoryId, item.revisionId, item.inclusion])])}`
  );
}

/**
 * Select whole records within budget; omitted records only increment an aggregate count.
 * Token counts estimate rendered text, not provider-measured consumption.
 */
export async function selectWithinBudget(
  candidates: readonly MemoryCandidate[],
  target: MemorySources,
  omittedByQuery = 0,
  resolvedAt = Date.now()
): Promise<SessionMemorySelection> {
  const budget = new MemoryBudget();
  const selected: (RenderableMemory & { revisionId: string })[] = [];
  const items: SessionMemoryItem[] = [];
  let omittedCount = omittedByQuery;
  for (const candidate of orderCandidates(candidates, target)) {
    const entry = renderable(candidate);
    if (!budget.admit(candidate, renderMemoryEntry(entry).length + 1)) {
      omittedCount++;
      continue;
    }
    selected.push({ ...entry, revisionId: candidate.currentRevisionId });
    const chars =
      entry.inclusion === "full"
        ? entry.content.length
        : candidate.title.length + candidate.description.length;
    items.push({
      memoryId: candidate.id,
      revisionId: candidate.currentRevisionId,
      revisionNumber: candidate.revisionNumber,
      scope: entry.scope,
      memoryType: candidate.memoryType,
      title: candidate.title,
      inclusion: entry.inclusion,
      estimatedTokens: Math.ceil(chars / 4),
    });
  }
  const includePersonalMemories = target.personalOwnerUserId !== null;
  const manifest: SessionMemorySelection = {
    selectionVersion: MEMORY_SELECTION_VERSION,
    manifestSha256: await hashSelection(includePersonalMemories, items),
    resolvedAt,
    includePersonalMemories,
    personalOwnerUserId: target.personalOwnerUserId,
    directiveChars: budget.directiveChars,
    catalogChars: budget.catalogChars,
    estimatedTokens: 0,
    omittedCount,
    items,
  };
  manifest.estimatedTokens = Math.ceil(
    renderMemorySection(manifest, selected, DEFAULT_HARNESS).length / 4
  );
  return manifest;
}

/** The selection of a session that predates memory (or has nothing to pin). */
export function emptySelection(resolvedAt: number): Promise<SessionMemorySelection> {
  return selectWithinBudget(
    [],
    { personalOwnerUserId: null, repositories: [], environmentId: null },
    0,
    resolvedAt
  );
}
