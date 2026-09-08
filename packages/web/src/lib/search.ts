export function matchesSearchTerms(searchText: string, query: string): boolean {
  const normalizedSearchText = searchText.toLowerCase();
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => normalizedSearchText.includes(term));
}
