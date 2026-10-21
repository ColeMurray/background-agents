import { describe, expect, it } from "vitest";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createManagedSkillsExtension } from "../../src/pi/managed-skills-extension";
import { skillSourceFromInstallation } from "../../src/pi/skill-source";

/**
 * The Agents SDK's pi harness publishes the skills tools. Open-Inspect
 * installs that extension over its own pinned sources, and used to adapt the
 * tool result from the SDK's legacy `content` field to Pi Durable's `output`
 * field. This test runs against the installed SDK, not a mock, so a future SDK
 * bump that changes the published tool names or the result field fails here
 * rather than at the model.
 */

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

const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" };
const api = { taskId: 1 } as ToolExecutionApi;

describe("the installed Agents SDK's pi skills extension", () => {
  it("publishes the same tool names Open-Inspect's registry expects", async () => {
    const extension = await createManagedSkillsExtension([source]);

    expect(extension.name).toBe("open-inspect.skills");
    expect(extension.tools?.map((tool) => tool.name)).toEqual([
      "activate_skill",
      "read_skill_resource",
    ]);
  });

  it("returns tool results in Pi Durable's output contract", async () => {
    const extension = await createManagedSkillsExtension([source]);
    const activate = extension.tools?.find((tool) => tool.name === "activate_skill");
    const result = await activate?.execute({ name: "review" }, api, context);

    expect(result).toMatchObject({
      output: [
        expect.objectContaining({ type: "text", text: expect.stringContaining("Use evidence.") }),
      ],
    });
    // The legacy field is gone. Pi Durable 1.3 reads `output`; a result that
    // carried `content` again would mean the SDK and Pi Durable disagree.
    expect(result).not.toHaveProperty("content");
  });

  it("reads only declared skill resources", async () => {
    const extension = await createManagedSkillsExtension([source]);
    const read = extension.tools?.find((tool) => tool.name === "read_skill_resource");

    await expect(
      read?.execute({ name: "review", path: "references/checklist.md" }, api, context)
    ).resolves.toMatchObject({
      output: [expect.objectContaining({ text: expect.stringContaining("Check tests.") })],
    });
    // A path that leaves the skill's bundle is refused. The SDK reports the
    // refusal as a plain text result, not as an error flag.
    const refused = await read?.execute({ name: "review", path: "../secret" }, api, context);
    expect(refused).toMatchObject({
      output: [expect.objectContaining({ text: expect.stringContaining("not found") })],
    });
    expect(JSON.stringify(refused)).not.toContain("Check tests.");
  });
});
