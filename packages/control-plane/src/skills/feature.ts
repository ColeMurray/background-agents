import type { Env } from "../types";

export function managedSkillsEnabled(env: Pick<Env, "MANAGED_SKILLS_ENABLED">): boolean {
  return env.MANAGED_SKILLS_ENABLED !== "false";
}
