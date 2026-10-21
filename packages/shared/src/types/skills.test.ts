import { describe, expect, it } from "vitest";
import {
  bulkImportSkillsInputSchema,
  bulkImportSkillsResponseSchema,
  bulkSkillImportPreviewResponseSchema,
  createSkillInputSchema,
  importSkillInputSchema,
  listSkillsResponseSchema,
  MAX_BULK_SKILL_IMPORT_BYTES,
  MAX_BULK_SKILL_IMPORT_ASSIGNMENTS,
  MAX_BULK_SKILL_IMPORT_FILES,
  MAX_BULK_SKILL_IMPORT_SKILLS,
  sessionSkillSelectionSchema,
  skillContentInputSchema,
  skillImportSourceSchema,
  skillNameSchema,
  skillResolutionPreviewInputSchema,
  skillSummarySchema,
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

  it("defaults missing import provenance for rolling response compatibility", () => {
    const summary = skillSummarySchema.parse({
      id: "skill-1",
      name: "acme-review",
      description: "Review code",
      enabled: true,
      currentRevisionId: "revision-1",
      revisionNumber: 1,
      revisionSha256: "a".repeat(64),
      revisionCreatedBy: "user-1",
      creatorDisplayName: null,
      lastEditorDisplayName: null,
      revisionAuthorDisplayName: null,
      assignments: [],
      createdBy: "user-1",
      updatedBy: "user-1",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(summary.source).toBeNull();
  });

  it("requires confirmation of the complete previewed revision", () => {
    const input = {
      source: { repository: { repoOwner: "acme", repoName: "skills" } },
      expectedCommitSha: "a".repeat(40),
      expectedSourceSha256: "b".repeat(64),
    };

    expect(importSkillInputSchema.safeParse(input).success).toBe(false);
    expect(
      importSkillInputSchema.safeParse({ ...input, expectedRevisionSha256: "c".repeat(64) }).success
    ).toBe(true);
  });

  it("validates persisted import provenance invariants", () => {
    const source = {
      provider: "github",
      repoOwner: "acme",
      repoName: "skills",
      requestedRef: "main",
      resolvedRef: "main",
      commitSha: "a".repeat(40),
      subdirectory: "skills/deploy",
      sourceSha256: "b".repeat(64),
    };

    expect(skillImportSourceSchema.safeParse(source).success).toBe(true);
    expect(skillImportSourceSchema.safeParse({ ...source, provider: "unknown" }).success).toBe(
      false
    );
    expect(skillImportSourceSchema.safeParse({ ...source, commitSha: "not-a-sha" }).success).toBe(
      false
    );
    expect(
      skillImportSourceSchema.safeParse({ ...source, subdirectory: "../deploy" }).success
    ).toBe(false);
  });

  it("bounds and pins bulk repository imports", () => {
    expect(MAX_BULK_SKILL_IMPORT_SKILLS).toBeGreaterThanOrEqual(100);
    expect(MAX_BULK_SKILL_IMPORT_FILES).toBeGreaterThanOrEqual(500);
    expect(MAX_BULK_SKILL_IMPORT_BYTES).toBeGreaterThanOrEqual(8 * 1024 * 1024);

    const confirmation = {
      source: { repository: { repoOwner: "acme", repoName: "skills" }, subdirectory: "skills" },
      expectedCommitSha: "a".repeat(40),
      skills: [
        {
          subdirectory: "skills/deploy",
          name: "deploy",
          expectedSourceSha256: "b".repeat(64),
          expectedRevisionSha256: "c".repeat(64),
        },
      ],
    };

    expect(bulkImportSkillsInputSchema.parse(confirmation).assignments).toEqual([]);
    expect(
      bulkImportSkillsInputSchema.safeParse({
        ...confirmation,
        skills: [...confirmation.skills, confirmation.skills[0]],
      }).success
    ).toBe(false);
    expect(
      bulkImportSkillsInputSchema.safeParse({
        ...confirmation,
        skills: Array.from({ length: MAX_BULK_SKILL_IMPORT_SKILLS + 1 }, (_, index) => ({
          ...confirmation.skills[0],
          subdirectory: `skills/skill-${index}`,
          name: `skill-${index}`,
        })),
      }).success
    ).toBe(false);
    expect(
      bulkImportSkillsInputSchema.safeParse({
        ...confirmation,
        assignments: Array.from({ length: MAX_BULK_SKILL_IMPORT_ASSIGNMENTS + 1 }, (_, index) => ({
          type: "environment" as const,
          environmentId: `env-${index}`,
        })),
      }).success
    ).toBe(false);
  });

  it("rejects bulk previews whose aggregate counts exceed the contract", () => {
    const preview = {
      name: "deploy",
      source: {
        provider: "github",
        repoOwner: "acme",
        repoName: "skills",
        requestedRef: null,
        resolvedRef: "main",
        commitSha: "a".repeat(40),
        subdirectory: "skills/deploy",
        sourceSha256: "b".repeat(64),
      },
      description: "Deploy",
      body: "body",
      license: null,
      compatibility: null,
      metadata: {},
      revisionSha256: "c".repeat(64),
      totalBytes: 10,
      files: [{ path: "SKILL.md", content: "content", sizeBytes: 7, executable: false }],
      warnings: [],
      nameAvailable: true,
    };
    expect(
      bulkSkillImportPreviewResponseSchema.safeParse({
        skills: [],
        totalFiles: 0,
        totalBytes: 0,
      }).success
    ).toBe(false);
    expect(
      bulkSkillImportPreviewResponseSchema.safeParse({
        skills: [preview],
        totalFiles: MAX_BULK_SKILL_IMPORT_FILES + 1,
        totalBytes: 0,
      }).success
    ).toBe(false);
  });

  it("strictly validates compact bulk import identities", () => {
    const response = {
      skills: [{ id: "skill-1", name: "deploy", currentRevisionId: "revision-1" }],
    };

    expect(bulkImportSkillsResponseSchema.parse(response)).toEqual(response);
    expect(
      bulkImportSkillsResponseSchema.safeParse({
        skills: [{ ...response.skills[0], assignments: [] }],
      }).success
    ).toBe(false);
  });
});
