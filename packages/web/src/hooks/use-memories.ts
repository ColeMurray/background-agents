import useSWR from "swr";
import { z } from "zod";
import {
  memoryPreferencesSchema,
  memoryRevisionSchema,
  memoryViewSchema,
  sessionMemoryManifestSchema,
  type MemoryScope,
  type MemoryStatus,
} from "@open-inspect/shared/types/memories";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

export async function memoryRequest<T>(
  path: BrowserApiPath,
  schema: z.ZodType<T>,
  init?: RequestInit
): Promise<T> {
  const response = await browserApiFetch(path, init);
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : "Memory request failed");
  }
  return schema.parse(body);
}
export function memoryScopeQuery(scope: MemoryScope): URLSearchParams {
  const query = new URLSearchParams({ scope: scope.type });
  if (scope.type === "repository") {
    query.set("repoOwner", scope.repoOwner);
    query.set("repoName", scope.repoName);
  }
  if (scope.type === "environment") query.set("environmentId", scope.environmentId);
  return query;
}
export function memorySettingsLink(scope: MemoryScope, id: string): string {
  const query = memoryScopeQuery(scope);
  query.set("tab", scope.type === "personal" ? "memories" : "shared-memories");
  query.set("memoryId", id);
  return `/settings?${query}`;
}
export function useMemories(scope: MemoryScope | null, status: MemoryStatus) {
  const query = scope ? memoryScopeQuery(scope) : null;
  query?.set("status", status);
  return useSWR(query ? (`/api/memories?${query}` as const) : null, (path) =>
    memoryRequest(path, z.object({ memories: z.array(memoryViewSchema), canCreate: z.boolean() }))
  );
}
export function useMemory(id: string | null) {
  return useSWR(id ? (`/api/memories/${encodeURIComponent(id)}` as const) : null, (path) =>
    memoryRequest(path, z.object({ memory: memoryViewSchema }))
  );
}
export function useMemoryPreferences(enabled = true) {
  return useSWR(enabled ? ("/api/memory-preferences" as const) : null, (path) =>
    memoryRequest(path, memoryPreferencesSchema)
  );
}
export function useSessionMemories(sessionId: string) {
  return useSWR(
    `/api/sessions/${encodeURIComponent(sessionId)}/memories` as const,
    (path) => memoryRequest(path, sessionMemoryManifestSchema),
    { refreshInterval: 30_000 }
  );
}
export function useMemoryRevisions(id: string | null) {
  return useSWR(
    id ? (`/api/memories/${encodeURIComponent(id)}/revisions` as const) : null,
    (path) => memoryRequest(path, z.object({ revisions: z.array(memoryRevisionSchema) }))
  );
}
export function useMemoryPreview(
  target: {
    repoOwner?: string;
    repoName?: string;
    repositories?: readonly { repoOwner: string; repoName: string }[];
    environmentId?: string | null;
  } | null,
  includePersonalMemories: boolean
) {
  const body = target
    ? JSON.stringify({
        ...(target.environmentId
          ? { environmentId: target.environmentId }
          : {
              repositories:
                target.repositories ??
                (target.repoOwner && target.repoName
                  ? [{ repoOwner: target.repoOwner, repoName: target.repoName }]
                  : []),
            }),
        includePersonalMemories,
      })
    : null;
  return useSWR(body ? (["/api/memories/preview", body] as const) : null, ([path, body]) =>
    memoryRequest(path, sessionMemoryManifestSchema, { method: "POST", body })
  );
}
