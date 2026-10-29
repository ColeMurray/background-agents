import { parsePatchFiles } from "@pierre/diffs";
import type { SessionDiffFile } from "@open-inspect/shared/types/session-diffs";

type MarkdownPreviewDocument =
  { status: "document"; content: string } | { status: "empty" | "deleted" | "unavailable" };

export function isMarkdownPath(path: string): boolean {
  return /[^/]\.(md|markdown)$/i.test(path);
}

/**
 * Tracked empty files that were added or deleted have no hunk, so the collector captures
 * them as metadata only and there is no patch to preview.
 */
export function emptyMarkdownPreviewStatus(file: SessionDiffFile): "empty" | "deleted" | null {
  if (file.renderState !== "metadata_only") return null;
  if (file.status === "added") return "empty";
  if (file.status === "deleted") return "deleted";
  return null;
}

/**
 * The resulting document of one captured file patch. The diff collector captures with
 * full context, so a complete document is a single hunk that starts on the first line.
 */
export function previewMarkdownDocument(patch: string): MarkdownPreviewDocument {
  const [file, ...otherFiles] = parsePatchFilesStrictly(patch);
  if (!file || otherFiles.length > 0) return { status: "unavailable" };
  if (file.type === "deleted") return { status: "deleted" };

  const [hunk, ...otherHunks] = file.hunks;
  if (!hunk) return { status: file.type === "new" ? "empty" : "unavailable" };
  if (
    otherHunks.length > 0 ||
    hunk.additionStart > 1 ||
    file.additionLines.length !== hunk.additionCount ||
    file.deletionLines.length !== hunk.deletionCount
  ) {
    return { status: "unavailable" };
  }

  const content = file.additionLines.join("");
  return content ? { status: "document", content } : { status: "empty" };
}

/**
 * Lenient parsing rewrites a hunk's counts to the lines it found, so a truncated hunk would
 * pass for a complete one. Strict parsing throws on that mismatch instead.
 */
function parsePatchFilesStrictly(patch: string) {
  try {
    return parsePatchFiles(patch, undefined, true).flatMap((parsed) => parsed.files);
  } catch {
    return [];
  }
}
