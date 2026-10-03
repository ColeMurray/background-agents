import useSWR from "swr";
import { z } from "zod";
import {
  MEMORY_LIST_PAGE_SIZE,
  memoryListResponseSchema,
  memoryPreferencesSchema,
  memoryResponseSchema,
  memoryRevisionsResponseSchema,
  memoryScopeToSearchParams,
  sessionMemoryDiagnosticsSchema,
  sessionMemoryManifestSchema,
  type CreateMemoryInput,
  type MemoryAction,
  type MemoryActionInput,
  type MemoryContent,
  type MemoryDto,
  type MemoryPreferences,
  type MemoryPreviewInput,
  type MemoryScope,
  type MemoryStatus,
} from "@open-inspect/shared/types/memories";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

const errorResponseSchema = z.object({ error: z.string() });

const MEMORIES_KEY = "/api/memories";
const MEMORY_PREFERENCES_KEY = "/api/memory-preferences";
/** Pinned selections are immutable; polling only refreshes drift/archive flags. */
const SESSION_MEMORIES_REFRESH_INTERVAL_MS = 30_000;

/** IDs are opaque and must reach the BFF as one path segment. */
function memoryPath(id: string): BrowserApiPath {
  return `${MEMORIES_KEY}/${encodeURIComponent(id)}`;
}

async function apiRequest<T>(
  path: BrowserApiPath,
  schema: z.ZodType<T>,
  init?: RequestInit
): Promise<T> {
  const response = await browserApiFetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(data);
    throw new Error(parsedError.success ? parsedError.data.error : "Memory request failed");
  }
  return schema.parse(data);
}

function memoryListKey(scope: MemoryScope, status: MemoryStatus, offset: number): BrowserApiPath {
  const query = memoryScopeToSearchParams(scope);
  query.set("status", status);
  query.set("offset", String(offset));
  query.set("limit", String(MEMORY_LIST_PAGE_SIZE));
  return `${MEMORIES_KEY}?${query}`;
}

/** Cache each management page independently by scope, status, and offset. */
export function useMemories(scope: MemoryScope, status: MemoryStatus, offset: number) {
  const { data: session, status: authStatus } = useAuthSession();
  const { data, isLoading, error, mutate } = useSWR(
    session ? memoryListKey(scope, status, offset) : null,
    (path) => apiRequest(path, memoryListResponseSchema)
  );
  return {
    memories: data?.memories ?? [],
    nextOffset: data?.nextOffset ?? null,
    canCreate: data?.canCreate ?? false,
    loading: authStatus === "loading" || isLoading,
    error,
    mutate,
  };
}

/** Load a focused record independently of the current catalog page. */
export function useMemory(id: string | null) {
  const { data: session } = useAuthSession();
  const { data, isLoading, error, mutate } = useSWR(session && id ? memoryPath(id) : null, (path) =>
    apiRequest(path, memoryResponseSchema)
  );
  return { memory: data?.memory, loading: isLoading, error, mutate };
}

/** Fetch authorized immutable history only while a record is selected. */
export function useMemoryRevisions(id: string | null) {
  const { data: session } = useAuthSession();
  const { data, isLoading, error } = useSWR(
    session && id ? (`${memoryPath(id)}/revisions` as const) : null,
    (path) => apiRequest(path, memoryRevisionsResponseSchema)
  );
  return { revisions: data?.revisions ?? [], loading: isLoading, error };
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
    (path) => apiRequest(path, sessionMemoryDiagnosticsSchema),
    { refreshInterval: SESSION_MEMORIES_REFRESH_INTERVAL_MS }
  );
  return { diagnostics: data, loading: isLoading, error };
}

/** Preview without persisting a session; the whole input participates in the SWR cache key. */
export function useMemoryPreview(input: MemoryPreviewInput | null) {
  const { data: session } = useAuthSession();
  const { data, isLoading, error, mutate } = useSWR(
    session && input ? ([`${MEMORIES_KEY}/preview`, input] as const) : null,
    ([path, body]) =>
      apiRequest(path, sessionMemoryManifestSchema, { method: "POST", body: JSON.stringify(body) })
  );
  return { preview: data, loading: isLoading, error, mutate };
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

export async function applyMemoryAction(
  record: ReviewedMemory,
  action: MemoryAction,
  reason?: string
): Promise<MemoryDto> {
  const trimmedReason = reason?.trim();
  const body: MemoryActionInput = trimmedReason ? { reason: trimmedReason } : {};
  return (
    await apiRequest(`${memoryPath(record.id)}/${action}`, memoryResponseSchema, {
      method: "POST",
      headers: { "If-Match": record.currentRevisionId },
      body: JSON.stringify(body),
    })
  ).memory;
}

export async function setMemoryPreferences(input: MemoryPreferences): Promise<MemoryPreferences> {
  return apiRequest(MEMORY_PREFERENCES_KEY, memoryPreferencesSchema, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
