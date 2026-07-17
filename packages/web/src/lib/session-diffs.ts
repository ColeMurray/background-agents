import type {
  SessionDiffFile,
  SessionDiffManifest,
  SessionDiffRepository,
  SessionDiffState,
} from "@open-inspect/shared";

export interface DiffSelection {
  repositoryPosition: number;
  path: string;
}

export type ResolvedDiffSelection =
  | {
      status: "ready";
      revisionId: string;
      repository: SessionDiffRepository;
      file: SessionDiffFile;
    }
  | { status: "missing"; revisionId: string };

export type SessionDiffViewKind =
  | "hidden"
  | "loading"
  | "error"
  | "preparing"
  | "unavailable"
  | "available_after_execution"
  | "working"
  | "capturing"
  | "failed"
  | "empty"
  | "ready";

export interface SessionDiffView {
  kind: SessionDiffViewKind;
  showManifest: boolean;
  canRetry: boolean;
  message?: string;
}

export function deriveSessionDiffView(input: {
  hasRepository: boolean;
  isProcessing: boolean;
  state: SessionDiffState | null;
  isLoading: boolean;
  hasError: boolean;
}): SessionDiffView {
  const base = { showManifest: false, canRetry: false };
  if (!input.hasRepository) return { kind: "hidden", ...base };
  if (input.isLoading) return { kind: "loading", ...base };
  if (!input.state) return { kind: "error", ...base };

  const { state } = input;
  const showManifest = state.current !== null;
  if (state.baseline.status === "pending") return { kind: "preparing", ...base };
  if (state.baseline.status === "unavailable") {
    return {
      kind: "unavailable",
      ...base,
      message: state.baseline.reason ?? "Changes are unavailable for this session.",
    };
  }
  if (state.attempt.status === "capturing") {
    return { kind: "capturing", showManifest, canRetry: false };
  }
  if (state.attempt.status === "failed") {
    return {
      kind: "failed",
      showManifest,
      canRetry: true,
      message: state.attempt.error ?? "Changes refresh failed.",
    };
  }
  if (input.isProcessing) return { kind: "working", showManifest, canRetry: false };
  if (!state.current) return { kind: "available_after_execution", ...base };
  const hasFiles = state.current.repositories.some((repository) => repository.files.length > 0);
  return { kind: hasFiles ? "ready" : "empty", showManifest: true, canRetry: false };
}

export function resolveDiffSelection(
  manifest: SessionDiffManifest,
  selection: DiffSelection
): ResolvedDiffSelection {
  const repository = manifest.repositories.find(
    (candidate) => candidate.position === selection.repositoryPosition
  );
  const file = repository?.files.find((candidate) => candidate.path === selection.path);
  return repository && file
    ? { status: "ready", revisionId: manifest.revisionId, repository, file }
    : { status: "missing", revisionId: manifest.revisionId };
}

export function buildUniquePathLabels(paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const path of paths) {
    const parts = path.split("/");
    let depth = 1;
    while (depth < parts.length) {
      const label = parts.slice(-depth).join("/");
      const clashes = paths.filter(
        (candidate) => candidate !== path && candidate.split("/").slice(-depth).join("/") === label
      );
      if (clashes.length === 0) break;
      depth += 1;
    }
    result[path] = parts.slice(-depth).join("/");
  }
  return result;
}
