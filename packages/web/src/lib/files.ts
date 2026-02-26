/**
 * File change extraction utilities for parsing Edit/Write/apply_patch tool call events
 */

import { diffLines } from "diff";
import type { FileChange } from "@/types/session";

interface SandboxEvent {
  type: string;
  tool?: string;
  args?: Record<string, unknown>;
  status?: string;
  timestamp: number;
}

/**
 * Count the number of lines in a string.
 * Returns 0 for undefined/empty input.
 */
function countLines(str: unknown): number {
  if (typeof str !== "string" || str.length === 0) return 0;
  return str.split("\n").length;
}

/**
 * Compute accurate line-level additions/deletions between two strings
 * using the Myers diff algorithm via the `diff` package.
 */
function computeEditStats(
  oldStr: unknown,
  newStr: unknown
): { additions: number; deletions: number } {
  const old = typeof oldStr === "string" ? oldStr : "";
  const neu = typeof newStr === "string" ? newStr : "";
  if (old === "" && neu === "") return { additions: 0, deletions: 0 };

  // ignoreNewlineAtEof prevents false diffs when tool call substrings
  // differ only in whether the last line has a trailing newline
  const changes = diffLines(old, neu, { ignoreNewlineAtEof: true });
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    if (change.added) additions += change.count ?? 0;
    if (change.removed) deletions += change.count ?? 0;
  }
  return { additions, deletions };
}

/**
 * Parse an apply_patch patchText into per-file addition/deletion counts.
 *
 * Patch format uses section headers:
 *   *** Add File: <path>
 *   *** Update File: <path>
 *   *** Delete File: <path>
 * Body lines starting with `+` count as additions, `-` as deletions.
 * Envelope lines (Begin Patch, End Patch, End of File) and hunk headers
 * (@@...@@) are skipped.
 */
export function parseApplyPatch(
  patchText: string
): { filePath: string; additions: number; deletions: number }[] {
  const results: { filePath: string; additions: number; deletions: number }[] = [];
  let current: { filePath: string; additions: number; deletions: number } | null = null;

  for (const line of patchText.split("\n")) {
    // Skip envelope lines
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;

    // Check for section headers
    let filePath: string | undefined;
    if (line.startsWith("*** Add File: ")) {
      filePath = line.slice("*** Add File: ".length).trim();
    } else if (line.startsWith("*** Update File: ")) {
      filePath = line.slice("*** Update File: ".length).trim();
    } else if (line.startsWith("*** Delete File: ")) {
      filePath = line.slice("*** Delete File: ".length).trim();
    }

    if (filePath) {
      if (current) results.push(current);
      current = { filePath, additions: 0, deletions: 0 };
      continue;
    }

    if (!current) continue;

    // Skip hunk headers and "End of File" markers
    if (line.startsWith("@@") || line.startsWith("*** ")) continue;

    if (line.startsWith("+")) {
      current.additions += 1;
    } else if (line.startsWith("-")) {
      current.deletions += 1;
    }
  }

  if (current) results.push(current);
  return results;
}

/**
 * Extract changed files from sandbox events.
 *
 * Filters for completed Edit/Write/apply_patch tool_call events, deduplicates
 * by file path, accumulates diff stats, and returns a sorted list of FileChange.
 *
 * Edit events use line-level diffing (via `diffLines`) for accurate stats.
 * Write events count total lines as additions (no prior content to diff against).
 * apply_patch events parse the patch text for per-file addition/deletion counts.
 */
export function extractChangedFiles(events: SandboxEvent[]): FileChange[] {
  const fileMap = new Map<string, FileChange>();

  for (const event of events) {
    if (event.type !== "tool_call") continue;
    if (event.status !== "completed") continue;

    const normalizedTool = event.tool?.toLowerCase();
    if (normalizedTool !== "edit" && normalizedTool !== "write" && normalizedTool !== "apply_patch")
      continue;

    const args = event.args;
    if (!args) continue;

    if (normalizedTool === "apply_patch") {
      const patchText = args.patchText as string | undefined;
      if (typeof patchText !== "string" || patchText.length === 0) continue;

      for (const entry of parseApplyPatch(patchText)) {
        if (!entry.filePath) continue;
        const existing = fileMap.get(entry.filePath);
        if (existing) {
          existing.additions += entry.additions;
          existing.deletions += entry.deletions;
        } else {
          fileMap.set(entry.filePath, {
            filename: entry.filePath,
            additions: entry.additions,
            deletions: entry.deletions,
          });
        }
      }
      continue;
    }

    // OpenCode uses camelCase (filePath) with snake_case fallback (file_path)
    const filePath = (args.filePath ?? args.file_path) as string | undefined;
    if (!filePath) continue;

    let additions = 0;
    let deletions = 0;

    if (normalizedTool === "edit") {
      const stats = computeEditStats(args.oldString, args.newString);
      additions = stats.additions;
      deletions = stats.deletions;
    } else {
      // write — no prior content, count total lines as additions
      additions = countLines(args.content);
    }

    const existing = fileMap.get(filePath);
    if (existing) {
      existing.additions += additions;
      existing.deletions += deletions;
    } else {
      fileMap.set(filePath, { filename: filePath, additions, deletions });
    }
  }

  return Array.from(fileMap.values()).sort((a, b) => a.filename.localeCompare(b.filename));
}
