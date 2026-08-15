import { managedSkillsProxy } from "@/lib/managed-skills-proxy";

export const { GET } = managedSkillsProxy<{ id: string }>(
  ({ id }) => `/sessions/${encodeURIComponent(id)}/skills`,
  "fetch session skills",
  ["GET"]
);
