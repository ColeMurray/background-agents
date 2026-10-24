/** Framework-neutral, present-tense tool status lines. Consumers own markup and length limits. */

const TOOL_CALL_FILE_ARG_KEYS = ["file_path", "filePath", "filepath", "path", "file"] as const;

/** Keep the historical alias precedence used by completion summaries. */
export function toolCallFilePath(args: Record<string, unknown>): string | undefined {
  for (const key of TOOL_CALL_FILE_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export interface ToolStatusOptions {
  /** Platform-specific mention/markup normalization, applied before compaction and truncation. */
  normalizeText?: (value: unknown) => string;
  /** Maximum length of a command, search pattern, or unknown tool name. */
  argumentMaxLength?: number;
  /** File statuses reserve space for the verb within the consumer's line budget. */
  fileStatusMaxLength?: number;
}

function plainText(value: unknown): string {
  if (value == null) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return ".".repeat(Math.max(0, maxLength));
  return `${text.slice(0, maxLength - 3)}...`;
}

/** Only file arguments enter here; shell commands and URLs are never path-rewritten. */
export function compactPathPart(text: string, maxLength = Infinity): string {
  if (!text) return "";
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return truncate(text, maxLength);
  const normalized = text.replace(/\\/g, "/").replace(/^\/workspace\/[^/]+\//, "");
  if (normalized.length <= maxLength) return normalized;

  const parts = normalized.split("/").filter(Boolean);
  for (let count = Math.min(3, parts.length); count > 0; count -= 1) {
    const tail = parts.slice(-count).join("/");
    if (tail.length <= maxLength) return tail;
  }
  return truncate(parts.at(-1) ?? normalized, maxLength);
}

export function formatToolStatus(
  tool: string,
  args: Record<string, unknown> = {},
  options: ToolStatusOptions = {}
): string {
  const normalize = options.normalizeText ?? plainText;
  const part = (value: unknown) =>
    truncate(normalize(value), options.argumentMaxLength ?? Infinity);
  const firstArg = (keys: string[], fallback: string): string => {
    for (const key of keys) {
      const text = part(args[key]);
      if (text) return text;
    }
    return fallback;
  };
  const fileArg = (prefix: string, fallback: string): string =>
    compactPathPart(
      normalize(toolCallFilePath(args)),
      (options.fileStatusMaxLength ?? Infinity) - prefix.length - 1
    ) || fallback;
  const normalizedTool = normalize(tool);

  switch (normalizedTool.toLowerCase()) {
    case "read":
    case "read_file":
      return `Reading ${fileArg("Reading", "file")}`;
    case "edit":
    case "edit_file":
      return `Editing ${fileArg("Editing", "file")}`;
    case "write":
    case "write_file":
      return `Writing ${fileArg("Writing", "file")}`;
    case "bash":
    case "execute_command":
      return `Running ${firstArg(["command", "cmd"], "command")}`;
    case "grep":
    case "search_files":
      return `Searching for ${firstArg(["pattern", "query"], "query")}`;
    case "glob":
      return `Finding ${firstArg(["pattern", "query"], "files")}`;
    case "list":
    case "list_files":
    case "list_directory":
      return `Listing ${fileArg("Listing", "files")}`;
    default:
      return `Using tool: ${part(normalizedTool || "unknown")}`;
  }
}
