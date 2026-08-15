import { managedSkillsProxy } from "@/lib/managed-skills-proxy";

export const { PATCH, DELETE } = managedSkillsProxy<{ id: string }>(
  ({ id }) => `/skill-profiles/${encodeURIComponent(id)}`,
  "manage skill profile",
  ["PATCH", "DELETE"]
);
