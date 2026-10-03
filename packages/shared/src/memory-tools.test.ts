import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildMemoryToolSpecs,
  formatMemoryToolSpecFiles,
  harnessMemoryToolName,
  MEMORY_TOOL_SPEC_FILES,
} from "./memory-tools";

const root = new URL("../../../", import.meta.url);

describe("memory tool specs", () => {
  it.each(Object.entries(MEMORY_TOOL_SPEC_FILES))(
    "keeps the generated %s artifact in sync (run `npm run generate:memory-tools -w @open-inspect/shared`)",
    (kind, path) => {
      const expected = formatMemoryToolSpecFiles()[kind as keyof typeof MEMORY_TOOL_SPEC_FILES];
      const file = new URL(path, root);
      if (process.env.UPDATE_MEMORY_TOOL_SPECS === "1") writeFileSync(file, expected);
      expect(readFileSync(file, "utf8")).toBe(expected);
    }
  );

  it("exposes server bounds and strictness to the model", () => {
    const search = buildMemoryToolSpecs().tools.find((tool) => tool.name === "memory_search")!;
    expect(search.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { limit: { minimum: 1, maximum: 20 }, query: { maxLength: 256 } },
    });
    const write = buildMemoryToolSpecs().tools.find((tool) => tool.name === "memory_write")!;
    expect(Object.keys(write.inputSchema.properties as object)).not.toContain("environmentId");
  });

  it("names tools as each harness exposes them", () => {
    expect(harnessMemoryToolName("opencode", "memory_read")).toBe("memory_read");
    expect(harnessMemoryToolName("claude", "memory_read")).toBe("mcp__oi__memory_read");
  });
});
