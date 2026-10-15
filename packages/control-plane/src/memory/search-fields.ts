/**
 * The current-revision fields a memory text search matches, strongest signal first. Shared by
 * agent fact search (which ranks by them) and the management list (which only filters).
 */
export const MEMORY_SEARCH_FIELDS = ["title", "description", "content"] as const;
export type MemorySearchField = (typeof MEMORY_SEARCH_FIELDS)[number];
