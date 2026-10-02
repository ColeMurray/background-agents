"use client";
import useSWR, { useSWRConfig } from "swr";
import { projectViewSchema, type ProjectView } from "@open-inspect/shared/types/projects";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

export async function projectRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await browserApiFetch(path as BrowserApiPath, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}
export function useProjects(
  filters: { status?: string; search?: string; mine?: boolean; teamId?: string } = {}
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined && value !== "") params.set(key, String(value));
  const query = useSWR(`/api/projects?${params}`, async (path) => {
    const data = await projectRequest<{ projects: unknown[] }>(path);
    return data.projects.map((project) => projectViewSchema.parse(project));
  });
  return {
    projects: query.data ?? [],
    loading: query.isLoading,
    error: query.error,
    refresh: query.mutate,
  };
}
export function useProject(slug: string) {
  const query = useSWR(
    slug ? `/api/projects/by-slug/${encodeURIComponent(slug)}` : null,
    async (path) => {
      const data = await projectRequest<{ project: unknown }>(path);
      return projectViewSchema.parse(data.project);
    }
  );
  return {
    project: query.data,
    loading: query.isLoading,
    error: query.error,
    refresh: query.mutate,
  };
}
export function useProjectMutations() {
  const { mutate } = useSWRConfig();
  return async <T>(path: string, method: string, body?: unknown): Promise<T> => {
    const result = await projectRequest<T>(path, method, body);
    await mutate(
      (key) =>
        typeof key === "string" &&
        (key.startsWith("/api/projects") || key.startsWith("/api/sessions"))
    );
    return result;
  };
}
export type { ProjectView };
