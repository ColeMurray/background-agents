import { createTwoFilesPatch, diffLines } from "diff";
import {
  SESSION_DIFF_MAX_FILE_PATCH_BYTES,
  SESSION_DIFF_MAX_BUNDLE_BYTES,
  SESSION_DIFF_MAX_FILES,
  SESSION_DIFF_MAX_TOTAL_PATCH_BYTES,
  sessionDiffUploadSchema,
  type SessionDiffFileUpload,
  type SessionDiffUpload,
} from "@open-inspect/shared/types/session-diffs";

export interface SessionTextDiffFile {
  path: string;
  before: string | null;
  after: string | null;
  mode: "100644" | "100755";
}

export interface SessionTextDiffRepository {
  position: number;
  repoOwner: string;
  repoName: string;
  baseSha: string;
  files: SessionTextDiffFile[];
}

interface SessionTextDiffAssemblyOptions {
  triggerMessageId: string | null;
  capturedAt: number;
  fileId?: (position: number, path: string) => Promise<string>;
}

/** Canonical assembler for bounded SessionDiff bundles from text overlays. */
export async function assembleSessionTextDiff(
  repositories: SessionTextDiffRepository[],
  options: SessionTextDiffAssemblyOptions
): Promise<SessionDiffUpload> {
  let totalPatchBytes = 0;
  const assembled = [];
  for (const repository of repositories.sort((a, b) => a.position - b.position)) {
    const files: SessionDiffFileUpload[] = [];
    for (const file of [...repository.files].sort((a, b) => a.path.localeCompare(b.path))) {
      if (file.before === file.after) continue;
      const status = file.before === null ? "added" : file.after === null ? "deleted" : "modified";
      const oldText = file.before ?? "";
      const newText = file.after ?? "";
      const { additions, deletions } = lineStats(oldText, newText);
      const patch = createGitPatch(file.path, oldText, newText, status, file.mode);
      const patchBytes = new TextEncoder().encode(patch).byteLength;
      const renderable =
        patchBytes <= SESSION_DIFF_MAX_FILE_PATCH_BYTES &&
        totalPatchBytes + patchBytes <= SESSION_DIFF_MAX_TOTAL_PATCH_BYTES;
      if (renderable) totalPatchBytes += patchBytes;
      files.push({
        id: await (options.fileId ?? defaultFileId)(repository.position, file.path),
        path: file.path,
        status,
        additions,
        deletions,
        renderState: renderable ? "renderable" : "too_large",
        oldMode: status === "added" ? "000000" : file.mode,
        newMode: status === "deleted" ? "000000" : file.mode,
        ...(renderable ? { patch } : {}),
      });
    }
    assembled.push({
      status: "ready" as const,
      position: repository.position,
      repoOwner: repository.repoOwner,
      repoName: repository.repoName,
      baseSha: repository.baseSha,
      headSha: repository.baseSha,
      truncated: false,
      omittedFileCount: 0,
      files,
    });
  }
  const bundle = {
    version: 1,
    triggerMessageId: options.triggerMessageId,
    capturedAt: options.capturedAt,
    repositories: assembled,
  } satisfies SessionDiffUpload;
  fitWireEnvelope(bundle);
  return sessionDiffUploadSchema.parse(bundle);
}

function fitWireEnvelope(bundle: SessionDiffUpload): void {
  const ready = bundle.repositories
    .filter((repository) => repository.status === "ready")
    .map((repository) => ({
      repository,
      files: [...repository.files],
      omitted: repository.omittedFileCount,
      truncated: repository.truncated,
    }));
  const totalFiles = ready.reduce((sum, item) => sum + item.files.length, 0);
  const applyLimit = (limit: number): void => {
    let remaining = limit;
    for (const item of ready) {
      const keep = Math.min(item.files.length, remaining);
      item.repository.files = item.files.slice(0, keep);
      const omitted = item.files.length - keep;
      item.repository.omittedFileCount = item.omitted + omitted;
      item.repository.truncated = item.truncated || omitted > 0;
      remaining -= keep;
    }
  };

  let low = 0;
  let high = Math.min(totalFiles, SESSION_DIFF_MAX_FILES);
  applyLimit(high);
  if (encodedBytes(bundle) <= SESSION_DIFF_MAX_BUNDLE_BYTES) return;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    applyLimit(middle);
    if (encodedBytes(bundle) <= SESSION_DIFF_MAX_BUNDLE_BYTES) low = middle;
    else high = middle - 1;
  }
  applyLimit(low);
  if (encodedBytes(bundle) > SESSION_DIFF_MAX_BUNDLE_BYTES) {
    throw new Error("Session diff repository metadata exceeds the wire envelope");
  }
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function lineStats(oldText: string, newText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(oldText, newText)) {
    if (change.added) additions += change.count ?? 0;
    if (change.removed) deletions += change.count ?? 0;
  }
  return { additions, deletions };
}

function createGitPatch(
  path: string,
  oldText: string,
  newText: string,
  status: "added" | "modified" | "deleted",
  mode: "100644" | "100755"
): string {
  const oldPath = status === "added" ? "/dev/null" : `a/${path}`;
  const newPath = status === "deleted" ? "/dev/null" : `b/${path}`;
  const body = createTwoFilesPatch(oldPath, newPath, oldText, newText, "", "", { context: 3 })
    .split("\n")
    .slice(1)
    .join("\n");
  const modeLine =
    status === "added"
      ? `new file mode ${mode}`
      : status === "deleted"
        ? `deleted file mode ${mode}`
        : null;
  return [`diff --git a/${path} b/${path}`, modeLine, body].filter(Boolean).join("\n");
}

async function defaultFileId(position: number, path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${position}:${path}`)
  );
  return `pi-${position}-${[...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
