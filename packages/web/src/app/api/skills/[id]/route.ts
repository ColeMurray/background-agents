import { managedSkillsProxy } from "@/lib/managed-skills-proxy";

export const { GET, PATCH, PUT, DELETE } = managedSkillsProxy<{ id: string }>(
  ({ id }) => `/skills/${encodeURIComponent(id)}`,
  "manage skill",
  ["GET", "PATCH", "PUT", "DELETE"]
);
