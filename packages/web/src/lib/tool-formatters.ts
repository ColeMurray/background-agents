import type { SandboxEvent } from "@/types/session";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

/**
 * Extract just the filename from a file path
 */
function basename(filePath: string | undefined): string {
  if (!filePath) return "unknown";
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

/**
 * Truncate a string to a maximum length with ellipsis
 */
function truncate(str: string | undefined, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

/**
 * Count lines in a string
 */
function countLines(str: string | undefined): number {
  if (!str) return 0;
  return str.split("\n").length;
}

type PatchOperation = "add" | "update" | "delete";

interface PatchSummary {
  addCount: number;
  updateCount: number;
  deleteCount: number;
  totalFiles: number;
  firstFile: string | null;
  firstOperation: PatchOperation | null;
}

function getStringArg(
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function getArrayArg(
  args: Record<string, unknown> | undefined,
  key: string
): unknown[] | undefined {
  const value = args?.[key];
  return Array.isArray(value) ? value : undefined;
}

function summarizeApplyPatch(patchText: string | undefined): PatchSummary {
  if (!patchText) {
    return {
      addCount: 0,
      updateCount: 0,
      deleteCount: 0,
      totalFiles: 0,
      firstFile: null,
      firstOperation: null,
    };
  }

  const summary: PatchSummary = {
    addCount: 0,
    updateCount: 0,
    deleteCount: 0,
    totalFiles: 0,
    firstFile: null,
    firstOperation: null,
  };

  for (const line of patchText.split("\n")) {
    let operation: PatchOperation | null = null;
    let filePath: string | undefined;

    if (line.startsWith("*** Add File: ")) {
      operation = "add";
      filePath = line.slice("*** Add File: ".length);
      summary.addCount += 1;
    } else if (line.startsWith("*** Update File: ")) {
      operation = "update";
      filePath = line.slice("*** Update File: ".length);
      summary.updateCount += 1;
    } else if (line.startsWith("*** Delete File: ")) {
      operation = "delete";
      filePath = line.slice("*** Delete File: ".length);
      summary.deleteCount += 1;
    }

    if (!operation) continue;

    summary.totalFiles += 1;
    if (!summary.firstFile) {
      summary.firstFile = basename(filePath);
      summary.firstOperation = operation;
    }
  }

  return summary;
}

function operationLabel(operation: PatchOperation | null): string {
  switch (operation) {
    case "add":
      return "Add";
    case "update":
      return "Update";
    case "delete":
      return "Delete";
    default:
      return "Patch";
  }
}

export interface FormattedToolCall {
  /** Tool name for display */
  toolName: string;
  /** Short summary for collapsed view */
  summary: string;
  /** Icon name or null */
  icon: string | null;
  /** Full details for expanded view - returns JSX-safe content */
  getDetails: () => { args?: Record<string, unknown>; output?: string };
}

/**
 * Format a tool call event for compact display
 * Note: OpenCode uses camelCase field names (filePath, not file_path)
 * Tool names are normalized to lowercase for matching since OpenCode may
 * report them in different cases (e.g., "todowrite" vs "TodoWrite")
 */
export function formatToolCall(event: ToolCallEvent): FormattedToolCall {
  const { tool, args, output } = event;
  const normalizedTool = tool?.toLowerCase() || "unknown";

  switch (normalizedTool) {
    case "read": {
      // OpenCode uses filePath (camelCase)
      const filePath = getStringArg(args, "filePath", "file_path");
      const lineCount = countLines(output);
      return {
        toolName: "Read",
        summary: filePath
          ? `${basename(filePath)}${lineCount > 0 ? ` (${lineCount} lines)` : ""}`
          : "file",
        icon: "file",
        getDetails: () => ({ args, output }),
      };
    }

    case "edit": {
      const filePath = getStringArg(args, "filePath", "file_path");
      return {
        toolName: "Edit",
        summary: filePath ? basename(filePath) : "file",
        icon: "pencil",
        getDetails: () => ({ args, output }),
      };
    }

    case "write": {
      const filePath = getStringArg(args, "filePath", "file_path");
      return {
        toolName: "Write",
        summary: filePath ? basename(filePath) : "file",
        icon: "plus",
        getDetails: () => ({ args, output }),
      };
    }

    case "bash": {
      const command = getStringArg(args, "command");
      return {
        toolName: "Bash",
        summary: truncate(command, 50),
        icon: "terminal",
        getDetails: () => ({ args, output }),
      };
    }

    case "grep": {
      const pattern = getStringArg(args, "pattern");
      const matchCount = output ? countLines(output) : 0;
      return {
        toolName: "Grep",
        summary: pattern
          ? `"${truncate(pattern, 30)}"${matchCount > 0 ? ` (${matchCount} matches)` : ""}`
          : "search",
        icon: "search",
        getDetails: () => ({ args, output }),
      };
    }

    case "glob": {
      const pattern = getStringArg(args, "pattern");
      const fileCount = output ? countLines(output) : 0;
      return {
        toolName: "Glob",
        summary: pattern
          ? `${truncate(pattern, 30)}${fileCount > 0 ? ` (${fileCount} files)` : ""}`
          : "search",
        icon: "folder",
        getDetails: () => ({ args, output }),
      };
    }

    case "task": {
      const description = getStringArg(args, "description");
      const prompt = getStringArg(args, "prompt");
      return {
        toolName: "Task",
        summary: description ? truncate(description, 40) : prompt ? truncate(prompt, 40) : "task",
        icon: "box",
        getDetails: () => ({ args, output }),
      };
    }

    case "webfetch": {
      const url = getStringArg(args, "url");
      return {
        toolName: "WebFetch",
        summary: url ? truncate(url, 40) : "url",
        icon: "globe",
        getDetails: () => ({ args, output }),
      };
    }

    case "websearch": {
      const query = getStringArg(args, "query");
      return {
        toolName: "WebSearch",
        summary: query ? `"${truncate(query, 40)}"` : "search",
        icon: "search",
        getDetails: () => ({ args, output }),
      };
    }

    case "todowrite": {
      const todos = getArrayArg(args, "todos");
      return {
        toolName: "TodoWrite",
        summary: todos ? `${todos.length} item${todos.length === 1 ? "" : "s"}` : "todos",
        icon: "file",
        getDetails: () => ({ args, output }),
      };
    }

    case "apply_patch": {
      const patchText = getStringArg(args, "patchText");
      const patchSummary = summarizeApplyPatch(patchText);

      let summary = "patch";
      if (patchSummary.totalFiles === 1 && patchSummary.firstFile) {
        summary = `${operationLabel(patchSummary.firstOperation)} ${patchSummary.firstFile}`;
      } else if (patchSummary.totalFiles > 1) {
        const parts: string[] = [];
        if (patchSummary.updateCount > 0) parts.push(`${patchSummary.updateCount} updated`);
        if (patchSummary.addCount > 0) parts.push(`${patchSummary.addCount} added`);
        if (patchSummary.deleteCount > 0) parts.push(`${patchSummary.deleteCount} deleted`);
        summary = `${patchSummary.totalFiles} files${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
      }

      return {
        toolName: "Apply Patch",
        summary,
        icon: "pencil",
        getDetails: () => ({ args, output }),
      };
    }

    default:
      return {
        toolName: tool || "Unknown",
        summary: args && Object.keys(args).length > 0 ? truncate(JSON.stringify(args), 50) : "",
        icon: null,
        getDetails: () => ({ args, output }),
      };
  }
}

/**
 * Get a compact summary for a group of tool calls
 */
export function formatToolGroup(events: ToolCallEvent[]): {
  toolName: string;
  count: number;
  summary: string;
} {
  if (events.length === 0) {
    return { toolName: "Unknown", count: 0, summary: "" };
  }

  const rawToolName = events[0].tool || "Unknown";
  const normalizedTool = rawToolName.toLowerCase();
  const count = events.length;

  // Build summary based on tool type
  // Use lowercase for matching since OpenCode may report tool names in different cases
  switch (normalizedTool) {
    case "read": {
      return {
        toolName: "Read",
        count,
        summary: `${count} file${count === 1 ? "" : "s"}`,
      };
    }

    case "edit": {
      return {
        toolName: "Edit",
        count,
        summary: `${count} file${count === 1 ? "" : "s"}`,
      };
    }

    case "bash": {
      return {
        toolName: "Bash",
        count,
        summary: `${count} command${count === 1 ? "" : "s"}`,
      };
    }

    case "apply_patch": {
      return {
        toolName: "Apply Patch",
        count,
        summary: `${count} patch${count === 1 ? "" : "es"}`,
      };
    }

    default:
      return {
        toolName: rawToolName,
        count,
        summary: `${count} call${count === 1 ? "" : "s"}`,
      };
  }
}
