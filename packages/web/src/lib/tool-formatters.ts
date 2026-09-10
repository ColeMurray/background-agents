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
    if (typeof value === "string" && value.trim()) return value;
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

const SUBTASK_ROOT_TOOLS: ReadonlySet<string> = new Set(["task", "agent"]);

/** Whether a tool call opens a nested subtask (OpenCode `task`, Claude Agent `Agent`). */
export function isSubtaskRootTool(tool: string | undefined): boolean {
  return SUBTASK_ROOT_TOOLS.has(tool?.toLowerCase() ?? "");
}

const MCP_TOOL_PREFIX = "mcp__";

/** Splits a Claude Agent MCP tool name (`mcp__<server>__<tool>`) into its parts. */
export function parseMcpToolName(
  tool: string | undefined
): { server: string; tool: string } | null {
  if (!tool || !tool.toLowerCase().startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = tool.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator + 2 >= rest.length) return null;
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

function summarizeArgumentCount(args: Record<string, unknown> | undefined): string {
  const argumentCount = args ? Object.keys(args).length : 0;
  return argumentCount > 0 ? `${argumentCount} argument${argumentCount === 1 ? "" : "s"}` : "";
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
 * Format a tool call event for compact display.
 *
 * Tool names are matched case-insensitively: OpenCode reports lowercase names
 * (`read`, `todowrite`) while the Claude Agent SDK capitalizes them (`Read`,
 * `TodoWrite`). Argument keys differ the same way (OpenCode `filePath`, Claude
 * Agent `file_path`), so each branch accepts both spellings. Claude Agent MCP
 * tools arrive as `mcp__<server>__<tool>`.
 */
export function formatToolCall(event: ToolCallEvent): FormattedToolCall {
  const { tool, args, output } = event;
  const normalizedTool = tool?.toLowerCase() || "unknown";

  const mcpTool = parseMcpToolName(tool);
  if (mcpTool) {
    return {
      toolName: `${mcpTool.server}: ${mcpTool.tool}`,
      summary: summarizeArgumentCount(args),
      icon: null,
      getDetails: () => ({ args, output }),
    };
  }

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

    case "edit":
    case "multiedit": {
      const filePath = getStringArg(args, "filePath", "file_path");
      const fileLabel = filePath ? basename(filePath) : "file";
      const edits = normalizedTool === "multiedit" ? getArrayArg(args, "edits") : undefined;
      return {
        toolName: "Edit",
        summary: edits
          ? `${fileLabel} (${edits.length} edit${edits.length === 1 ? "" : "s"})`
          : fileLabel,
        icon: "pencil",
        getDetails: () => ({ args, output }),
      };
    }

    case "notebookedit": {
      const notebookPath = getStringArg(
        args,
        "notebook_path",
        "notebookPath",
        "filePath",
        "file_path"
      );
      return {
        toolName: "NotebookEdit",
        summary: notebookPath ? basename(notebookPath) : "notebook",
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
        summary: command ?? "",
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
          ? `"${pattern}"${matchCount > 0 ? ` (${matchCount} matches)` : ""}`
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
        summary: pattern ? `${pattern}${fileCount > 0 ? ` (${fileCount} files)` : ""}` : "search",
        icon: "folder",
        getDetails: () => ({ args, output }),
      };
    }

    case "task":
    case "agent": {
      const description = getStringArg(args, "description");
      return {
        toolName: normalizedTool === "agent" ? "Agent" : "Task",
        summary: description ?? "task",
        icon: "box",
        getDetails: () => ({ args, output }),
      };
    }

    case "skill": {
      const name = getStringArg(args, "name", "skill");
      return {
        toolName: "skill",
        summary: name ? `"${name}"` : "",
        icon: null,
        getDetails: () => ({ args, output }),
      };
    }

    case "webfetch": {
      const url = getStringArg(args, "url");
      return {
        toolName: "WebFetch",
        summary: url ?? "url",
        icon: "globe",
        getDetails: () => ({ args, output }),
      };
    }

    case "websearch": {
      const query = getStringArg(args, "query");
      return {
        toolName: "WebSearch",
        summary: query ? `"${query}"` : "search",
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

    case "taskcreate":
    case "taskupdate": {
      const subject = getStringArg(args, "subject", "description", "taskId", "task_id");
      const status = normalizedTool === "taskupdate" ? getStringArg(args, "status") : undefined;
      return {
        toolName: normalizedTool === "taskcreate" ? "TaskCreate" : "TaskUpdate",
        summary: subject
          ? `${subject}${status ? ` (${status})` : ""}`
          : (status ?? (normalizedTool === "taskcreate" ? "task" : "update")),
        icon: "file",
        getDetails: () => ({ args, output }),
      };
    }

    case "askuserquestion": {
      const questions = getArrayArg(args, "questions");
      return {
        toolName: "AskUserQuestion",
        summary: questions
          ? `${questions.length} question${questions.length === 1 ? "" : "s"}`
          : "question",
        icon: null,
        getDetails: () => ({ args, output }),
      };
    }

    case "apply_patch": {
      const patchText = getStringArg(args, "patchText", "patch_text", "patch");
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

    case "get-child-status":
    case "get-task-status": {
      const childId = getStringArg(args, "childId", "taskId");

      return {
        toolName: "Child Status",
        summary: childId ?? "List Children",
        icon: "box",
        getDetails: () => ({ args, output }),
      };
    }

    default: {
      return {
        toolName: tool || "Unknown",
        summary: summarizeArgumentCount(args),
        icon: null,
        getDetails: () => ({ args, output }),
      };
    }
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

  const mcpTool = parseMcpToolName(rawToolName);
  if (mcpTool) {
    return {
      toolName: `${mcpTool.server}: ${mcpTool.tool}`,
      count,
      summary: `${count} call${count === 1 ? "" : "s"}`,
    };
  }

  // Build summary based on tool type; names are matched case-insensitively
  // (see formatToolCall).
  switch (normalizedTool) {
    case "read": {
      return {
        toolName: "Read",
        count,
        summary: `${count} file${count === 1 ? "" : "s"}`,
      };
    }

    case "edit":
    case "multiedit": {
      return {
        toolName: "Edit",
        count,
        summary: `${count} file${count === 1 ? "" : "s"}`,
      };
    }

    case "write": {
      return {
        toolName: "Write",
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
