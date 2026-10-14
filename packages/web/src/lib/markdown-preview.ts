import { parsePatchFiles } from "@pierre/diffs";

type MarkdownPreviewDocument =
  { status: "document"; content: string } | { status: "empty" | "deleted" | "unavailable" };

export function isMarkdownPath(path: string): boolean {
  return /[^/]\.(md|markdown)$/i.test(path);
}

/**
 * The resulting document of one captured file patch. The diff collector captures with
 * full context, so a complete document is a single hunk that starts on the first line.
 */
export function previewMarkdownDocument(patch: string): MarkdownPreviewDocument {
  const [file, ...otherFiles] = parsePatchFiles(patch).flatMap((parsed) => parsed.files);
  if (!file || otherFiles.length > 0) return { status: "unavailable" };
  if (file.type === "deleted") return { status: "deleted" };

  const [hunk, ...otherHunks] = file.hunks;
  if (!hunk) return { status: file.type === "new" ? "empty" : "unavailable" };
  if (otherHunks.length > 0 || hunk.additionStart > 1) return { status: "unavailable" };

  const content = file.additionLines.join("");
  return content ? { status: "document", content } : { status: "empty" };
}
