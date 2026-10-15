"use client";

import { memoryListSearchFromInput } from "@open-inspect/shared/types/memories";
import { useUrlSearchParam } from "@/hooks/use-url-search-param";

/** What to write to `?search=` for typed text, or null for a search that is explained instead. */
function commitMemorySearch(raw: string): string | null {
  const checked = memoryListSearchFromInput(raw);
  return "search" in checked ? checked.search : null;
}

/**
 * The memory list's search box, kept in `?search=`. `search` is what the list applies and comes
 * from the URL, so a shared link filters the same way; `problem` explains typed text the server
 * would reject, while the last valid results stay on screen.
 */
export function useMemorySearch() {
  const { text, setText, value } = useUrlSearchParam("search", commitMemorySearch);
  const typed = memoryListSearchFromInput(text);
  return {
    text,
    setText,
    search: commitMemorySearch(value) ?? "",
    problem: "problem" in typed ? typed.problem : null,
  };
}
