import { managedSkillsProxy } from "@/lib/managed-skills-proxy";

export const { GET, POST } = managedSkillsProxy<Record<string, never>>(
  () => "/skills",
  "manage skills",
  ["GET", "POST"]
);
