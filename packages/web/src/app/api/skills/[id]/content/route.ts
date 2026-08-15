import { managedSkillsProxy } from "@/lib/managed-skills-proxy";

export const { PUT } = managedSkillsProxy<{ id: string }>(
  ({ id }) => `/skills/${encodeURIComponent(id)}/content`,
  "update skill content",
  ["PUT"]
);
