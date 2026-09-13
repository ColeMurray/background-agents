import type {
  SessionDiffManifest,
  SessionDiffRepository,
} from "@open-inspect/shared/types/session-diffs";
import type { DiffSelection } from "./session-diffs";

type ReadySessionDiffRepository = Extract<SessionDiffRepository, { status: "ready" }>;

// Checkouts live at /workspace/{repoName}, and repoName is unique per session.
const WORKSPACE_PREFIX = "/workspace/";
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// A trailing `:42` or `:42:7` line reference; the file still resolves, the line is ignored.
const LINE_REFERENCE = /:\d+(?::\d+)?$/;

/**
 * Whether an href in agent output names a file in the sandbox rather than something the
 * browser can open: not a URL with a scheme (`https:`, `mailto:`), not protocol-relative,
 * not a bare anchor, and not a root-relative app path other than a `/workspace/` checkout.
 */
export function isRepositoryFileHref(href: string | undefined): href is string {
  if (!href) return false;
  if (SCHEME.test(href) || href.startsWith("//") || href.startsWith("#")) return false;
  if (href.startsWith("/")) return href.startsWith(WORKSPACE_PREFIX);
  return true;
}

function normalizeFileHref(href: string): string | null {
  let path = href.replace(/[?#].*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  path = path.replace(LINE_REFERENCE, "");
  while (path.startsWith("./")) path = path.slice(2);
  return path || null;
}

function findFile(repository: ReadySessionDiffRepository, path: string): DiffSelection | null {
  // Git paths are case-sensitive; a renamed file also resolves by its old path.
  const file = repository.files.find(
    (candidate) => candidate.path === path || candidate.oldPath === path
  );
  return file ? { repositoryPosition: repository.position, path: file.path } : null;
}

/**
 * Map an href from agent output onto a changed file in the session's diff manifest.
 *
 * `/workspace/<repoName>/<path>` resolves within that repository (repoName compared
 * case-insensitively). A relative path that exists in several repositories resolves to the
 * one with the lowest position, i.e. the primary repository.
 */
export function resolveDiffFileLink(
  manifest: SessionDiffManifest,
  href: string | undefined
): DiffSelection | null {
  if (!isRepositoryFileHref(href)) return null;
  const path = normalizeFileHref(href);
  if (!path) return null;

  const repositories = manifest.repositories
    .filter((repository): repository is ReadySessionDiffRepository => repository.status === "ready")
    .sort((a, b) => a.position - b.position);

  if (path.startsWith(WORKSPACE_PREFIX)) {
    const rest = path.slice(WORKSPACE_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    const repoName = rest.slice(0, slash).toLowerCase();
    const repository = repositories.find(
      (candidate) => candidate.repoName.toLowerCase() === repoName
    );
    return repository ? findFile(repository, rest.slice(slash + 1)) : null;
  }

  for (const repository of repositories) {
    const selection = findFile(repository, path);
    if (selection) return selection;
  }
  return null;
}
