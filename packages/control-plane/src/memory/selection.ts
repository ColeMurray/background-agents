import { DEFAULT_HARNESS } from "@open-inspect/shared/harnesses";
import {
  MEMORY_SELECTION_BUDGET,
  MEMORY_SELECTION_VERSION,
} from "@open-inspect/shared/types/memories";
import { hashToken } from "../auth/crypto";
import { partitionId } from "./partition";
import {
  MEMORY_SECTION_OVERHEAD_CHARS,
  renderMemoryEntry,
  renderMemorySection,
  type RenderableMemory,
  type RenderableRevision,
} from "./render";
import { sourcePartitions } from "./sources";
import type {
  MemoryCandidate,
  MemorySources,
  SessionMemoryItem,
  SessionMemorySelection,
} from "./types";

/**
 * Deterministic order: source partition priority (environment, repositories, personal), then
 * directives before facts; oldest directives and most recently updated facts first; ID tie-break.
 * Inactive records and records outside the sources are dropped.
 */
function orderCandidates(
  candidates: readonly MemoryCandidate[],
  sources: MemorySources
): MemoryCandidate[] {
  const priority = sourcePartitions(sources).map(partitionId);
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

/** Characters an entry charges against the budget: a directive's body, or a fact's summary. */
function budgetChars(candidate: MemoryCandidate): number {
  return candidate.memoryType === "directive"
    ? candidate.content.length
    : candidate.title.length + candidate.description.length;
}

function renderable(candidate: MemoryCandidate): RenderableMemory {
  const base = {
    memoryId: candidate.id,
    scope: candidate.scope,
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

  admit(candidate: MemoryCandidate, renderedLength: number): boolean {
    const rendered = this.fits(
      "rendered",
      this.renderedChars + renderedLength > MEMORY_SELECTION_BUDGET.renderedChars
    );
    const chars = budgetChars(candidate);
    let admitted: boolean;
    if (candidate.memoryType === "directive") {
      const partition = `directives:${partitionId(candidate.partition)}`;
      const partitionTotal = (this.partitionChars.get(partition) ?? 0) + chars;
      admitted = [
        this.fits(partition, partitionTotal > MEMORY_SELECTION_BUDGET.directiveCharsPerPartition),
        this.fits(
          "directives",
          this.directiveChars + chars > MEMORY_SELECTION_BUDGET.directiveChars
        ),
        this.fits(
          "directiveRecords",
          this.directiveCount >= MEMORY_SELECTION_BUDGET.directiveRecords
        ),
      ].every(Boolean);
      if (admitted && rendered) {
        this.partitionChars.set(partition, partitionTotal);
        this.directiveChars += chars;
        this.directiveCount++;
      }
    } else {
      admitted = this.fits(
        "catalog",
        this.catalogChars + chars > MEMORY_SELECTION_BUDGET.catalogChars ||
          this.factCount >= MEMORY_SELECTION_BUDGET.catalogRecords
      );
      if (admitted && rendered) {
        this.catalogChars += chars;
        this.factCount++;
      }
    }
    if (!admitted || !rendered) return false;
    this.renderedChars += renderedLength;
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
  sources: MemorySources,
  omittedByQuery = 0,
  resolvedAt = Date.now()
): Promise<SessionMemorySelection> {
  const budget = new MemoryBudget();
  const selected: RenderableRevision[] = [];
  const items: SessionMemoryItem[] = [];
  let omittedCount = omittedByQuery;
  for (const candidate of orderCandidates(candidates, sources)) {
    const entry = renderable(candidate);
    if (!budget.admit(candidate, renderMemoryEntry(entry).length + 1)) {
      omittedCount++;
      continue;
    }
    selected.push({ ...entry, revisionId: candidate.currentRevisionId });
    items.push({
      memoryId: candidate.id,
      revisionId: candidate.currentRevisionId,
      revisionNumber: candidate.revisionNumber,
      scope: entry.scope,
      memoryType: candidate.memoryType,
      title: candidate.title,
      inclusion: entry.inclusion,
      estimatedTokens: Math.ceil(budgetChars(candidate) / 4),
    });
  }
  const selection: SessionMemorySelection = {
    selectionVersion: MEMORY_SELECTION_VERSION,
    manifestSha256: await hashSelection(sources.personalOwnerUserId !== null, items),
    resolvedAt,
    personalOwnerUserId: sources.personalOwnerUserId,
    directiveChars: budget.directiveChars,
    catalogChars: budget.catalogChars,
    estimatedTokens: 0,
    omittedCount,
    items,
  };
  selection.estimatedTokens = Math.ceil(
    renderMemorySection(selection, selected, DEFAULT_HARNESS).length / 4
  );
  return selection;
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
