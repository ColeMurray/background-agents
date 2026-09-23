"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { MAX_SESSION_LIST_SEARCH_LENGTH } from "@open-inspect/shared/session-list-query";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { SessionDiscoveryFilters } from "@/components/session-discovery-filters";
import { SessionDiscoveryResults } from "@/components/session-discovery-results";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import { PlusIcon, SearchIcon, XIcon } from "@/components/ui/icons";
import { useAuthSession } from "@/lib/auth-session";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useEnvironments } from "@/hooks/use-environments";
import { useRepos } from "@/hooks/use-repos";
import { useSessionDiscovery } from "@/hooks/use-session-discovery";
import {
  buildSessionsHref,
  DEFAULT_SESSION_DISCOVERY_QUERY,
  hasSessionDiscoveryFilters,
  parseSessionDiscoveryQuery,
  type SessionDiscoveryQuery,
} from "@/lib/session-discovery";

const SEARCH_DEBOUNCE_MS = 300;
const MANAGE_ARCHIVED_SESSIONS_HREF = "/settings?tab=data-controls";

export default function SessionsPage() {
  return (
    <Suspense fallback={null}>
      <SessionsContent />
    </Suspense>
  );
}

function SessionsContent() {
  const { isOpen } = useSidebarContext();
  const router = useRouter();
  const searchParams = useSearchParams();
  const parsed = useMemo(
    () => parseSessionDiscoveryQuery(new URLSearchParams(searchParams.toString())),
    [searchParams]
  );
  const query = parsed.success ? parsed.data : DEFAULT_SESSION_DISCOVERY_QUERY;
  const invalidParams = parsed.success ? [] : parsed.invalidParams;
  const hasFilters = hasSessionDiscoveryFilters(query);
  const { hasPermission, loading: authorizationLoading } = useCurrentUserAuthorization();
  const canReadSessions = hasPermission("sessions.read");
  const canCreateSession = hasPermission("sessions.create");
  const { data: authSession } = useAuthSession();
  const currentUserId = authSession?.user.id ?? null;

  // The URL is the source of truth for the query. `latestQuery` is the newest
  // query this page has written or read, so two quick control changes compose
  // even before the first navigation has landed in `searchParams`.
  const latestQuery = useRef(query);
  useEffect(() => {
    latestQuery.current = query;
  }, [query]);

  // Search text the user has typed but the URL does not show yet. Null means
  // the box mirrors the URL and may be overwritten by back/forward navigation.
  const [searchText, setSearchText] = useState(query.q);
  const pendingSearch = useRef<string | null>(null);
  useEffect(() => {
    const pending = pendingSearch.current;
    if (pending === null) {
      setSearchText(query.q);
    } else if (pending.trim() === query.q) {
      // The typed text landed; keep it verbatim (a trailing space included).
      pendingSearch.current = null;
    }
  }, [query.q]);

  const updateQuery = useCallback(
    (patch: Partial<SessionDiscoveryQuery>) => {
      const pending = pendingSearch.current;
      // Compare against the state this page last wrote, not the rendered
      // URL: a reversal made before the previous navigation lands must still
      // be sent, or the earlier navigation wins and the reversal is lost.
      const previousHref = buildSessionsHref(latestQuery.current);
      const next = {
        ...latestQuery.current,
        ...(pending !== null ? { q: pending } : {}),
        ...patch,
      };
      latestQuery.current = next;
      if ("q" in patch) pendingSearch.current = null;
      const href = buildSessionsHref(next);
      if (href !== previousHref) router.replace(href, { scroll: false });
    },
    [router]
  );
  const clearFilters = useCallback(() => {
    pendingSearch.current = null;
    setSearchText("");
    latestQuery.current = DEFAULT_SESSION_DISCOVERY_QUERY;
    router.replace(buildSessionsHref(), { scroll: false });
  }, [router]);
  const resetSearch = useCallback(() => {
    setSearchText("");
    updateQuery({ q: "" });
  }, [updateQuery]);

  // Typing commits to the URL after a short pause so each keystroke is not a
  // navigation and a request. Only typed text is committed: a URL change from
  // elsewhere never restarts the timer with stale filters.
  useEffect(() => {
    if (pendingSearch.current === null) return;
    const timeoutId = window.setTimeout(() => {
      const pending = pendingSearch.current;
      if (pending === null) return;
      if (pending.trim() === latestQuery.current.q) {
        pendingSearch.current = null;
        return;
      }
      const next = { ...latestQuery.current, q: pending };
      latestQuery.current = next;
      router.replace(buildSessionsHref(next), { scroll: false });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [router, searchText]);

  const canQuery = canReadSessions && parsed.success;
  const { sessions, loading, loadingMore, error, hasMore, loadMore, retry } = useSessionDiscovery(
    query,
    { enabled: canQuery }
  );
  const { environments } = useEnvironments();
  const { repos } = useRepos(hasPermission("repositories.read"));
  const environmentNamesById = useMemo(
    () => new Map(environments.map((environment) => [environment.id, environment.name])),
    [environments]
  );
  const repositoryOptions = useMemo(
    () => repos.map((repo) => ({ repoOwner: repo.owner, repoName: repo.name })),
    [repos]
  );

  const showEmptyState = !loading && !error && sessions.length === 0;
  const statusText =
    invalidParams.length > 0
      ? "No sessions shown"
      : loading
        ? "Loading sessions"
        : showEmptyState
          ? hasFilters
            ? "No sessions match these filters"
            : "No sessions yet"
          : `Showing ${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}${
              hasMore ? " · More available" : ""
            }`;

  return (
    <div className="h-full flex flex-col">
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <CollapsedSidebarControls />
          </div>
        </header>
      )}

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="max-w-3xl mx-auto">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-foreground sm:text-3xl">Sessions</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Find past and current work, including archived sessions and older history.
              </p>
            </div>
            {canCreateSession && (
              <Button size="sm" asChild>
                <Link href="/" className="flex items-center gap-1.5">
                  <PlusIcon className="w-4 h-4" />
                  New session
                </Link>
              </Button>
            )}
          </div>

          {!authorizationLoading && !canReadSessions ? (
            <ErrorBanner role="alert">You do not have permission to view sessions.</ErrorBanner>
          ) : (
            <>
              <div className="relative mb-4">
                <label htmlFor="session-discovery-search" className="sr-only">
                  Search sessions by title, ID or repository
                </label>
                <SearchIcon
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="session-discovery-search"
                  type="search"
                  placeholder="Search title, ID or repository…"
                  value={searchText}
                  maxLength={MAX_SESSION_LIST_SEARCH_LENGTH}
                  onChange={(event) => {
                    pendingSearch.current = event.target.value;
                    setSearchText(event.target.value);
                  }}
                  className="pl-9 pr-9"
                />
                {searchText && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={resetSearch}
                    className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-muted-foreground transition hover:text-foreground"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <div className="mb-4">
                <SessionDiscoveryFilters
                  query={query}
                  repositories={repositoryOptions}
                  environments={environments}
                  hasFilters={hasFilters}
                  onChange={updateQuery}
                  onClear={clearFilters}
                />
              </div>

              {query.lifecycle === "archived" && (
                <p className="mb-4 text-xs text-muted-foreground">
                  Showing archived sessions.{" "}
                  <Link
                    href={MANAGE_ARCHIVED_SESSIONS_HREF}
                    className="text-accent hover:underline"
                  >
                    Manage archived sessions
                  </Link>
                </p>
              )}

              {invalidParams.length > 0 && (
                <ErrorBanner className="mb-4" role="alert">
                  <div className="flex items-center justify-between gap-4">
                    <span>
                      This link has unsupported filters ({invalidParams.join(", ")}), so no sessions
                      are shown.
                    </span>
                    <Button variant="outline" size="xs" onClick={clearFilters}>
                      Reset filters
                    </Button>
                  </div>
                </ErrorBanner>
              )}

              {/* Always mounted so each change is announced; hidden visually when a
                  larger block below says the same thing. */}
              <p
                role="status"
                aria-live="polite"
                className={
                  loading || showEmptyState || invalidParams.length > 0
                    ? "sr-only"
                    : "mb-2 text-xs text-muted-foreground"
                }
              >
                {statusText}
              </p>

              {error && (
                <ErrorBanner className="mb-4" role="alert">
                  <div className="flex items-center justify-between gap-4">
                    <span>Couldn&apos;t load sessions.</span>
                    <Button variant="outline" size="xs" onClick={() => void retry()}>
                      Retry
                    </Button>
                  </div>
                </ErrorBanner>
              )}

              {invalidParams.length > 0 ? null : loading ? (
                <div aria-hidden="true" className="flex justify-center py-12">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
                </div>
              ) : showEmptyState ? (
                hasFilters ? (
                  <div className="rounded-md border border-dashed border-border-muted px-4 py-10 text-center">
                    <p className="text-sm text-foreground">No sessions match these filters</p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border-muted px-4 py-10 text-center">
                    <p className="text-sm text-foreground">No sessions yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Sessions appear here once work starts.
                    </p>
                    {canCreateSession && (
                      <Button size="sm" className="mt-3" asChild>
                        <Link href="/">New session</Link>
                      </Button>
                    )}
                  </div>
                )
              ) : sessions.length > 0 ? (
                <SessionDiscoveryResults
                  sessions={sessions}
                  environmentNamesById={environmentNamesById}
                  currentUserId={currentUserId}
                />
              ) : null}

              {(hasMore || loadingMore) && !loading && (
                <div className="flex justify-center pt-4">
                  <Button
                    variant="outline"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                    aria-label="Load more sessions"
                  >
                    {loadingMore ? "Loading more..." : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
