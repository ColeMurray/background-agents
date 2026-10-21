import { defineExtension } from "@earendil-works/pi-durable";
import type { SkillSource } from "agents/skills";

/**
 * Install the official Agents Pi skills extension over Open-Inspect's pinned
 * sources. Agents 0.29.0's pi harness returns tool results in Pi Durable's
 * `output` contract, so the extension is installed as the SDK defines it;
 * catalog resolution, activation, resources, and prompt rendering remain the
 * SDK implementation.
 */
export async function createManagedSkillsExtension(sources: readonly SkillSource[]) {
  const { skills } = await import("agents/harness/pi");
  const extension = await skills(sources);
  return defineExtension({
    ...extension,
    name: "open-inspect.skills",
  });
}
