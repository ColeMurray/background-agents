import { describe, expect, it } from "vitest";
import { skillSourceFromInstallation } from "./skill-source";

describe("skillSourceFromInstallation", () => {
  it("adapts the immutable Open-Inspect skill snapshot to an Agents skill source", async () => {
    const source = skillSourceFromInstallation({
      schemaVersion: 1,
      manifestSha256: "a".repeat(64),
      nextCursor: null,
      skills: [
        {
          name: "review",
          files: [
            {
              path: "SKILL.md",
              content: "---\nname: review\ndescription: Review code\n---\nUse evidence.",
              sha256: "b".repeat(64),
              sizeBytes: 75,
              executable: false,
            },
            {
              path: "references/checklist.md",
              content: "Check tests.",
              sha256: "c".repeat(64),
              sizeBytes: 12,
              executable: false,
            },
          ],
        },
      ],
    });

    await expect(source.list()).resolves.toEqual([
      expect.objectContaining({ name: "review", description: "Review code" }),
    ]);
    await expect(source.load("review")).resolves.toEqual(
      expect.objectContaining({
        name: "review",
        body: "Use evidence.",
        resources: [expect.objectContaining({ path: "references/checklist.md" })],
      })
    );
  });

  it("fails closed when a pinned skill has invalid SKILL.md metadata", () => {
    expect(() =>
      skillSourceFromInstallation({
        schemaVersion: 1,
        manifestSha256: "a".repeat(64),
        nextCursor: null,
        skills: [
          {
            name: "broken",
            files: [
              {
                path: "SKILL.md",
                content: "not a skill",
                sha256: "b".repeat(64),
                sizeBytes: 11,
                executable: false,
              },
            ],
          },
        ],
      })
    ).toThrow("Invalid managed skill snapshot");
  });

  it("preserves descriptors and normalizes invocation metadata for catalog filtering", async () => {
    const source = skillSourceFromInstallation({
      schemaVersion: 1,
      manifestSha256: "a".repeat(64),
      nextCursor: null,
      skills: [
        {
          name: "manual-only",
          files: [
            {
              path: "SKILL.md",
              content:
                "---\nname: manual-only\ndescription: Manual only\ncompatibility: pi\nmetadata:\n  disable-model-invocation: true\n  owner: platform\n---\nUse explicitly.",
              sha256: "b".repeat(64),
              sizeBytes: 150,
              executable: false,
            },
          ],
        },
      ],
    });

    await expect(source.list()).resolves.toEqual([
      expect.objectContaining({
        name: "manual-only",
        compatibility: "pi",
        metadata: {
          "disable-model-invocation": true,
          owner: "platform",
        },
      }),
    ]);
  });
});
