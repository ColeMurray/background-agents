import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSkillRevision, hashSessionSkillManifest } from "./content-addressing";
import {
  MAX_MANAGED_SKILL_MANIFEST_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_PATH_BYTES,
  MAX_SKILL_PATH_DEPTH,
  MAX_SKILL_REVISION_BYTES,
  skillContentInputSchema,
} from "@open-inspect/shared/types/skills";

describe("managed skill content addressing", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL("../../../shared/test-fixtures/managed-skills-golden.json", import.meta.url),
      "utf8"
    )
  );
  const content = skillContentInputSchema.parse(golden.content);

  it("renders canonical SKILL.md with fixed and sorted frontmatter", async () => {
    const revision = await buildSkillRevision(golden.name, content);
    expect(revision.files.find((file) => file.path === "SKILL.md")?.content).toBe(
      golden.skillMarkdown
    );
  });

  it("pins cross-runtime content limits", () => {
    expect(golden.limits).toEqual({
      maxSkillFiles: MAX_SKILL_FILES,
      maxSkillFileBytes: MAX_SKILL_FILE_BYTES,
      maxSkillRevisionBytes: MAX_SKILL_REVISION_BYTES,
      maxSkillPathBytes: MAX_SKILL_PATH_BYTES,
      maxSkillPathDepth: MAX_SKILL_PATH_DEPTH,
      maxManagedSkillManifestBytes: MAX_MANAGED_SKILL_MANIFEST_BYTES,
    });
  });

  it("produces stable revision and manifest hashes independent of input ordering", async () => {
    const first = await buildSkillRevision(golden.name, content);
    const second = await buildSkillRevision(golden.name, {
      ...content,
      metadata: { alpha: "first", zeta: "last" },
    });
    expect(first.revisionSha256).toBe(second.revisionSha256);
    expect(first.revisionSha256).toBe(golden.revisionSha256);
    expect(first.files[0].content).toBe(golden.skillMarkdown);
    expect(first.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/deploy.sh"]);

    const skill = {
      skillId: "skill_1",
      revisionId: "skillrev_1",
      name: "acme-deploy",
      revisionSha256: first.revisionSha256,
      assignmentSources: [
        { id: "assign_repo", type: "repository" as const, repoOwner: "acme", repoName: "api" },
        { id: "assign_global", type: "global" as const },
      ],
    };
    await expect(hashSessionSkillManifest({ mode: "all" }, [skill])).resolves.toBe(
      await hashSessionSkillManifest({ mode: "all" }, [
        { ...skill, assignmentSources: [...skill.assignmentSources].reverse() },
      ])
    );
    await expect(hashSessionSkillManifest({ mode: "all" }, [skill])).resolves.toBe(
      golden.manifestSha256
    );
    expect(first.files).toEqual(golden.files);
  });
});
