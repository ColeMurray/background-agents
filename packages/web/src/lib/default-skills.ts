/**
 * Static catalog of superpowers skills baked into every container.
 * Used as an immediate fallback so the slash palette works before
 * the container boots and sends skills_discovered.
 *
 * Keep in sync with SUPERPOWERS_SKILLS in
 * packages/sandbox-runtime/src/sandbox_runtime/skill_scanner.py.
 */

import type { SkillInfo } from "@open-inspect/shared";

export const DEFAULT_CONTAINER_SKILLS: SkillInfo[] = [
  {
    name: "brainstorming",
    description: "Explore intent, requirements and design before implementation",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "dispatching-parallel-agents",
    description: "Dispatch 2+ independent tasks without shared state",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "executing-plans",
    description: "Execute an implementation plan with review checkpoints",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "finishing-a-development-branch",
    description: "Guide completion — merge, PR, or cleanup",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "receiving-code-review",
    description: "Handle code review feedback with technical rigor",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "requesting-code-review",
    description: "Verify work meets requirements before merging",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "subagent-driven-development",
    description: "Execute plan tasks via independent subagents",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "systematic-debugging",
    description: "Investigate bugs and test failures before proposing fixes",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "test-driven-development",
    description: "Write tests before implementation code",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "using-git-worktrees",
    description: "Isolate feature work in git worktrees",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "verification-before-completion",
    description: "Run verification commands before claiming success",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "writing-plans",
    description: "Create implementation plans from specs or requirements",
    source: "container",
    plugin: "superpowers",
  },
  {
    name: "writing-skills",
    description: "Create or edit agent skills",
    source: "container",
    plugin: "superpowers",
  },
];

/**
 * Merge live skills from the container with the static defaults.
 * Live skills take priority (they may include repo-specific skills).
 * If no live skills, fall back to the static list.
 */
export function mergeSkills(liveSkills: SkillInfo[] | undefined): SkillInfo[] {
  if (liveSkills && liveSkills.length > 0) {
    // Live list may have repo skills the static list doesn't. Use it as-is,
    // but ensure all default container skills are present (in case the bridge
    // missed some).
    const seen = new Set(liveSkills.map((s) => s.name));
    const missing = DEFAULT_CONTAINER_SKILLS.filter((s) => !seen.has(s.name));
    return [...liveSkills, ...missing];
  }
  return DEFAULT_CONTAINER_SKILLS;
}
