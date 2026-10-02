"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { AutomationCollection } from "@/components/automations/automation-collection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlusIcon, SearchIcon } from "@/components/ui/icons";
import { automationNavigation, automationScopeTeamId } from "@/lib/automation-navigation";

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
  const teamId = automationScopeTeamId(searchParams.get("teamId"));
  const navigation = automationNavigation(teamId);
  const [nameSearch, setNameSearch] = useState(urlNameSearch);

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
          <AutomationCollection teamId={teamId} nameSearch={committedNameSearch}>
            {(canCreate) => (
              <>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
                  <h1 className="text-2xl font-semibold text-foreground sm:text-3xl">
                    Automations
                  </h1>
                  {canCreate && (
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" asChild>
                        <Link href={navigation.templates}>Browse templates</Link>
                      </Button>
                      <Button size="sm" asChild>
                        <Link href={navigation.new()} className="flex items-center gap-1.5">
                          <PlusIcon className="w-4 h-4" />
                          Create Automation
                        </Link>
                      </Button>
                    </div>
                  )}
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
              </>
            )}
          </AutomationCollection>
        </div>
      </div>
    </div>
  );
}
