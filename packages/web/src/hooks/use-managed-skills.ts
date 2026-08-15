import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import type {
  CreateSkillInput,
  EditSkillInput,
  Skill,
  SkillContentInput,
  SkillProfile,
  ResolvedSkill,
  SkillSummary,
  UpdateSkillInput,
} from "@open-inspect/shared/types/skills";
import type { skillResolutionPreviewInputSchema } from "@open-inspect/shared/types/skills";
import type { z } from "zod";

export type SkillResolutionPreviewInput = z.infer<typeof skillResolutionPreviewInputSchema>;

export interface SkillResolutionPreviewResponse {
  skills: ResolvedSkill[];
  totalBytes: number;
  ignoredProfileSkillIds: string[];
}

export interface SkillContentPreview {
  skillMarkdown: string;
  contentSha256: string;
  totalBytes: number;
}

export const SKILLS_KEY = "/api/skills";
export const SKILL_PROFILES_KEY = "/api/skill-profiles";

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await browserApiFetch(path as `/api/${string}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Managed skills request failed");
  return data;
}

export function useSkills() {
  const { data: session, status } = useAuthSession();
  const { data, isLoading, error, mutate } = useSWR<{ skills: SkillSummary[] }>(
    session ? SKILLS_KEY : null
  );
  return {
    skills: data?.skills ?? [],
    loading: status === "loading" || isLoading,
    error,
    mutate,
  };
}

export function useSkill(id: string | null) {
  const { data: session } = useAuthSession();
  const { data, isLoading, error, mutate } = useSWR<{ skill: Skill }>(
    session && id ? `${SKILLS_KEY}/${id}` : null
  );
  return { skill: data?.skill, loading: isLoading, error, mutate };
}

export function useSkillProfiles() {
  const { data: session, status } = useAuthSession();
  const { data, isLoading, error, mutate } = useSWR<{ profiles: SkillProfile[] }>(
    session ? SKILL_PROFILES_KEY : null
  );
  return {
    profiles: data?.profiles ?? [],
    loading: status === "loading" || isLoading,
    error,
    mutate,
  };
}

export async function createSkill(input: CreateSkillInput): Promise<Skill> {
  return (
    await apiRequest<{ skill: Skill }>(SKILLS_KEY, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).skill;
}

export async function updateSkill(id: string, input: UpdateSkillInput): Promise<Skill> {
  return (
    await apiRequest<{ skill: Skill }>(`${SKILLS_KEY}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  ).skill;
}

export async function updateSkillContent(
  id: string,
  revisionId: string,
  input: SkillContentInput
): Promise<Skill> {
  return (
    await apiRequest<{ skill: Skill }>(`${SKILLS_KEY}/${id}/content`, {
      method: "PUT",
      headers: { "If-Match": revisionId },
      body: JSON.stringify(input),
    })
  ).skill;
}

export async function editSkill(
  id: string,
  revisionId: string,
  input: EditSkillInput
): Promise<Skill> {
  return (
    await apiRequest<{ skill: Skill }>(`${SKILLS_KEY}/${id}`, {
      method: "PUT",
      headers: { "If-Match": revisionId },
      body: JSON.stringify(input),
    })
  ).skill;
}

export async function previewSkill(
  name: string,
  content: SkillContentInput
): Promise<SkillContentPreview> {
  return apiRequest<SkillContentPreview>(`${SKILLS_KEY}/preview`, {
    method: "POST",
    body: JSON.stringify({ name, content }),
  });
}

export async function deleteSkill(id: string): Promise<void> {
  await apiRequest(`${SKILLS_KEY}/${id}`, { method: "DELETE" });
}

export async function createSkillProfile(input: {
  name: string;
  skillIds: string[];
}): Promise<SkillProfile> {
  return (
    await apiRequest<{ profile: SkillProfile }>(SKILL_PROFILES_KEY, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).profile;
}

export async function updateSkillProfile(
  id: string,
  input: { name?: string; skillIds?: string[] }
): Promise<SkillProfile> {
  return (
    await apiRequest<{ profile: SkillProfile }>(`${SKILL_PROFILES_KEY}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  ).profile;
}

export async function deleteSkillProfile(id: string): Promise<void> {
  await apiRequest(`${SKILL_PROFILES_KEY}/${id}`, { method: "DELETE" });
}

export async function resolveSkillPreview(
  input: SkillResolutionPreviewInput,
  signal?: AbortSignal
): Promise<SkillResolutionPreviewResponse> {
  return apiRequest(`${SKILLS_KEY}/resolve-preview`, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}
