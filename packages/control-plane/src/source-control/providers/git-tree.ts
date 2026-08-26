import type { RepositoryTreeEntry } from "../types";

/** Classify Git tree entries from both object kind and mode. */
export function classifyGitTreeEntry(type: string, mode: string): RepositoryTreeEntry["type"] {
  if (type === "tree" && mode === "040000") return "directory";
  if (type === "blob" && (mode === "100644" || mode === "100755")) return "file";
  // Symlinks (120000), submodules (160000), and unknown modes are unsupported.
  return "other";
}
