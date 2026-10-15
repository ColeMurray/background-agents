/** How long a search box waits after the last keystroke before applying the search. */
export const SEARCH_DEBOUNCE_MS = 300;

export function matchesSearchTerms(searchText: string, query: string): boolean {
  const normalizedSearchText = searchText.toLowerCase();
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => normalizedSearchText.includes(term));
}
