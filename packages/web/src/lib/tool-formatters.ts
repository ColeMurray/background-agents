export interface SandboxEvent {
  type: string;
  content?: string;
  messageId?: string;
  tool?: string;
  args?: Record<string, unknown>;
  callId?: string;
  result?: string;
  error?: string;
  success?: boolean;
  status?: string;
  output?: string;
  sha?: string;
  timestamp: number;
}

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
 */
export function formatToolCall(event: SandboxEvent): FormattedToolCall {
  const { tool, args, output } = event;
  const toolName = tool || "Unknown";

  switch (toolName) {
    case "Read": {
      // OpenCode uses filePath (camelCase)
      const filePath = (args?.filePath ?? args?.file_path) as string | undefined;
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

    case "Edit": {
      const filePath = (args?.filePath ?? args?.file_path) as string | undefined;
      return {
        toolName: "Edit",
        summary: filePath ? basename(filePath) : "file",
        icon: "pencil",
        getDetails: () => ({ args, output }),
      };
    }

    case "Write": {
      const filePath = (args?.filePath ?? args?.file_path) as string | undefined;
      return {
        toolName: "Write",
        summary: filePath ? basename(filePath) : "file",
        icon: "plus",
        getDetails: () => ({ args, output }),
      };
    }

    case "Bash": {
      const command = args?.command as string | undefined;
      return {
        toolName: "Bash",
        summary: truncate(command, 50),
        icon: "terminal",
        getDetails: () => ({ args, output }),
      };
    }

    case "Grep": {
      const pattern = args?.pattern as string | undefined;
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

    case "Glob": {
      const pattern = args?.pattern as string | undefined;
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

    case "Task": {
      const description = args?.description as string | undefined;
      const prompt = args?.prompt as string | undefined;
      return {
        toolName: "Task",
        summary: description ? truncate(description, 40) : prompt ? truncate(prompt, 40) : "task",
        icon: "box",
        getDetails: () => ({ args, output }),
      };
    }

    case "WebFetch": {
      const url = args?.url as string | undefined;
      return {
        toolName: "WebFetch",
        summary: url ? truncate(url, 40) : "url",
        icon: "globe",
        getDetails: () => ({ args, output }),
      };
    }

    case "WebSearch": {
      const query = args?.query as string | undefined;
      return {
        toolName: "WebSearch",
        summary: query ? `"${truncate(query, 40)}"` : "search",
        icon: "search",
        getDetails: () => ({ args, output }),
      };
    }

    case "TodoWrite": {
      const todos = args?.todos as unknown[] | undefined;
      return {
        toolName: "TodoWrite",
        summary: todos ? `${todos.length} item${todos.length === 1 ? "" : "s"}` : "todos",
        icon: "file",
        getDetails: () => ({ args, output }),
      };
    }

    default:
      return {
        toolName,
        summary: args && Object.keys(args).length > 0 ? truncate(JSON.stringify(args), 50) : "",
        icon: null,
        getDetails: () => ({ args, output }),
      };
  }
}

/**
 * Get a compact summary for a group of tool calls
 */
export function formatToolGroup(events: SandboxEvent[]): {
  toolName: string;
  count: number;
  summary: string;
} {
  if (events.length === 0) {
    return { toolName: "Unknown", count: 0, summary: "" };
  }

  const toolName = events[0].tool || "Unknown";
  const count = events.length;

  // Build summary based on tool type
  switch (toolName) {
    case "Read": {
      return {
        toolName: "Read",
        count,
        summary: `${count} file${count === 1 ? "" : "s"}`,
      };
    }

    case "Edit": {
      return {
        toolName: "Edit",
        count,
        summary: `${count} file${count === 1 ? "" : "s"}`,
      };
    }

    case "Bash": {
      return {
        toolName: "Bash",
        count,
        summary: `${count} command${count === 1 ? "" : "s"}`,
      };
    }

    default:
      return {
        toolName,
        count,
        summary: `${count} call${count === 1 ? "" : "s"}`,
      };
  }
}
