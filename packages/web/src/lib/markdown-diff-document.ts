/**
 * Rebuild the resulting Markdown document from one captured unified diff.
 *
 * Renderable patches come from `git diff --unified=1000000` in the diff
 * collector. A hunk that starts on the first new-file line and stays
 * contiguous therefore includes unchanged lines, not only the edit. Trailing
 * context that saturates that window is rejected so a cut-off capture cannot
 * preview as a complete document.
 */
export const DIFF_UNIFIED_CONTEXT_LINES = 1_000_000;

const EMPTY_BLOB_OIDS = new Set([
  "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
]);

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE = "\\ No newline at end of file";
const INDEX_LINE = /^index [0-9a-f]+\.\.([0-9a-f]+)/i;

export type MarkdownDocumentReconstruction =
  | { status: "document"; content: string }
  | { status: "empty" }
  | { status: "deleted" }
  | { status: "unavailable" };

export function isMarkdownPreviewPath(path: string): boolean {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  const extension = base.slice(dot + 1).toLowerCase();
  return extension === "md" || extension === "markdown";
}

/** True when trailing context used the entire collector window and may hide the rest of the file. */
export function trailingContextHidesDocumentEnd(trailingContextLines: number): boolean {
  return trailingContextLines >= DIFF_UNIFIED_CONTEXT_LINES;
}

interface FileHeaders {
  deleted: boolean;
  emptyNewFile: boolean;
  hunkStart: number;
}

interface ParsedHunk {
  newStart: number;
  newCount: number;
  oldCount: number;
  lines: string[];
}

function splitPatchLines(patch: string): string[] {
  const lines = patch.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > 0 && lines.every((line) => line.endsWith("\r"))) {
    return lines.map((line) => line.slice(0, -1));
  }
  return lines;
}

function headerPath(line: string, marker: "---" | "+++"): string | null {
  const prefix = `${marker} `;
  if (!line.startsWith(prefix)) return null;
  let rest = line.slice(prefix.length);
  const tab = rest.indexOf("\t");
  if (tab !== -1) rest = rest.slice(0, tab);
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
    rest = rest.slice(1, -1);
  }
  return rest;
}

function isDevNull(path: string): boolean {
  return path === "/dev/null" || path === "a/dev/null" || path === "b/dev/null";
}

function isBinaryPatch(lines: string[]): boolean {
  return lines.some((line) => line === "GIT binary patch" || line.startsWith("Binary files "));
}

function readFileHeaders(lines: string[]): FileHeaders | null {
  let newFile = false;
  let newOid: string | undefined;
  let plus: string | undefined;
  let plusIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("@@ ")) break;
    if (line.startsWith("new file mode ")) newFile = true;
    const oid = INDEX_LINE.exec(line);
    if (oid?.[1]) newOid = oid[1];
    const plusPath = headerPath(line, "+++");
    if (plusPath) {
      plus = plusPath;
      plusIndex = index;
    }
  }

  if (plus && isDevNull(plus)) {
    return { deleted: true, emptyNewFile: false, hunkStart: plusIndex + 1 };
  }
  if (plusIndex === -1) {
    if (newFile && newOid !== undefined && EMPTY_BLOB_OIDS.has(newOid)) {
      return { deleted: false, emptyNewFile: true, hunkStart: lines.length };
    }
    return null;
  }
  return {
    deleted: false,
    emptyNewFile: newFile && newOid !== undefined && EMPTY_BLOB_OIDS.has(newOid),
    hunkStart: plusIndex + 1,
  };
}

function parseHunkHeader(line: string): Omit<ParsedHunk, "lines"> | null {
  const match = HUNK_HEADER.exec(line);
  if (!match) return null;
  return {
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function readHunks(lines: string[], start: number): ParsedHunk[] | null {
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("@@ ")) {
      const header = parseHunkHeader(line);
      if (!header) return null;
      current = { ...header, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (line.length === 0) continue;
      return null;
    }
    if (line.startsWith("diff --git ")) return null;
    current.lines.push(line);
  }
  return hunks;
}

function applyHunks(hunks: ParsedHunk[]): { content: string } | null {
  let cursor = 1;
  const newLines: string[] = [];
  let trailingContext = 0;
  let sawChange = false;
  let lastNewLineHadNewline = true;

  for (const hunk of hunks) {
    if (!acceptHunkStart(hunk, cursor, hunks.length)) return null;
    if (hunk.newCount > 0) cursor += hunk.newCount;

    const applied = applyHunkLines(hunk, { sawChange, trailingContext, lastNewLineHadNewline });
    if (!applied) return null;
    newLines.push(...applied.lines);
    sawChange = applied.sawChange;
    trailingContext = applied.trailingContext;
    lastNewLineHadNewline = applied.lastNewLineHadNewline;
  }

  if (trailingContextHidesDocumentEnd(trailingContext)) return null;
  if (newLines.length === 0) return { content: "" };
  return { content: newLines.join("\n") + (lastNewLineHadNewline ? "\n" : "") };
}

function acceptHunkStart(hunk: ParsedHunk, cursor: number, hunkCount: number): boolean {
  if (hunk.newCount === 0) return hunk.newStart === 0 && hunkCount === 1 && cursor === 1;
  return hunk.newStart === cursor;
}

function applyHunkLines(
  hunk: ParsedHunk,
  carried: { sawChange: boolean; trailingContext: number; lastNewLineHadNewline: boolean }
): {
  lines: string[];
  sawChange: boolean;
  trailingContext: number;
  lastNewLineHadNewline: boolean;
} | null {
  const lines: string[] = [];
  let newSeen = 0;
  let oldSeen = 0;
  let previousWasNew = false;
  let { sawChange, trailingContext, lastNewLineHadNewline } = carried;

  for (const line of hunk.lines) {
    if (line === NO_NEWLINE) {
      if (!previousWasNew && newSeen === 0 && oldSeen === 0) return null;
      if (previousWasNew) lastNewLineHadNewline = false;
      previousWasNew = false;
      continue;
    }
    const classified = classifyHunkLine(line);
    if (!classified) return null;
    if (classified.kind === "deletion") {
      oldSeen += 1;
      sawChange = true;
      trailingContext = 0;
      previousWasNew = false;
      continue;
    }
    lines.push(classified.text);
    newSeen += 1;
    if (classified.kind === "context") oldSeen += 1;
    if (classified.kind === "addition") sawChange = true;
    trailingContext = classified.kind === "context" && sawChange ? trailingContext + 1 : 0;
    lastNewLineHadNewline = true;
    previousWasNew = true;
  }

  if (newSeen !== hunk.newCount || oldSeen !== hunk.oldCount) return null;
  return { lines, sawChange, trailingContext, lastNewLineHadNewline };
}

function classifyHunkLine(
  line: string
): { kind: "addition" | "context" | "deletion"; text: string } | null {
  if (line.startsWith("+")) return { kind: "addition", text: line.slice(1) };
  if (line.startsWith(" ")) return { kind: "context", text: line.slice(1) };
  if (line.startsWith("-")) return { kind: "deletion", text: line.slice(1) };
  return null;
}

export function reconstructMarkdownDocument(patch: string): MarkdownDocumentReconstruction {
  if (!patch.trim()) return { status: "unavailable" };
  const lines = splitPatchLines(patch);
  const diffCount = lines.filter((line) => line.startsWith("diff --git ")).length;
  if (diffCount > 1 || isBinaryPatch(lines)) return { status: "unavailable" };

  const headers = readFileHeaders(lines);
  if (!headers) return { status: "unavailable" };
  if (headers.deleted) return { status: "deleted" };

  const hunks = readHunks(lines, headers.hunkStart);
  if (!hunks) return { status: "unavailable" };
  if (hunks.length === 0) {
    return headers.emptyNewFile ? { status: "empty" } : { status: "unavailable" };
  }

  const built = applyHunks(hunks);
  if (!built) return { status: "unavailable" };
  if (built.content.length === 0) return { status: "empty" };
  return { status: "document", content: built.content };
}
