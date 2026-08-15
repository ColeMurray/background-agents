import { managedSkillsProxy } from "@/lib/managed-skills-proxy";

export const { GET, POST } = managedSkillsProxy<Record<string, never>>(
  () => "/skill-profiles",
  "manage skill profiles",
  ["GET", "POST"]
);
