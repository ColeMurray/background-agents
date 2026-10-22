import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createManagedSkillsExtension } from "./managed-skills-extension";
import { skillSourceFromInstallation } from "./skill-source";

vi.mock("agents/harness/pi", () => ({
  skills: vi.fn(async () => ({
    name: "agents.skills",
    tools: [
      {
        name: "activate_skill",
        description: "Activate",
        parameters: { type: "object" },
        replay: "safe",
        execute: async () => ({
          output: [{ type: "text", text: "<skill_content>Use evidence.</skill_content>" }],
        }),
      },
      {
        name: "read_skill_resource",
        description: "Read",
        parameters: { type: "object" },
        replay: "safe",
        execute: async (input: { path?: string }) =>
          input.path === "../secret"
            ? { output: [{ type: "text", text: "not found" }], isError: true }
            : { output: [{ type: "text", text: "Check tests." }] },
      },
    ],
    sections: [],
  })),
}));

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

const context = BACKGROUND_CONTEXT;
const api = { taskId: 1 } as ToolExecutionApi;

describe("createManagedSkillsExtension", () => {
  it("activates a managed skill through Pi's output contract", async () => {
    const extension = await createManagedSkillsExtension([source]);
    expect(extension.name).toBe("open-inspect.skills");
    const activate = extension.tools?.find((tool) => tool.name === "activate_skill");
    await expect(activate?.execute({ name: "review" }, api, context)).resolves.toMatchObject({
      output: [
        expect.objectContaining({ type: "text", text: expect.stringContaining("Use evidence.") }),
      ],
    });
  });

  it("reads only declared skill resources", async () => {
    const extension = await createManagedSkillsExtension([source]);
    const { skills } = await import("agents/harness/pi");
    expect(skills).toHaveBeenCalledWith([source]);
    const read = extension.tools?.find((tool) => tool.name === "read_skill_resource");
    await expect(
      read?.execute({ name: "review", path: "references/checklist.md" }, api, context)
    ).resolves.toMatchObject({
      output: [expect.objectContaining({ text: expect.stringContaining("Check tests.") })],
    });
    await expect(
      read?.execute({ name: "review", path: "../secret" }, api, context)
    ).resolves.toMatchObject({
      isError: true,
    });
  });
});
