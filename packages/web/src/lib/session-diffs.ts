import type {
  SessionDiffFile,
  SessionDiffManifest,
  SessionDiffRepository,
  SessionDiffState,
} from "@open-inspect/shared";

type ReadySessionDiffRepository = Extract<SessionDiffRepository, { status: "ready" }>;

export interface DiffSelection {
  repositoryPosition: number;
  path: string;
}

export type ResolvedDiffSelection =
  | {
      status: "ready";
      revisionId: string;
      repository: ReadySessionDiffRepository;
      file: SessionDiffFile;
    }
  | { status: "missing"; revisionId: string };

export type SessionDiffViewKind =
  | "hidden"
  | "loading"
  | "error"
  | "unavailable"
  | "available_after_execution"
  | "working"
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
}): SessionDiffView {
  const base = { showManifest: false, canRetry: false };
  if (!input.hasRepository) return { kind: "hidden", ...base };
  if (input.isLoading) return { kind: "loading", ...base };
  if (!input.state) return { kind: "error", ...base };

  const { state } = input;
  const showManifest = state.current !== null;
  if (state.unavailableReason) {
    return {
      kind: "unavailable",
      ...base,
      message: state.unavailableReason,
    };
  }
  if (input.isProcessing) return { kind: "working", showManifest, canRetry: false };
  if (state.lastError) {
    return {
      kind: "failed",
      showManifest,
      canRetry: true,
      message: state.lastError.message,
    };
  }
  if (!state.current) return { kind: "available_after_execution", ...base };
  const hasFiles = state.current.repositories.some((repository) => repository.files.length > 0);
  return { kind: hasFiles ? "ready" : "empty", showManifest: true, canRetry: false };
}

export function resolveDiffSelection(
  manifest: SessionDiffManifest,
  selection: DiffSelection
): ResolvedDiffSelection {
  const repository = manifest.repositories.find(
    (candidate): candidate is ReadySessionDiffRepository =>
      candidate.position === selection.repositoryPosition && candidate.status === "ready"
  );
  const file = repository?.files.find((candidate) => candidate.path === selection.path);
  return repository && file
    ? { status: "ready", revisionId: manifest.revisionId, repository, file }
    : { status: "missing", revisionId: manifest.revisionId };
}

export interface DiffErrorBody {
  code?: string;
  error?: string;
}

/** Narrows an untrusted diff error-response body to the fields the UI reads. */
export function parseDiffErrorBody(value: unknown): DiffErrorBody {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const body: DiffErrorBody = {};
  if (typeof record.code === "string") body.code = record.code;
  if (typeof record.error === "string") body.error = record.error;
  return body;
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
