import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const eslint = new ESLint({ cwd: repositoryRoot });

describe("shared Select convention", () => {
  it.each([
    "packages/web/src/components/settings/example.tsx",
    "packages/web/src/components/ui/example.tsx",
    "packages/web/src/components/example.test.tsx",
  ])("rejects native selects in %s", async (filePath) => {
    const [result] = await eslint.lintText("export const Example = () => <select />;", {
      filePath,
    });
    expect(result.messages).toEqual([
      expect.objectContaining({
        ruleId: "no-restricted-syntax",
        severity: 2,
        message: expect.stringContaining(
          "Select / SelectTrigger / SelectContent / SelectItem from @/components/ui/select"
        ),
      }),
    ]);
  });

  it("allows the shared Select components", async () => {
    const [result] = await eslint.lintText(
      `import { Select, SelectTrigger, SelectContent, SelectItem } from "@/components/ui/select";
       export const Example = () => (
         <Select>
           <SelectTrigger />
           <SelectContent><SelectItem value="choice">Choice</SelectItem></SelectContent>
         </Select>
       );`,
      { filePath: "packages/web/src/components/settings/example.tsx" }
    );
    expect(result.errorCount).toBe(0);
  });

  it("does not restrict native selects outside the web package", async () => {
    const [result] = await eslint.lintText("export const Example = () => <select />;", {
      filePath: "packages/docs/src/example.tsx",
    });
    expect(result.errorCount).toBe(0);
  });
});
