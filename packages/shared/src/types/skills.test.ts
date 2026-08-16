import { describe, expect, it } from "vitest";
import {
  createSkillInputSchema,
  listSkillsResponseSchema,
  sessionSkillSelectionSchema,
  skillContentInputSchema,
  skillNameSchema,
  skillResolutionPreviewInputSchema,
} from "./skills";
import { MAX_TARGET_REPOSITORIES } from "./repositories";

describe("managed skill contracts", () => {
  it("accepts portable names and rejects ambiguous names", () => {
    expect(skillNameSchema.safeParse("acme-code-review").success).toBe(true);
    expect(skillNameSchema.safeParse("Acme Review").success).toBe(false);
    expect(skillNameSchema.safeParse("acme--review").success).toBe(false);
  });

  it("rejects traversal, duplicate files, and executable reference files", () => {
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [{ path: "../secret", content: "x" }],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [{ path: "SKILL.md/hidden", content: "x" }],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [
          { path: "references/checklist.md", content: "one" },
          { path: "references/checklist.md", content: "two" },
        ],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [{ path: "references/checklist.md", content: "x", executable: true }],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "Follow the review checklist.",
        files: [
          { path: "scripts", content: "not a directory" },
          { path: "scripts/run.sh", content: "#!/bin/sh" },
        ],
      }).success
    ).toBe(false);
    expect(
      skillContentInputSchema.safeParse({
        description: "Review code",
        body: "invalid \ud800 Unicode",
      }).success
    ).toBe(false);
  });

  it("normalizes omitted content collections and all-session selection", () => {
    const skill = createSkillInputSchema.parse({
      name: "acme-review",
      content: { description: "Review code", body: "Review it." },
    });
    expect(skill.assignments).toEqual([]);
    expect(skill.content.files).toEqual([]);
    expect(skill.content.metadata).toEqual({});
    expect(sessionSkillSelectionSchema.parse({ mode: "all" })).toEqual({ mode: "all" });
  });

  it("bounds repository resolution previews to the session repository contract", () => {
    const repositories = Array.from({ length: MAX_TARGET_REPOSITORIES + 1 }, (_, index) => ({
      repoOwner: "acme",
      repoName: `repo-${index}`,
    }));
    expect(skillResolutionPreviewInputSchema.safeParse({ repositories }).success).toBe(false);
  });

  it("requires a cursor exactly when another skill catalog page exists", () => {
    expect(
      listSkillsResponseSchema.safeParse({ skills: [], hasMore: false, nextCursor: null }).success
    ).toBe(true);
    expect(
      listSkillsResponseSchema.safeParse({ skills: [], hasMore: true, nextCursor: "next-skill" })
        .success
    ).toBe(true);
    expect(
      listSkillsResponseSchema.safeParse({ skills: [], hasMore: true, nextCursor: null }).success
    ).toBe(false);
  });
});
