"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { useAutomations } from "@/hooks/use-automations";
import { AutomationsList } from "@/components/automations/automations-list";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import { PlusIcon, SearchIcon } from "@/components/ui/icons";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

const SEARCH_DEBOUNCE_MS = 300;

export default function AutomationsPage() {
  return (
    <Suspense fallback={null}>
      <AutomationsContent />
    </Suspense>
  );
}

function AutomationsContent() {
  const { isOpen } = useSidebarContext();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlNameSearch = searchParams.get("search") ?? "";
  const committedNameSearch = urlNameSearch.trim();
  const [nameSearch, setNameSearch] = useState(urlNameSearch);
  const { automations, loading, loadingMore, error, hasMore, loadMore, mutate } =
    useAutomations(committedNameSearch);

  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setNameSearch(urlNameSearch);
  }, [urlNameSearch]);

  useEffect(() => {
    const debounceTimeoutId = window.setTimeout(() => {
      const normalizedNameSearch = nameSearch.trim();

      const nextSearchParams = new URLSearchParams(searchParams.toString());
      if (normalizedNameSearch) {
        nextSearchParams.set("search", normalizedNameSearch);
      } else {
        nextSearchParams.delete("search");
      }

      if (nextSearchParams.toString() !== searchParams.toString()) {
        const queryString = nextSearchParams.toString();
        router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(debounceTimeoutId);
  }, [nameSearch, pathname, router, searchParams]);

  const handleAction = async (id: string, action: "pause" | "resume" | "trigger" | "delete") => {
    setActionError(null);
    const endpoint: BrowserApiPath =
      action === "delete" ? `/api/automations/${id}` : `/api/automations/${id}/${action}`;
    const method = action === "delete" ? "DELETE" : "POST";

    try {
      const res = await browserApiFetch(endpoint, { method });
      if (!res.ok) {
        setActionError(`Failed to ${action} automation`);
        return;
      }
      mutate();
    } catch (error) {
      console.error(`Failed to ${action} automation:`, error);
      setActionError(`Failed to ${action} automation`);
    }
  };

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
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
            <h1 className="text-2xl font-semibold text-foreground sm:text-3xl">Automations</h1>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href="/automations/templates">Browse templates</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href="/automations/new" className="flex items-center gap-1.5">
                  <PlusIcon className="w-4 h-4" />
                  Create Automation
                </Link>
              </Button>
            </div>
          </div>

          <div className="relative mb-4">
            <SearchIcon
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label="Search automations by name"
              placeholder="Search automations by name"
              value={nameSearch}
              maxLength={200}
              onChange={(event) => setNameSearch(event.target.value)}
              className="pl-9"
            />
          </div>

          {actionError && (
            <ErrorBanner className="mb-4" role="alert">
              {actionError}
            </ErrorBanner>
          )}

          {error && (
            <ErrorBanner className="mb-4" role="alert">
              <div className="flex items-center justify-between gap-4">
                <span>Failed to load automations.</span>
                <Button variant="outline" size="xs" onClick={() => void mutate()}>
                  Retry
                </Button>
              </div>
            </ErrorBanner>
          )}

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
            </div>
          ) : automations.length > 0 || !error ? (
            <AutomationsList
              automations={automations}
              emptyState={
                committedNameSearch
                  ? { kind: "no-search-results", nameSearch: committedNameSearch }
                  : { kind: "no-automations" }
              }
              onPause={(id) => handleAction(id, "pause")}
              onResume={(id) => handleAction(id, "resume")}
              onTrigger={(id) => handleAction(id, "trigger")}
              onDelete={(id) => handleAction(id, "delete")}
            />
          ) : null}

          {(hasMore || loadingMore) && !loading && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                aria-label="Load more automations"
              >
                {loadingMore ? "Loading more..." : "Load more"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
