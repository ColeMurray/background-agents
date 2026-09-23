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
// `README.md:42` also matches SCHEME, but a colon followed only by a line reference is not one.
const PATH_WITH_LINE_REFERENCE = /^[^:/?#]+:\d+(?::\d+)?(?:[?#]|$)/;

export function isPathWithLineReference(href: string): boolean {
  return PATH_WITH_LINE_REFERENCE.test(href);
}

/**
 * Whether an href in agent output names a file in the sandbox rather than something the
 * browser can open: not a URL with a scheme (`https:`, `mailto:`), not protocol-relative,
 * not a bare anchor, and not a root-relative app path other than a `/workspace/` checkout.
 */
export function isRepositoryFileHref(href: string | undefined): href is string {
  if (!href) return false;
  if (SCHEME.test(href) && !isPathWithLineReference(href)) return false;
  if (href.startsWith("//") || href.startsWith("#")) return false;
  if (href.startsWith("/")) return href.startsWith(WORKSPACE_PREFIX);
  return true;
}

/**
 * Candidate paths for an href, most exact first: the decoded path itself, then the path
 * with a trailing line reference removed. Git allows a filename that really ends in `:42`,
 * so the literal path gets the first chance to match.
 */
function candidatePaths(href: string): string[] {
  let path = href.replace(/[?#].*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return [];
  }
  while (path.startsWith("./")) path = path.slice(2);
  const candidates = [path];
  const withoutLine = path.replace(LINE_REFERENCE, "");
  if (withoutLine !== path) candidates.push(withoutLine);
  return candidates.filter(Boolean);
}

interface RepositoryIndex {
  position: number;
  paths: Set<string>;
  // Old path of a renamed file -> its current path.
  oldPaths: Map<string, string>;
}

function indexRepository(repository: ReadySessionDiffRepository): RepositoryIndex {
  const paths = new Set<string>();
  const oldPaths = new Map<string, string>();
  for (const file of repository.files) {
    paths.add(file.path);
    if (file.oldPath && !oldPaths.has(file.oldPath)) oldPaths.set(file.oldPath, file.path);
  }
  return { position: repository.position, paths, oldPaths };
}

function lookup(repositories: RepositoryIndex[], path: string): DiffSelection | null {
  // Git paths are case-sensitive. A current path always wins over a renamed file's old
  // path, so a rename away from `z.ts` followed by a new `z.ts` still resolves to the new one.
  for (const repository of repositories) {
    if (repository.paths.has(path)) return { repositoryPosition: repository.position, path };
  }
  for (const repository of repositories) {
    const current = repository.oldPaths.get(path);
    if (current) return { repositoryPosition: repository.position, path: current };
  }
  return null;
}

export type DiffFileLinkResolver = (href: string | undefined) => DiffSelection | null;

/**
 * Build a resolver that maps hrefs from agent output onto changed files in one diff
 * manifest. The index is built once, so resolving each link is a few map lookups.
 *
 * `/workspace/<repoName>/<path>` resolves within that repository (repoName compared
 * case-insensitively). A relative path that exists in several repositories resolves to the
 * one with the lowest position, i.e. the primary repository.
 */
export function createDiffFileLinkResolver(manifest: SessionDiffManifest): DiffFileLinkResolver {
  const repositories = manifest.repositories
    .filter((repository): repository is ReadySessionDiffRepository => repository.status === "ready")
    .sort((a, b) => a.position - b.position)
    .map((repository) => ({
      name: repository.repoName.toLowerCase(),
      index: indexRepository(repository),
    }));
  const allIndexes = repositories.map((repository) => repository.index);

  return (href) => {
    if (!isRepositoryFileHref(href)) return null;
    for (const path of candidatePaths(href)) {
      if (path.startsWith(WORKSPACE_PREFIX)) {
        const rest = path.slice(WORKSPACE_PREFIX.length);
        const slash = rest.indexOf("/");
        if (slash <= 0) continue;
        const repoName = rest.slice(0, slash).toLowerCase();
        const repository = repositories.find((candidate) => candidate.name === repoName);
        const selection = repository && lookup([repository.index], rest.slice(slash + 1));
        if (selection) return selection;
        continue;
      }
      const selection = lookup(allIndexes, path);
      if (selection) return selection;
    }
    return null;
  };
}

/** One-off resolution; build a resolver with `createDiffFileLinkResolver` for repeated use. */
export function resolveDiffFileLink(
  manifest: SessionDiffManifest,
  href: string | undefined
): DiffSelection | null {
  return createDiffFileLinkResolver(manifest)(href);
}
