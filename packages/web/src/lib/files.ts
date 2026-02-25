/**
 * File change extraction utilities for parsing Edit/Write tool call events
 */

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
 * Extract changed files from sandbox events.
 *
 * Filters for completed Edit/Write tool_call events, deduplicates by file path,
 * accumulates approximate diff stats, and returns a sorted list of FileChange.
 */
export function extractChangedFiles(events: SandboxEvent[]): FileChange[] {
  const fileMap = new Map<string, FileChange>();

  for (const event of events) {
    if (event.type !== "tool_call") continue;
    if (event.status !== "completed") continue;

    const normalizedTool = event.tool?.toLowerCase();
    if (normalizedTool !== "edit" && normalizedTool !== "write") continue;

    const args = event.args;
    if (!args) continue;

    // OpenCode uses camelCase (filePath) with snake_case fallback (file_path)
    const filePath = (args.filePath ?? args.file_path) as string | undefined;
    if (!filePath) continue;

    let additions = 0;
    let deletions = 0;

    if (normalizedTool === "edit") {
      additions = countLines(args.newString);
      deletions = countLines(args.oldString);
    } else {
      // write
      additions = countLines(args.content);
      deletions = 0;
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
