import useSWR from "swr";
import type { z } from "zod";
import {
  bulkMemoryActionResponseSchema,
  MEMORY_BULK_ACTION_MAX_RECORDS,
  MEMORY_LIST_PAGE_SIZE,
  memoryActionAcceptsNote,
  memoryListResponseSchema,
  memoryPreferencesSchema,
  memoryResponseSchema,
  memoryRevisionsResponseSchema,
  memoryScopeToSearchParams,
  sessionMemorySelectionStatusSchema,
  type BulkMemoryActionInput,
  type BulkMemoryActionResponse,
  type CreateMemoryInput,
  type MemoryAction,
  type MemoryActionBody,
  type MemoryContent,
  type MemoryDto,
  type MemoryPreferences,
  type MemoryListScope,
  type MemoryStatus,
} from "@open-inspect/shared/types/memories";
import { useAuthSession } from "@/lib/auth-session";
import type { BrowserApiPath } from "@/lib/browser-api-fetch";
import { browserApiJson } from "@/lib/browser-api-json";

const MEMORIES_KEY = "/api/memories";
const MEMORY_PREFERENCES_KEY = "/api/memory-preferences";
/** Pinned selections are immutable; polling only refreshes drift/archive flags. */
const SESSION_MEMORIES_REFRESH_INTERVAL_MS = 30_000;

/** IDs are opaque and must reach the BFF as one path segment. */
function memoryPath(id: string): BrowserApiPath {
  return `${MEMORIES_KEY}/${encodeURIComponent(id)}`;
}

function apiRequest<T>(path: BrowserApiPath, schema: z.ZodType<T>, init?: RequestInit) {
  return browserApiJson(path, schema, "Memory request failed", init);
}

function memoryListKey(
  scope: MemoryListScope,
  status: MemoryStatus,
  offset: number,
  search: string
): BrowserApiPath {
  const query =
    scope === "shared"
      ? new URLSearchParams({ scope: "shared" })
      : memoryScopeToSearchParams(scope);
  query.set("status", status);
  query.set("offset", String(offset));
  query.set("limit", String(MEMORY_LIST_PAGE_SIZE));
  if (search) query.set("search", search);
  return `${MEMORIES_KEY}?${query}`;
}

/** Cache each management page independently by scope, status, offset, and search text. */
export function useMemories(
  scope: MemoryListScope,
  status: MemoryStatus,
  offset: number,
  search: string
) {
  const { data: session, status: authStatus } = useAuthSession();
  const { data, isLoading, error, mutate } = useSWR(
    session ? memoryListKey(scope, status, offset, search) : null,
    (path) => apiRequest(path, memoryListResponseSchema)
  );
  return {
    memories: data?.memories ?? [],
    nextOffset: data?.nextOffset ?? null,
    truncated: data?.truncated ?? false,
    canCreate: data?.canCreate ?? false,
    loading: authStatus === "loading" || isLoading,
    error,
    mutate,
  };
}

/** Load a focused record independently of the current catalog page. */
export function useMemory(id: string | null) {
  const { data: session } = useAuthSession();
  const { data, error, mutate } = useSWR(session && id ? memoryPath(id) : null, (path) =>
    apiRequest(path, memoryResponseSchema)
  );
  return { memory: data?.memory, error, mutate };
}

/** Fetch authorized immutable history only while a record is selected. */
export function useMemoryRevisions(id: string) {
  const { data: session, status: authStatus } = useAuthSession();
  const { data, isLoading, error } = useSWR(
    session ? (`${memoryPath(id)}/revisions` as const) : null,
    (path) => apiRequest(path, memoryRevisionsResponseSchema)
  );
  return {
    revisions: data?.revisions ?? [],
    loading: authStatus === "loading" || isLoading,
    error,
  };
}

/** Load the saved default; session creation may proceed using the server default while unavailable. */
export function useMemoryPreferences() {
  const { data: session, status } = useAuthSession();
  const { data, isLoading, error, mutate } = useSWR(
    session ? MEMORY_PREFERENCES_KEY : null,
    (path) => apiRequest(path, memoryPreferencesSchema)
  );
  return { preferences: data, loading: status === "loading" || isLoading, error, mutate };
}

/** Refresh drift/archive diagnostics without changing the session's pinned selection. */
export function useSessionMemories(sessionId: string) {
  const { data, isLoading, error } = useSWR(
    `/api/sessions/${encodeURIComponent(sessionId)}/memories` as const,
    (path) => apiRequest(path, sessionMemorySelectionStatusSchema),
    { refreshInterval: SESSION_MEMORIES_REFRESH_INTERVAL_MS }
  );
  return { diagnostics: data, loading: isLoading, error };
}

/** Send only the editable fields so callers can pass a record or revision directly. */
function contentFields({ memoryType, title, description, content }: MemoryContent): MemoryContent {
  return { memoryType, title, description, content };
}

/** The revision a mutation was reviewed against; the server rejects it if the record moved on. */
type ReviewedMemory = Pick<MemoryDto, "id" | "currentRevisionId">;

export async function createMemory(input: CreateMemoryInput): Promise<MemoryDto> {
  const { scope, supersedesMemoryId } = input;
  const body: CreateMemoryInput = {
    ...contentFields(input),
    scope,
    ...(supersedesMemoryId ? { supersedesMemoryId } : {}),
  };
  return (
    await apiRequest(MEMORIES_KEY, memoryResponseSchema, {
      method: "POST",
      body: JSON.stringify(body),
    })
  ).memory;
}

export async function reviseMemory(
  record: ReviewedMemory,
  content: MemoryContent
): Promise<MemoryDto> {
  return (
    await apiRequest(memoryPath(record.id), memoryResponseSchema, {
      method: "PATCH",
      headers: { "If-Match": record.currentRevisionId },
      body: JSON.stringify(contentFields(content)),
    })
  ).memory;
}

/** A trimmed archive note, sent only with actions that archive. */
function actionNote(action: MemoryAction, archiveNote?: string): { archiveNote?: string } {
  const note = archiveNote?.trim();
  return note && memoryActionAcceptsNote(action) ? { archiveNote: note } : {};
}

/** Apply a lifecycle action; an archive note is sent only with actions that archive. */
export async function applyMemoryAction(
  record: ReviewedMemory,
  action: MemoryAction,
  archiveNote?: string
): Promise<MemoryDto> {
  const body: MemoryActionBody = actionNote(action, archiveNote);
  return (
    await apiRequest(`${memoryPath(record.id)}/${action}`, memoryResponseSchema, {
      method: "POST",
      headers: { "If-Match": record.currentRevisionId },
      body: JSON.stringify(body),
    })
  ).memory;
}

/**
 * Apply one action to several reviewed records; the server decides each independently. Selections
 * larger than one request allows go in sequential requests. A failed request stops the rest, and
 * its records and the unsent ones are reported as failed so earlier results still count.
 */
export async function applyBulkMemoryAction(
  records: readonly ReviewedMemory[],
  action: MemoryAction,
  archiveNote?: string
): Promise<BulkMemoryActionResponse["results"]> {
  const results: BulkMemoryActionResponse["results"] = [];
  for (let start = 0; start < records.length; start += MEMORY_BULK_ACTION_MAX_RECORDS) {
    const body: BulkMemoryActionInput = {
      action,
      memories: records
        .slice(start, start + MEMORY_BULK_ACTION_MAX_RECORDS)
        .map((record) => ({ id: record.id, revisionId: record.currentRevisionId })),
      ...actionNote(action, archiveNote),
    };
    try {
      const response = await apiRequest(`${MEMORIES_KEY}/bulk`, bulkMemoryActionResponseSchema, {
        method: "POST",
        body: JSON.stringify(body),
      });
      results.push(...response.results);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "Memory request failed";
      results.push(...records.slice(start).map(({ id }) => ({ id, ok: false as const, error })));
      break;
    }
  }
  return results;
}

export async function setMemoryPreferences(input: MemoryPreferences): Promise<MemoryPreferences> {
  return apiRequest(MEMORY_PREFERENCES_KEY, memoryPreferencesSchema, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
