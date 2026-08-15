import { managedSkillsProxy } from "@/lib/managed-skills-proxy";

export const { POST } = managedSkillsProxy<Record<string, never>>(
  () => "/skills/resolve-preview",
  "preview skill resolution",
  ["POST"]
);
