import type { SandboxSkillInstallation } from "@open-inspect/shared/types/skills";
import type { SkillContent, SkillResource, SkillSource } from "agents/skills";
import { parseSkillMarkdown } from "../skills/skill-markdown";

/** Adapt a session's immutable managed-skill snapshot to the Agents skill catalog used by Pi. */
export function skillSourceFromInstallation(installation: SandboxSkillInstallation): SkillSource {
  const skills = new Map<string, SkillContent>();
  const resourcesBySkill = new Map<string, SkillResource[]>();
  for (const skill of installation.skills) {
    const markdown = skill.files.find((file) => file.path === "SKILL.md");
    if (!markdown) throw new Error(`Invalid managed skill snapshot: ${skill.name}`);
    let parsed: ReturnType<typeof parseSkillMarkdown>;
    try {
      parsed = parseSkillMarkdown(markdown.content);
    } catch {
      throw new Error(`Invalid managed skill snapshot: ${skill.name}`);
    }
    const name = scalar(parsed.frontmatter, "name");
    const description = scalar(parsed.frontmatter, "description");
    if (name !== skill.name || !description) {
      throw new Error(`Invalid managed skill snapshot: ${skill.name}`);
    }
    const resources = skill.files
      .filter((file) => file.path !== "SKILL.md")
      .map<SkillResource>((file) => ({
        path: file.path,
        content: file.content,
        size: file.sizeBytes,
        encoding: "text",
        kind: resourceKind(file.path),
      }));
    const compatibility = scalar(parsed.frontmatter, "compatibility");
    const license = scalar(parsed.frontmatter, "license");
    const allowedTools = scalar(parsed.frontmatter, "allowed-tools");
    const metadata = skillMetadata(parsed.frontmatter);
    resourcesBySkill.set(skill.name, resources);
    skills.set(skill.name, {
      name,
      description,
      body: parsed.body,
      rawContent: markdown.content,
      ...(compatibility ? { compatibility } : {}),
      ...(license ? { license } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(metadata ? { metadata } : {}),
      resources: resources.map(({ content: _content, ...descriptor }) => descriptor),
    });
  }
  return {
    id: "open-inspect.session-skills",
    fingerprint: installation.manifestSha256,
    list: async () =>
      [...skills.values()].map(
        ({ body: _body, rawContent: _raw, resources: _resources, ...item }) => item
      ),
    load: async (name) => skills.get(name) ?? null,
    readResource: async (name, path) => {
      const resource = resourcesBySkill.get(name)?.find((candidate) => candidate.path === path);
      return resource ? { ...resource } : null;
    },
  };
}

function scalar(frontmatter: ReturnType<typeof parseSkillMarkdown>["frontmatter"], key: string) {
  const value = frontmatter.get(key);
  return value?.kind === "scalar" ? value.value.trim() : undefined;
}

function stringMap(frontmatter: ReturnType<typeof parseSkillMarkdown>["frontmatter"], key: string) {
  const value = frontmatter.get(key);
  return value?.kind === "map" ? value.value : undefined;
}

function skillMetadata(
  frontmatter: ReturnType<typeof parseSkillMarkdown>["frontmatter"]
): Record<string, unknown> | undefined {
  const metadata = stringMap(frontmatter, "metadata");
  if (!metadata) return undefined;
  const normalized: Record<string, unknown> = { ...metadata };
  const invocation = metadata["disable-model-invocation"]?.trim().toLowerCase();
  if (invocation === "true") normalized["disable-model-invocation"] = true;
  if (invocation === "false") normalized["disable-model-invocation"] = false;
  return normalized;
}

function resourceKind(path: string): "reference" | "script" | "asset" | "file" {
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("assets/")) return "asset";
  return "file";
}
