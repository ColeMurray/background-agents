import useSWR from "swr";
import { z } from "zod";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import {
  listSkillProfilesResponseSchema,
  listSkillsResponseSchema,
  skillProfileResponseSchema,
  skillResolutionPreviewResponseSchema,
  skillResponseSchema,
} from "@open-inspect/shared/types/skills";
import type {
  CreateSkillInput,
  ReplaceSkillContentAndAssignmentsInput,
  SetSkillEnabledInput,
  Skill,
  SkillContentInput,
  SkillProfile,
} from "@open-inspect/shared/types/skills";
import type { skillResolutionPreviewInputSchema } from "@open-inspect/shared/types/skills";

export type SkillResolutionPreviewInput = z.infer<typeof skillResolutionPreviewInputSchema>;

type SkillResolutionPreviewResponse = z.infer<typeof skillResolutionPreviewResponseSchema>;

const skillContentPreviewSchema = z.strictObject({
  skillMarkdown: z.string(),
  revisionSha256: z.string(),
  totalBytes: z.number().int().nonnegative(),
});
type SkillContentPreview = z.infer<typeof skillContentPreviewSchema>;

const okResponseSchema = z.strictObject({ ok: z.literal(true) });
const errorResponseSchema = z.object({ error: z.string() });

const SKILLS_KEY = "/api/skills";
const SKILL_PROFILES_KEY = "/api/skill-profiles";

async function validatedFetcher<T>(path: BrowserApiPath, schema: z.ZodType<T>): Promise<T> {
  const response = await browserApiFetch(path);
  if (!response.ok) throw new Error("Managed skills request failed");
  return schema.parse(await response.json());
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
    throw new Error(parsedError.success ? parsedError.data.error : "Managed skills request failed");
  }
  return schema.parse(data);
}

export function useSkills() {
  const { data: session, status } = useAuthSession();
  const { data, isLoading, error, mutate } = useSWR(session ? SKILLS_KEY : null, (path) =>
    validatedFetcher(path, listSkillsResponseSchema)
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
  const { data, isLoading, error, mutate } = useSWR(
    session && id ? (`${SKILLS_KEY}/${id}` as const) : null,
    (path) => validatedFetcher(path, skillResponseSchema)
  );
  return { skill: data?.skill, loading: isLoading, error, mutate };
}

export function useSkillProfiles() {
  const { data: session, status } = useAuthSession();
  const { data, isLoading, error, mutate } = useSWR(session ? SKILL_PROFILES_KEY : null, (path) =>
    validatedFetcher(path, listSkillProfilesResponseSchema)
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
    await apiRequest(SKILLS_KEY, skillResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).skill;
}

export async function setSkillEnabled(id: string, input: SetSkillEnabledInput): Promise<Skill> {
  return (
    await apiRequest(`${SKILLS_KEY}/${id}`, skillResponseSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  ).skill;
}

export async function replaceSkillContentAndAssignments(
  id: string,
  revisionId: string,
  input: ReplaceSkillContentAndAssignmentsInput
): Promise<Skill> {
  return (
    await apiRequest(`${SKILLS_KEY}/${id}`, skillResponseSchema, {
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
  return apiRequest(`${SKILLS_KEY}/preview`, skillContentPreviewSchema, {
    method: "POST",
    body: JSON.stringify({ name, content }),
  });
}

export async function deleteSkill(id: string): Promise<void> {
  await apiRequest(`${SKILLS_KEY}/${id}`, okResponseSchema, { method: "DELETE" });
}

export async function createSkillProfile(input: {
  name: string;
  skillIds: string[];
}): Promise<SkillProfile> {
  return (
    await apiRequest(SKILL_PROFILES_KEY, skillProfileResponseSchema, {
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
    await apiRequest(`${SKILL_PROFILES_KEY}/${id}`, skillProfileResponseSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  ).profile;
}

export async function deleteSkillProfile(id: string): Promise<void> {
  await apiRequest(`${SKILL_PROFILES_KEY}/${id}`, okResponseSchema, { method: "DELETE" });
}

export async function resolveSkillPreview(
  input: SkillResolutionPreviewInput,
  signal?: AbortSignal
): Promise<SkillResolutionPreviewResponse> {
  return apiRequest(`${SKILLS_KEY}/resolve-preview`, skillResolutionPreviewResponseSchema, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}
